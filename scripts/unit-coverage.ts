// Coverage gap unit tests: 补四个审查发现的测试盲区——
// 1. kanban/summary collectWorkSummary 采集层（日期过滤 / attempt 挑选 / diff 统计合并）
// 2. handler hta_review 按钮全链路（分发 → handleAiReview → runAiReview，PATH 桩伪造 ocr）
// 3. cli askWithAbort 三路竞态（正常回答 / Ctrl+C abort / 超时自动拒绝；createAskWithAbort 已抽出可测）
//    + abort/超时收尾取消挂起 waiter（fake reader 注入 waiter 语义，验证中断后输入不被吞）
// 4. config-wizard 非交互部分（resolveAllowedOpenIds 白名单合并决策）+ writeEnvFile 往返 + llm-verify / feishu-verify 失败路径
// 5. cli 启动窗口信号处理（信号注册前移到 ensureKanbanOrExit 之前：探测在途时 SIGTERM/SIGINT 优雅退出）
// 仅用 loopback mock 服务与 PATH 桩，离线可跑。Run: npx tsx scripts/unit-coverage.ts

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import dotenv from 'dotenv';
import { collectWorkSummary } from '../src/kanban/summary';
import { createBotHandlers } from '../src/bot/handler';
import type { FeishuChannel } from '../src/channels/feishu';
import { SessionRouter } from '../src/agent/session-router';
import { ConfirmationManager } from '../src/agent/confirm';
import { MemoryStore } from '../src/agent/memory';
import { McpSupervisor } from '../src/bot/supervisor';
import { currentConfig, ensureEnvLoaded, loadEnvFiles, writeEnvFile } from '../src/config/config';
import { resolveAllowedOpenIds } from '../src/config/config-wizard';
import { ASK_TIMEOUT, createAskWithAbort } from '../src/cli';
import { verifyLlmConfig } from '../src/config/llm-verify';
import { verifyFeishuApp } from '../src/config/feishu-verify';
import type { AgentConfig } from '../src/types';
import type { KanbanMcp } from '../src/kanban/mcp';
import { check, checkAsync, finish } from './testkit';

/** 轮询等待条件成立（按钮回调的审查流程全异步），超时抛错。 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

// --- fake channel：hta_review 链路只发 notifyOpenId / notifyCardOpenId ---

class FakeChannel {
  notifies: { openId: string; text: string }[] = [];
  cards: { openId: string; card: Record<string, unknown> }[] = [];
  async notifyOpenId(openId: string, text: string): Promise<void> {
    this.notifies.push({ openId, text });
  }
  async notifyCardOpenId(openId: string, card: Record<string, unknown>): Promise<void> {
    this.cards.push({ openId, card });
  }
}

// --- fake line reader：对齐 cli createLineReader 的 waiter/队列语义（line 优先喂挂起的 waiter，
// 无 waiter 则入队），供 askWithAbort「中断/超时收尾取消挂起 waiter」的回归测试注入 ---
function createFakeLineReader(): {
  feed: (line: string) => void;
  ask: () => Promise<string | null>;
  cancelPending: () => void;
} {
  const queue: string[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  return {
    feed(line) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(line);
      } else {
        queue.push(line);
      }
    },
    ask: () =>
      new Promise<string | null>((resolve) => {
        if (queue.length) return resolve(queue.shift()!);
        waiter = resolve;
      }),
    cancelPending: () => {
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(null);
      }
    },
  };
}

/** 带超时的等待：waiter 若未被取消，下一次 ask 永远等不到行 → 以明确报错收尾而非挂死测试。 */
async function askOrTimeout(ask: () => Promise<string | null>, timeoutMs = 2000): Promise<string | null> {
  return Promise.race([
    ask(),
    new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('输入被陈旧 waiter 吞掉')), timeoutMs)),
  ]);
}

async function main(): Promise<void> {
  // config.ts 已无 import 副作用：显式初始化一次（幂等标记钉住，防 currentConfig 懒初始化中途触发）
  ensureEnvLoaded();
  // 保活（同 unit.ts）：askWithAbort 超时用例靠 unref 定时器 resolve，等待中的 promise
  // 本身不占用事件循环——无 ref'd handle 时进程会提前退出，后续用例被静默跳过（exit 0 假绿）
  const keepAlive = setInterval(() => undefined, 60_000);
  try {
    await run();
  } finally {
    clearInterval(keepAlive);
  }
}

async function run(): Promise<void> {
  // ================= 盲区 1：collectWorkSummary 采集层 =================

  // 迭代过滤 + attempt 排序/挑选 + keyed-object 形态的 diff 统计合并
  await checkAsync('工作摘要：迭代过滤、最新未归档 attempt 挑选、diff 统计合并与汇总', async () => {
    const now = new Date();
    const hourAgo = new Date(Date.now() - 3600_000);
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url === '/api/projects') return json([{ id: 'p1', name: 'Alpha' }]);
      // keyed-object 形态：id → 统计行（含 changed_files 混合写法与无效条目）
      if (url === '/api/task-attempts/summary' && req.method === 'POST') {
        return json({
          'att-2': {
            files_changed: 3,
            additions: 10,
            deletions: 4,
            changed_files: ['a.ts', { path: 'b.ts' }, { name: 'c.ts' }, {}],
          },
        });
      }
      if (url.startsWith('/api/tasks?')) {
        return json([
          // 乱序 + iteration 为 number（String 归一后应匹配 '260717'）
          { id: 't2', title: '任务二', status: 'inprogress', iteration: '260717', updated_at: hourAgo.toISOString() },
          { id: 't1', title: '任务一', status: 'done', iteration: 260717, updated_at: now.toISOString() },
          { id: 't3', title: '任务三', status: 'todo', iteration: '260700', updated_at: now.toISOString() },
        ]);
      }
      if (url === '/api/tasks/t1') return json({ last_attempt_summary: '修复了登录问题' });
      if (url === '/api/tasks/t2') return json({});
      if (url === '/api/task-attempts?task_id=t1') {
        return json([
          { id: 'att-3', archived: true, created_at: '2026-01-03' }, // 更新的归档行应被丢弃
          { id: 'att-2', created_at: '2026-01-02' },
          { id: 'att-1', created_at: '2026-01-01' },
        ]);
      }
      if (url === '/api/task-attempts?task_id=t2') return json([{ id: 'att-9', created_at: '2026-01-01' }]);
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const data = await collectWorkSummary({ kanbanUrl: base, scope: 'iteration', iteration: '260717' });
      // 迭代过滤：t3（260700）出局；按 updated_at 倒序 t1 在前
      assert.deepEqual(data.tasks.map((t) => t.id), ['t1', 't2']);
      assert.equal(data.sinceLabel, '迭代 260717');
      assert.equal(data.iteration, '260717');
      const t1 = data.tasks[0]!;
      assert.equal(t1.title, '任务一');
      assert.equal(t1.projectName, 'Alpha');
      assert.equal(t1.attemptSummary, '修复了登录问题');
      // 最新未归档 attempt 是 att-2（att-3 已归档被丢弃），diffUrl 指向它
      assert.equal(t1.diffUrl, `${base}/local-projects/p1/tasks/t1/attempts/att-2?view=diffs`);
      // att-2 在统计表里 → 合并 diff 统计；changed_files 混合写法归一为路径数组
      assert.equal(t1.filesChanged, 3);
      assert.equal(t1.additions, 10);
      assert.equal(t1.deletions, 4);
      assert.deepEqual(t1.changedFiles, ['a.ts', 'b.ts', 'c.ts']);
      // t2 的 att-9 不在统计表 → 无统计，diffUrl 仍指向最新 attempt
      const t2 = data.tasks[1]!;
      assert.equal(t2.filesChanged, undefined);
      assert.equal(t2.diffUrl, `${base}/local-projects/p1/tasks/t2/attempts/att-9?view=diffs`);
      assert.deepEqual(data.totals, {
        done: 1,
        inreview: 0,
        inprogress: 1,
        todo: 0,
        cancelled: 0,
        filesChanged: 3,
        additions: 10,
        deletions: 4,
      });
    } finally {
      await stopServer(server);
    }
  });

  // 今天过滤 + 数组形态统计（字段变体：files/added_lines/deleted_lines，字符串数字归一）
  await checkAsync('工作摘要：today 按本地日期过滤，数组形态统计宽松归一', async () => {
    const now = new Date();
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000);
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url === '/api/projects') return json([{ id: 'p1', name: 'Alpha' }]);
      if (url === '/api/task-attempts/summary' && req.method === 'POST') {
        return json([{ workspace_id: 'att-2', files: [{ name: 'x.ts' }], added_lines: '5', deleted_lines: 2 }]);
      }
      if (url.startsWith('/api/tasks?')) {
        return json([
          { id: 't-today', title: '今天的任务', status: 'done', updated_at: now.toISOString() },
          { id: 't-old', title: '两天前的任务', status: 'done', updated_at: twoDaysAgo.toISOString() },
        ]);
      }
      if (url === '/api/tasks/t-today') return json({ last_attempt_summary: '' });
      if (url === '/api/task-attempts?task_id=t-today') return json([{ id: 'att-2', created_at: '2026-01-01' }]);
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const data = await collectWorkSummary({ kanbanUrl: base, scope: 'today' });
      // 两天前的任务被 today 过滤出局
      assert.deepEqual(data.tasks.map((t) => t.id), ['t-today']);
      assert.ok(data.sinceLabel.endsWith('今天'), `sinceLabel 实际：${data.sinceLabel}`);
      const t = data.tasks[0]!;
      // 无 files_changed 字段时回退 files 列表长度；字符串数字归一为 number
      assert.equal(t.filesChanged, 1);
      assert.equal(t.additions, 5);
      assert.equal(t.deletions, 2);
      assert.deepEqual(t.changedFiles, ['x.ts']);
      assert.equal(t.attemptSummary, undefined); // 空摘要不注入
      assert.equal(data.totals.filesChanged, 1);
      assert.equal(data.totals.done, 1);
    } finally {
      await stopServer(server);
    }
  });

  // 容错：diff 统计端点 / 单项目任务列表 / 单任务详情失败均不阻断报告
  await checkAsync('工作摘要：统计端点与单项目失败不阻断，attempts 为空回退任务页链接', async () => {
    const now = new Date();
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url === '/api/projects') return json([{ id: 'p-bad', name: '坏项目' }, { id: 'p2', name: 'Beta' }]);
      if (url === '/api/task-attempts/summary' && req.method === 'POST') {
        res.writeHead(500); // 统计端点可选：失败不阻断
        return res.end('{}');
      }
      if (url === '/api/tasks?project_id=p-bad') {
        res.writeHead(500); // 单项目失败：跳过，不影响 p2
        return res.end('{}');
      }
      if (url === '/api/tasks?project_id=p2') {
        return json([{ id: 't9', title: '任务九', status: 'done', updated_at: now.toISOString() }]);
      }
      if (url === '/api/tasks/t9') {
        res.writeHead(500); // 详情失败：无摘要但不阻断
        return res.end('{}');
      }
      if (url === '/api/task-attempts?task_id=t9') return json([]); // 无 attempts：回退任务页链接
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const data = await collectWorkSummary({ kanbanUrl: base, scope: 'all' });
      assert.deepEqual(data.tasks.map((t) => t.id), ['t9']);
      const t9 = data.tasks[0]!;
      assert.equal(t9.projectName, 'Beta');
      assert.equal(t9.diffUrl, `${base}/local-projects/p2/tasks/t9`); // 回退任务页
      assert.equal(t9.filesChanged, undefined);
      assert.equal(t9.attemptSummary, undefined);
      assert.equal(data.totals.done, 1);
      assert.equal(data.sinceLabel, '全部任务');
    } finally {
      await stopServer(server);
    }
  });

  // ================= 盲区 2：hta_review 按钮全链路 =================

  await checkAsync('hta_review：按钮 → runAiReview 端到端，结果推送 + 会话注入 + 按 attempt 去重', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-cov-review-'));
    const repoDir = path.join(tmp, 'repo');
    const binDir = path.join(tmp, 'bin');
    const ocrLog = path.join(tmp, 'ocr.log');
    fs.mkdirSync(binDir, { recursive: true });
    const prevPath = process.env.PATH;
    try {
      // 真 git 仓库：resolveReviewTarget 用 `git rev-parse` 判定候选目录（离线）
      execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
      // PATH 桩伪造 ocr：version 探测 + review 输出固定结果（sleep 留出连点去重窗口）
      const stub = [
        '#!/bin/sh',
        'if [ "$1" = "version" ]; then echo "ocr-stub 1.0.0"; exit 0; fi',
        'if [ "$1" = "review" ]; then',
        `  echo "$@" >> '${ocrLog}'`,
        '  sleep 0.2',
        '  echo "AI-REVIEW-STUB-RESULT"',
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(binDir, 'ocr'), stub, { mode: 0o755 });
      process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;

      // mock 看板：attempt 详情 + repos（path 直指上面的真仓库）
      const kanban = http.createServer((req, res) => {
        const url = req.url || '';
        const json = (data: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: true, data }));
        };
        if (url === '/api/task-attempts/att-1') {
          return json({ container_ref: null, branch: 'feature-x', agent_working_dir: null, task_id: 'task-1' });
        }
        if (url === '/api/task-attempts/att-1/repos') {
          return json([{ path: repoDir, name: 'repo', target_branch: 'main' }]);
        }
        if (url === '/api/tasks/task-1') {
          return json({ title: '审查任务标题', description: '实现登录限流：连续失败 5 次锁定 10 分钟' });
        }
        res.writeHead(404);
        res.end('{}');
      });
      await new Promise<void>((r) => kanban.listen(0, '127.0.0.1', r));
      const kbUrl = `http://127.0.0.1:${(kanban.address() as AddressInfo).port}`;
      try {
        const cfg: AgentConfig = {
          llmBaseUrl: 'http://127.0.0.1:1/v1',
          llmApiKey: 'sk-x',
          llmModel: 'm',
          mcpCommand: 'npx',
          mcpArgs: [],
          kanbanUrl: kbUrl,
          kanbanProjectId: '',
          kanbanRepoId: '',
          kanbanIteration: '',
        };
        const router = new SessionRouter(cfg, null, false, new MemoryStore(tmp));
        const confirmations = new ConfirmationManager(async () => undefined, { timeoutMs: 1000 });
        const channel = new FakeChannel();
        const fakeMcp = { tools: [] } as unknown as KanbanMcp;
        const supervisor = new McpSupervisor({ mcp: fakeMcp, initiallyAlive: false });
        const handlers = createBotHandlers({
          channel: channel as unknown as FeishuChannel,
          router,
          confirmations,
          cfg,
          mcp: fakeMcp,
          supervisor,
          reportServer: null, // 无报告服务：走 notifyOpenId 纯文本推送路径
          helpText: 'HELP',
        });
        const click = () =>
          handlers.onCardAction({
            operator: { open_id: 'u1' },
            action: { value: { hta_review: 'att-1', title: '审查任务标题' } },
          });

        click();
        await waitFor(
          () => channel.notifies.filter((n) => n.text.includes('AI 审查已开始')).length === 1,
          '审查开始通知',
        );
        click(); // 审查进行中连点同一 attempt：应走去重提示，不重复执行
        await waitFor(
          () => channel.notifies.some((n) => n.text.includes('AI 审查正在进行中')),
          'attempt 去重提示',
        );
        await waitFor(
          () => channel.notifies.some((n) => n.text.includes('🤖 AI 审查结果')),
          '审查结果推送',
        );
        // ocr 只被调用一次（去重生效），且 from/to 与看板 diff 视图同口径
        const log = fs.readFileSync(ocrLog, 'utf8');
        assert.equal(log.split('--repo').length - 1, 1, `ocr 调用次数应为 1，日志：${log}`);
        assert.ok(log.includes('--from main --to feature-x'), `diff 引用不符：${log}`);
        // 需求上下文：标题 + 任务描述都应进入 --background
        assert.ok(log.includes('任务标题：审查任务标题'), `--background 缺任务标题：${log}`);
        assert.ok(log.includes('连续失败 5 次锁定 10 分钟'), `--background 缺任务描述：${log}`);
        const resultNotify = channel.notifies.find((n) => n.text.includes('🤖 AI 审查结果'))!;
        assert.ok(resultNotify.text.includes('审查任务标题'));
        assert.ok(resultNotify.text.includes('AI-REVIEW-STUB-RESULT'), '结果应含 ocr 输出原文');
        // 结果注入会话（pendingNotes 缓存到轮边界），供用户追问「按审查意见修一下」
        const notes = (router.getOrCreate('u1') as unknown as { pendingNotes: Array<{ text: string }> }).pendingNotes;
        assert.ok(
          notes.some(
            (n) => n.text.includes('AI 审查完成') && n.text.includes('审查任务标题') && n.text.includes('AI-REVIEW-STUB-RESULT'),
          ),
          `审查结果应注入会话，实际：${JSON.stringify(notes)}`,
        );

        // finally 清理去重集合：完成后可再次发起同一 attempt 的审查
        click();
        await waitFor(
          () => channel.notifies.filter((n) => n.text.includes('AI 审查已开始')).length === 2,
          '完成后可再次发起',
        );
        await waitFor(
          () => channel.notifies.filter((n) => n.text.includes('🤖 AI 审查结果')).length === 2,
          '第二次审查结果',
        );
        assert.equal(fs.readFileSync(ocrLog, 'utf8').split('--repo').length - 1, 2, '第二次应真实再跑一遍');
      } finally {
        await stopServer(kanban);
      }
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    check('hta_review 测试后 PATH 已恢复', process.env.PATH === prevPath);
  });

  // ================= 盲区 3：cli askWithAbort =================
  // createAskWithAbort 已从 src/cli.ts main() 抽为模块级导出（ask 与当前轮次 ctl 由调用方注入），
  // 这里直接测三路竞态：正常回答 / Ctrl+C abort / 超时自动拒绝。

  await checkAsync('askWithAbort：正常回答直通结果', async () => {
    const askWithAbort = createAskWithAbort(async () => '用户输入', () => null);
    assert.equal(await askWithAbort('问: '), '用户输入');
  });

  await checkAsync('askWithAbort：无 ctl 无 timeout 时直通 ask，不包竞态层', async () => {
    let calls = 0;
    const askWithAbort = createAskWithAbort(async () => {
      calls++;
      return null; // EOF
    }, () => null);
    assert.equal(await askWithAbort('问: '), null);
    assert.equal(calls, 1);
  });

  await checkAsync('askWithAbort：abort 先于回答 → null（视为拒绝）', async () => {
    const ctl = new AbortController();
    const askWithAbort = createAskWithAbort(
      () => new Promise<string | null>(() => {}), // 永不回答，模拟用户挂起
      () => ctl,
    );
    const p = askWithAbort('问: ');
    ctl.abort();
    assert.equal(await p, null);
  });

  await checkAsync('askWithAbort：ctl 已 aborted 时立即 null，不再调用 ask', async () => {
    const ctl = new AbortController();
    ctl.abort();
    let called = false;
    const askWithAbort = createAskWithAbort(async () => {
      called = true;
      return 'x';
    }, () => ctl);
    assert.equal(await askWithAbort('问: '), null);
    assert.equal(called, false);
  });

  await checkAsync('askWithAbort：超时未操作 → ASK_TIMEOUT（自动拒绝）', async () => {
    const askWithAbort = createAskWithAbort(
      () => new Promise<string | null>(() => {}),
      () => null,
    );
    assert.equal(await askWithAbort('问: ', 50), ASK_TIMEOUT);
  });

  await checkAsync('askWithAbort：回答先于超时到达 → 正常结果，且 timer 已清理', async () => {
    const askWithAbort = createAskWithAbort(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return '及时回答';
    }, () => null);
    assert.equal(await askWithAbort('问: ', 5000), '及时回答');
  });

  await checkAsync('askWithAbort：abort 收尾取消挂起 waiter，中断后输入不被吞', async () => {
    const reader = createFakeLineReader();
    const ctl = new AbortController();
    const askWithAbort = createAskWithAbort(reader.ask, () => ctl, reader.cancelPending);
    const p = askWithAbort('允许执行? ');
    ctl.abort(); // Ctrl+C：闸门按拒绝收尾，底层 ask 的 waiter 仍挂着
    assert.equal(await p, null);
    // 闸门收尾后、主循环下一次 ask('› ') 之前用户敲入的一行：应入队留给下一次 ask，
    // 不被陈旧 waiter 吞掉（不取消 waiter 时 feed 会喂给旧 waiter，下一次 ask 永远等不到）
    reader.feed('中断后的输入');
    assert.equal(await askOrTimeout(reader.ask), '中断后的输入');
  });

  await checkAsync('askWithAbort：超时收尾同样取消挂起 waiter', async () => {
    const reader = createFakeLineReader();
    const askWithAbort = createAskWithAbort(reader.ask, () => null, reader.cancelPending);
    assert.equal(await askWithAbort('允许执行? ', 50), ASK_TIMEOUT);
    reader.feed('超时后的输入');
    assert.equal(await askOrTimeout(reader.ask), '超时后的输入');
  });

  await checkAsync('askWithAbort：正常回答路径不触发 cancelPending（waiter 已被回答消费）', async () => {
    const reader = createFakeLineReader();
    const askWithAbort = createAskWithAbort(reader.ask, () => null, reader.cancelPending);
    const p = askWithAbort('问: ', 5000);
    reader.feed('y');
    assert.equal(await p, 'y');
    // 回答后再次提问能正常拿到下一行（cancelPending 若误触发会多 resolve 一个 null 出来）
    const p2 = askWithAbort('问2: ', 5000);
    reader.feed('n');
    assert.equal(await p2, 'n');
  });

  // ================= 盲区 4：config-wizard 非交互部分 + 链路 =================

  check('resolveAllowedOpenIds：回车保留现状 / 新列表覆盖 / 换绑场景 "-" 清除', (() => {
    const existing = ['ou_1', 'ou_2'];
    return (
      resolveAllowedOpenIds('', existing, false) === existing && // 回车：原数组原样保留
      resolveAllowedOpenIds('  ', existing, false).length === 0 && // 纯空白：视为输入了新列表（split 后滤空）
      resolveAllowedOpenIds('ou_3, ou_4', existing, false).join(',') === 'ou_3,ou_4' &&
      resolveAllowedOpenIds('-', existing, false).join(',') === '-' && // 非换绑场景 "-" 只是普通输入
      resolveAllowedOpenIds('-', existing, true).length === 0 // 换绑场景 "-" 清除白名单
    );
  })());

  await checkAsync('config：writeEnvFile 写出 0600，合并保留无关键，且能被加载链路读回', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-cov-env-'));
    const envPath = path.join(tmp, '.env');
    const KEYS = [
      'LLM_BASE_URL',
      'LLM_API_KEY',
      'LLM_MODEL',
      'HELIOS_KANBAN_URL',
      'CUSTOM_COV_KEY',
      'HELIOS_TASK_AGENT_ENV',
    ];
    const saved = new Map(KEYS.map((k) => [k, process.env[k]] as const));
    try {
      writeEnvFile(
        {
          LLM_BASE_URL: 'http://cov-llm/v1',
          LLM_API_KEY: 'sk-cov',
          LLM_MODEL: 'cov-model',
          HELIOS_KANBAN_URL: 'http://cov-kanban:7964',
          CUSTOM_COV_KEY: 'keep',
        },
        envPath,
      );
      // 凭证文件权限必须 0600
      assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
      // 合并写：更新一项、空值删一项，无关键保留
      writeEnvFile({ LLM_MODEL: 'cov-model-2', CUSTOM_COV_KEY: undefined }, envPath);
      const parsed = dotenv.parse(fs.readFileSync(envPath));
      assert.equal(parsed.LLM_MODEL, 'cov-model-2');
      assert.equal(parsed.LLM_API_KEY, 'sk-cov');
      assert.equal(parsed.CUSTOM_COV_KEY, undefined);
      // 走真实加载链路读回：HELIOS_TASK_AGENT_ENV 强制路径优先级最高
      process.env.HELIOS_TASK_AGENT_ENV = envPath;
      const { loaded } = loadEnvFiles();
      assert.ok(
        loaded.some((p) => path.resolve(p) === path.resolve(envPath)),
        `加载列表应含强制路径，实际：${loaded.join(', ')}`,
      );
      const cfg = currentConfig();
      assert.equal(cfg.llmBaseUrl, 'http://cov-llm/v1');
      assert.equal(cfg.llmApiKey, 'sk-cov');
      assert.equal(cfg.llmModel, 'cov-model-2');
      assert.equal(cfg.kanbanUrl, 'http://cov-kanban:7964');
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('llm-verify：401 判失败、404 判 uncertain、连接失败返回失败而非抛异常', async () => {
    const plan = [200, 401, 404];
    let n = 0;
    const server = http.createServer((_req, res) => {
      const status = plan[Math.min(n++, plan.length - 1)]!;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await verifyLlmConfig(`${base}/v1`, 'sk-x');
      assert.deepEqual(ok, { ok: true, message: 'ok' });
      const unauth = await verifyLlmConfig(`${base}/v1`, 'sk-bad');
      assert.equal(unauth.ok, false);
      assert.equal(unauth.uncertain, undefined); // 401 是确定的配置错误，不是 uncertain
      assert.ok(unauth.message.includes('API Key'));
      const noModels = await verifyLlmConfig(`${base}/v1`, 'sk-x');
      assert.equal(noModels.ok, false);
      assert.equal(noModels.uncertain, true); // 端点不实现 /models：不确定，不误拦
      // 连接失败（端口无人监听）：返回失败结果而非抛异常
      const down = await verifyLlmConfig('http://127.0.0.1:1/v1', 'sk-x', 2000);
      assert.equal(down.ok, false);
      assert.equal(down.uncertain, true);
      assert.ok(down.message.includes('无法连接'));
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('feishu-verify：无效凭证 / 未启用机器人 / 网络异常均返回失败而非抛异常', async () => {
    const origFetch = globalThis.fetch;
    try {
      // 换 token 即失败：code != 0
      globalThis.fetch = (async () => ({
        json: async () => ({ code: 10003, msg: 'app_id invalid' }),
      })) as unknown as typeof fetch;
      const bad = await verifyFeishuApp('bad-id', 'bad-secret');
      assert.equal(bad.ok, false);
      assert.ok(bad.message.includes('无效'), `实际：${bad.message}`);
      // token 成功但机器人能力未启用
      let call = 0;
      globalThis.fetch = (async () => ({
        json: async () =>
          ++call === 1
            ? { code: 0, tenant_access_token: 't-token' }
            : { code: 999, msg: 'bot capability missing' },
      })) as unknown as typeof fetch;
      const noBot = await verifyFeishuApp('id', 'secret');
      assert.equal(noBot.ok, false);
      assert.ok(noBot.message.includes('机器人'), `实际：${noBot.message}`);
      // fetch 直接抛异常（网络不通）
      globalThis.fetch = (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch;
      const down = await verifyFeishuApp('id', 'secret');
      assert.equal(down.ok, false);
      assert.ok(down.message.includes('无法连接'), `实际：${down.message}`);
    } finally {
      globalThis.fetch = origFetch;
    }
    check('feishu-verify 测试后全局 fetch 已恢复', globalThis.fetch === origFetch);
  });

  // ================= 盲区 5：cli 启动窗口信号处理 =================
  // 信号注册已前移到 ensureKanbanOrExit 之前（对齐 bot-main「尽早注册 + 创建即登记」）：
  // 看板拉起窗口内（健康探测在途，最长 90s）收到 SIGTERM/SIGINT 必须走优雅退出（退出码 0）——
  // 修复前 cli 根本没有 SIGTERM handler（默认终止，in-flight 子进程成孤儿），
  // Ctrl+C 也因 handler 未注册而不退出、启动流程继续跑。
  // 以完整 env 启动真实 cli 入口（tsx 子进程）+ 挂起式 mock 看板，装置模式同 unit-bot 的退出码测试。

  const repoRoot = path.join(__dirname, '..');
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  /** 挂起式 mock 看板：/api/health 接受连接但永不响应，ensureKanbanOrExit 的探测随之挂起（启动窗口在途态）。 */
  const startHangingKanban = async (): Promise<{ server: http.Server; url: string; healthSeen: Promise<void> }> => {
    let markSeen!: () => void;
    const healthSeen = new Promise<void>((r) => (markSeen = r));
    const server = http.createServer((req, res) => {
      if ((req.url || '').startsWith('/api/health')) {
        markSeen();
        return; // 永不响应：探测挂起直到 fetchHealth 自身超时
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, healthSeen };
  };

  /** 在健康探测挂起时给 cli 子进程发信号，返回退出码与输出。 */
  const signalDuringKanbanBoot = async (
    signal: 'SIGINT' | 'SIGTERM',
    url: string,
    healthSeen: Promise<void>,
  ): Promise<{ code: number | null; out: () => string }> => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-cov-sig-'));
    const child = spawn(process.execPath, [tsxCli, path.join(repoRoot, 'src', 'cli.ts')], {
      cwd: tmp, // 避免 cwd .env 干扰子进程配置
      env: {
        ...process.env,
        HELIOS_TASK_AGENT_HOME: tmp, // 数据目录隔离；同时让 home .env 不存在（不会覆盖下列 env）
        HELIOS_TASK_AGENT_ENV: path.join(tmp, 'nonexistent.env'), // 中和父进程可能带来的强制 env
        LLM_BASE_URL: 'http://127.0.0.1:9/v1',
        LLM_API_KEY: 'sk-x',
        LLM_MODEL: 'm',
        HELIOS_KANBAN_URL: url,
        // 探测挂起期间即发信号；即使信号迟到也不许触发 npx 自动拉起看板（离线测试）
        HELIOS_KANBAN_AUTO_START: '0',
        HTA_UPDATE_CHECK: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d: Buffer) => (buf += d.toString()));
    child.stderr.on('data', (d: Buffer) => (buf += d.toString()));
    try {
      // 探测请求在途 = 已进 ensureKanbanOrExit；信号处理注册在其之前，此刻必然已生效。
      // healthSeen 本身无超时：cli 在发起探测前崩溃时 promise 永不 resolve，配合 main 里 ref'd
      // keepAlive 会无限挂起。故与「超时拒绝」及「探测前退出」竞速，失败时附带子进程输出便于定位
      await Promise.race([
        healthSeen,
        new Promise<never>((_r, rej) =>
          setTimeout(() => rej(new Error(`等待健康探测超时（30s），cli 未发起探测；输出：${buf}`)), 30000).unref(),
        ),
        new Promise<never>((_r, rej) =>
          child.once('exit', (c) => rej(new Error(`cli 在发起健康探测前退出（code=${c}）；输出：${buf}`))),
        ),
      ]);
      child.kill(signal);
      const code = await new Promise<number | null>((resolve, reject) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('子进程退出超时'));
        }, 20000);
        child.on('exit', (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      return { code, out: () => buf };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };

  await checkAsync('cli 启动窗口：看板探测在途时收到 SIGTERM，优雅退出（退出码 0）', async () => {
    const kanban = await startHangingKanban();
    try {
      const { code, out } = await signalDuringKanbanBoot('SIGTERM', kanban.url, kanban.healthSeen);
      // 修复前无 SIGTERM handler：进程被信号默认终止，exit code 为 null
      assert.equal(code, 0, `SIGTERM 路径退出码应为 0，实际 ${code}；输出：${out()}`);
    } finally {
      await stopServer(kanban.server);
    }
  });

  await checkAsync('cli 启动窗口：看板探测在途时按 Ctrl+C 直接退出（不再吞信号继续启动）', async () => {
    const kanban = await startHangingKanban();
    try {
      const { code, out } = await signalDuringKanbanBoot('SIGINT', kanban.url, kanban.healthSeen);
      assert.ok(out().includes('再见'), `应走优雅退出路径，输出：${out()}`);
      assert.equal(code, 0, `SIGINT 路径退出码应为 0，实际 ${code}；输出：${out()}`);
    } finally {
      await stopServer(kanban.server);
    }
  });

  finish();
}

void main();
