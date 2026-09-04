// 停滞任务提醒（stale nudge）与失败 AI 诊断/重试的单测：
// - 停滞判定边界：恰好 N 小时 / 未到期 / 状态流转重置 / 24h 再提醒 / 重启不重复
// - 诊断按钮 action 路由、同一 attempt 防重复诊断、重试 follow-up 指令含诊断结论、重试防重
// - LLM 失败路径中文化。仅用本地 mock server 与注入执行器，无外部网络。
// Run: npx tsx scripts/unit-stale-diagnosis.ts

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { parseStaleNudgeHours, StaleNudgeTracker } from '../src/kanban/stale-nudge';
import { KanbanWatcher, type WatchEvent } from '../src/kanban/watcher';
import {
  resolveDiagnosisLlm,
  collectFailureContext,
  buildDiagnosisPrompt,
  runFailureDiagnosis,
  sendDiagnosisFollowUp,
  buildRetryPrompt,
} from '../src/kanban/failure-diagnosis';
import { buildWatchEventCard, buildDiagnosisCard } from '../src/channels/feishu-cards';
import { createBotHandlers } from '../src/bot/handler';
import { SessionRouter } from '../src/agent/session-router';
import { ConfirmationManager } from '../src/agent/confirm';
import { MemoryStore } from '../src/agent/memory';
import { McpSupervisor } from '../src/bot/supervisor';
import type { KanbanMcp } from '../src/kanban/mcp';
import type { FeishuChannel } from '../src/channels/feishu';
import type { AgentConfig } from '../src/types';
import { check, checkAsync, finish } from './testkit';

async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

/** 轮询等待条件成立（诊断/重试是 onCardAction 里 void 出去的异步流程）。 */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** mock 看板：tasks 行可变（status/updated_at），驱动 watcher 产出 stale 事件。 */
async function startStaleMockKanban(state: { status: string; updatedAt: string }) {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (data: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    };
    if (url.startsWith('/api/tasks?')) {
      return json([{ id: 't1', title: '任务1', status: state.status, updated_at: state.updatedAt }]);
    }
    if (url.startsWith('/api/task-attempts')) return json([]);
    if (url.startsWith('/api/approvals')) return json([]);
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const tickOf = (w: KanbanWatcher) => (w as unknown as { tick: () => Promise<void> }).tick.bind(w);

// --- fake channel：诊断/重试链路发 notifyOpenId / notifyCardOpenId / updateCard ---
class FakeChannel {
  notifies: { openId: string; text: string }[] = [];
  cards: { openId: string; card: Record<string, unknown> }[] = [];
  updatedCards: { messageId: string; card: Record<string, unknown> }[] = [];
  private seq = 0;
  async notifyOpenId(openId: string, text: string): Promise<void> {
    this.notifies.push({ openId, text });
  }
  async notifyCardOpenId(openId: string, card: Record<string, unknown>): Promise<string | undefined> {
    this.cards.push({ openId, card });
    return `card-${++this.seq}`;
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.updatedCards.push({ messageId, card });
  }
}

function makeCfg(kanbanUrl: string): AgentConfig {
  return {
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmApiKey: 'sk-x',
    llmModel: 'm',
    mcpCommand: 'npx',
    mcpArgs: [],
    kanbanUrl,
    kanbanProjectId: '',
    kanbanRepoId: '',
    kanbanIteration: '',
  };
}

/** 从卡片 JSON 里收集全部按钮的 value（断言 action 协议用）。 */
function buttonValues(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const el of (card.elements as Array<Record<string, unknown>>) ?? []) {
    if (el.tag !== 'action') continue;
    for (const a of (el.actions as Array<Record<string, unknown>>) ?? []) {
      if (a.value && typeof a.value === 'object') out.push(a.value as Record<string, unknown>);
    }
  }
  return out;
}

async function main(): Promise<void> {
  // ---------- parseStaleNudgeHours：opt-in 解析 ----------
  check('parseStaleNudgeHours：未设置/空串 = 关闭（null）', parseStaleNudgeHours(undefined) === null && parseStaleNudgeHours('') === null && parseStaleNudgeHours('  ') === null);
  check('parseStaleNudgeHours：合法小时数通过', parseStaleNudgeHours('8') === 8 && parseStaleNudgeHours('0.5') === 0.5);
  check('parseStaleNudgeHours：非法值抛错（由调用方告警并关闭）', (() => {
    for (const bad of ['abc', '-1', '0', '8h']) {
      try {
        parseStaleNudgeHours(bad);
        return false;
      } catch {
        /* 期望抛错 */
      }
    }
    return true;
  })());

  // ---------- StaleNudgeTracker：判定边界与防骚扰 ----------
  await checkAsync('StaleNudgeTracker：未到期不提醒，恰好到阈值即提醒', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-edge-'));
    try {
      const tracker = new StaleNudgeTracker({ statePath: path.join(tmp, 's.json'), thresholdMs: 8 * 3600_000 });
      const t0 = 1_000_000_000_000;
      // 差 1ms 未到期
      assert.deepEqual(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: t0 - 8 * 3600_000 + 1 }], t0), []);
      // 恰好 8 小时（>= 判定）→ 提醒
      assert.deepEqual(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: t0 - 8 * 3600_000 }], t0), [
        { id: 't1', updatedAtMs: t0 - 8 * 3600_000 },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('StaleNudgeTracker：同一阶段 24h 内不重复、满 24h 再提醒；状态流转/有更新后重置', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-remind-'));
    try {
      const tracker = new StaleNudgeTracker({
        statePath: path.join(tmp, 's.json'),
        thresholdMs: 8 * 3600_000,
        remindIntervalMs: 24 * 3600_000,
      });
      const staleAt = 1_000_000_000_000;
      const t1 = staleAt + 10 * 3600_000; // 已停滞 10h
      assert.equal(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], t1).length, 1, '首次到期应提醒');
      assert.equal(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], t1 + 3600_000).length, 0, '24h 内不重复');
      assert.equal(
        tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], t1 + 24 * 3600_000).length,
        1,
        '满 24h 再提醒一次',
      );
      // 状态流转（离开进行中）→ 条目清除；再回来重新计（updatedAt 未变且仍过期，会立刻再提醒——新阶段）
      assert.equal(tracker.due([{ id: 't1', status: 'done', updatedAtMs: staleAt }], t1 + 25 * 3600_000).length, 0, '非进行中不提醒');
      assert.equal(
        tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], t1 + 26 * 3600_000).length,
        1,
        '状态流转后重置：重新进入进行中按新阶段提醒',
      );
      // 任务有更新（updated_at 变化且未到期）→ 不再提醒
      const freshAt = t1 + 30 * 3600_000;
      assert.equal(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: freshAt }], freshAt + 3600_000).length, 0, '有更新后未到期不提醒');
      // updated_at 无法解析：无数据不判定
      assert.equal(tracker.due([{ id: 't2', status: 'inprogress', updatedAtMs: null }], freshAt + 20 * 3600_000).length, 0, 'updated_at 缺失不判定');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('StaleNudgeTracker：提醒状态落盘，新实例（进程重启）不重复轰炸', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-persist-'));
    try {
      const statePath = path.join(tmp, 's.json');
      const staleAt = 1_000_000_000_000;
      const now = staleAt + 10 * 3600_000;
      const t1 = new StaleNudgeTracker({ statePath, thresholdMs: 8 * 3600_000 });
      assert.equal(t1.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], now).length, 1);
      assert.ok(fs.existsSync(statePath), '提醒状态应落盘');
      const mode = fs.statSync(statePath).mode & 0o777;
      assert.equal(mode, 0o600, `state 文件应为 0600，实际 ${mode.toString(8)}`);
      // 模拟进程重启：新实例从盘上恢复，同一阶段 24h 内不再提醒
      const t2 = new StaleNudgeTracker({ statePath, thresholdMs: 8 * 3600_000 });
      assert.equal(t2.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], now + 3600_000).length, 0, '重启后不得重复提醒');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- KanbanWatcher 集成：stale 事件走推送管线 ----------
  await checkAsync('KanbanWatcher：进行中任务 updated_at 超阈值产出 stale 事件一次，下轮不重复', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-watch-'));
    const staleAt = new Date(Date.now() - 10 * 3600_000).toISOString();
    const kanbanState = { status: 'inprogress', updatedAt: staleAt };
    const { server, base } = await startStaleMockKanban(kanbanState);
    try {
      const sent: WatchEvent[] = [];
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        staleNudge: {
          thresholdMs: 8 * 3600_000,
          statePath: path.join(tmp, 'stale-state.json'),
        },
        notify: async (e) => {
          sent.push(e);
        },
      });
      const tick = tickOf(watcher);
      await tick(); // 基线：不打扰
      assert.equal(sent.length, 0, '首轮基线不应提醒');
      await tick(); // 第二轮：停滞 10h > 8h → stale 事件
      assert.equal(sent.length, 1);
      const e = sent[0]!;
      assert.equal(e.kind, 'stale');
      assert.equal(e.taskId, 't1');
      assert.ok(e.text.includes('久未更新'), `文案口径应为「无更新」而非「停滞/卡死」：${e.text}`);
      assert.ok(!e.text.includes('卡死') && !e.text.includes('停滞'), `文案不得过强：${e.text}`);
      assert.ok(e.extra?.includes('小时无更新'), `extra 应含停滞时长：${e.extra}`);
      await tick(); // 同一阶段不重复
      assert.equal(sent.length, 1, '同一停滞阶段不得重复推送');
      // 卡片渲染：stale kind 不崩、含标题与时长说明
      const card = buildWatchEventCard(e) as { header: { title: { content: string } } };
      assert.ok(card.header.title.content.includes('久未更新'));
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- resolveDiagnosisLlm：OCR_LLM_* 逐项优先，回退主配置 ----------
  check('resolveDiagnosisLlm：OCR_LLM_* 逐项优先，缺项回退机器人主配置', (() => {
    const fallback = { baseUrl: 'https://main.example/v1', apiKey: 'sk-main', model: 'main-model' };
    // 未设置：全部回退
    const d1 = resolveDiagnosisLlm(fallback, {});
    if (d1.baseUrl !== fallback.baseUrl || d1.apiKey !== 'sk-main' || d1.model !== 'main-model') return false;
    // OCR_LLM_URL 是 ocr 的完整端点：SDK baseURL 要剥掉 /chat/completions
    const d2 = resolveDiagnosisLlm(fallback, {
      OCR_LLM_URL: 'https://ocr.example/v1/chat/completions',
      OCR_LLM_TOKEN: 'sk-ocr',
      OCR_LLM_MODEL: 'ocr-model',
    });
    if (d2.baseUrl !== 'https://ocr.example/v1' || d2.apiKey !== 'sk-ocr' || d2.model !== 'ocr-model') return false;
    // 只隔离 key：URL/模型仍回退主配置（与 buildOcrEnv 逐项回退口径一致）
    const d3 = resolveDiagnosisLlm(fallback, { OCR_LLM_TOKEN: 'sk-ocr' });
    return d3.baseUrl === fallback.baseUrl && d3.apiKey === 'sk-ocr' && d3.model === 'main-model';
  })());

  // ---------- collectFailureContext / buildDiagnosisPrompt ----------
  await checkAsync('collectFailureContext：任务详情 + 最新 attempt + diff 统计组装进诊断材料', async () => {
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url === '/api/tasks/t1') {
        return json({ title: '修复登录', description: '登录接口偶发 500', last_attempt_summary: '执行失败：npm test 有 2 个用例未通过' });
      }
      if (url === '/api/task-attempts?task_id=t1') {
        return json([
          { id: 'att-1', created_at: '2026-01-01' },
          { id: 'att-2', created_at: '2026-01-02' },
        ]);
      }
      if (url === '/api/task-attempts/summary' && req.method === 'POST') {
        return json([{ workspace_id: 'att-2', files_changed: 3, additions: 42, deletions: 7 }]);
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ctx = await collectFailureContext(base, 't1');
      assert.equal(ctx.title, '修复登录');
      assert.equal(ctx.description, '登录接口偶发 500');
      assert.ok(ctx.attemptSummary.includes('npm test'), `摘要不符：${ctx.attemptSummary}`);
      assert.equal(ctx.attemptId, 'att-2', '应取最新 attempt');
      assert.deepEqual(ctx.diffStats, { filesChanged: 3, additions: 42, deletions: 7 });
      const prompt = buildDiagnosisPrompt(ctx, ctx.title);
      for (const want of ['失败原因归类', '关键证据摘要', '建议修复方向', '登录接口偶发 500', 'npm test', '改动 3 个文件']) {
        assert.ok(prompt.includes(want), `prompt 缺「${want}」`);
      }
    } finally {
      await stopServer(server);
    }
  });

  // ---------- runFailureDiagnosis：成功路径与 LLM 失败路径中文化 ----------
  await checkAsync('runFailureDiagnosis：成功返回诊断文本与 attemptId；LLM 失败给中文错误', async () => {
    const base = 'http://127.0.0.1:1';
    const llm = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm' };
    const ctxInject = async () => ({
      taskId: 't1',
      title: '修复登录',
      description: 'desc',
      attemptSummary: 'summary',
      attemptId: 'att-2' as string | undefined,
      diffStats: undefined,
    });
    const ok = await runFailureDiagnosis({
      kanbanUrl: base,
      taskId: 't1',
      llm,
      collectContext: ctxInject,
      complete: async (prompt) => {
        assert.ok(prompt.includes('修复登录'), 'prompt 应含任务标题');
        return '一、失败原因归类：测试失败\n二、关键证据摘要：…\n三、建议修复方向：…';
      },
    });
    assert.equal(ok.attemptId, 'att-2');
    assert.ok(ok.text.includes('测试失败'));
    // 超时 → 中文超时文案
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: base,
          taskId: 't1',
          llm,
          timeoutMs: 5 * 60_000,
          collectContext: ctxInject,
          complete: async () => {
            throw new Error('The operation timed out');
          },
        }),
      /AI 诊断超时（5 分钟），已终止。/,
    );
    // 其他 LLM 错误 → 通用中文定性 + 重试出路，不透英文原文
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: base,
          taskId: 't1',
          llm,
          collectContext: ctxInject,
          complete: async () => {
            throw new Error('mock HTTP 500 internal error');
          },
        }),
      /模型调用失败，请稍后重新点击/,
    );
  });

  // ---------- sendDiagnosisFollowUp / buildRetryPrompt ----------
  await checkAsync('sendDiagnosisFollowUp：定位最新会话并 POST follow-up；无会话给中文错误', async () => {
    const posted: Array<{ url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url.startsWith('/api/sessions?workspace_id=')) return json([{ id: 'sess-1' }, { id: 'sess-2' }]);
      if (req.method === 'POST' && url.startsWith('/api/sessions/')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          posted.push({ url, body });
          json({});
        });
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const prompt = buildRetryPrompt('修复登录', '一、失败原因归类：测试失败\n三、建议修复方向：补 mock');
      assert.ok(prompt.includes('测试失败') && prompt.includes('修复登录'), 'follow-up 指令应含诊断结论与任务标题');
      await sendDiagnosisFollowUp(base, 'att-2', prompt);
      assert.equal(posted.length, 1);
      assert.ok(posted[0]!.url.startsWith('/api/sessions/sess-2/follow-up'), `应 POST 到最新会话：${posted[0]!.url}`);
      assert.equal(JSON.parse(posted[0]!.body).prompt, prompt);
    } finally {
      await stopServer(server);
    }
    // 无会话：中文错误 + 手动出路
    const empty = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [] }));
    });
    await new Promise<void>((r) => empty.listen(0, '127.0.0.1', r));
    try {
      const base2 = `http://127.0.0.1:${(empty.address() as AddressInfo).port}`;
      await assert.rejects(() => sendDiagnosisFollowUp(base2, 'att-x', 'p'), /找不到该任务的执行会话/);
    } finally {
      await stopServer(empty);
    }
  });

  // ---------- buildDiagnosisCard：重试按钮与终态 ----------
  check('buildDiagnosisCard：带「↻ 按诊断结论重试」按钮；settledAt 后为无按钮终态', (() => {
    const card = buildDiagnosisCard('任务X', '一、…', 'task-1');
    const vals = buttonValues(card);
    if (vals.length !== 1 || vals[0]!.hta_retry !== 'task-1' || vals[0]!.title !== '任务X') return false;
    const header = (card.header as { title: { content: string } }).title.content;
    if (!header.includes('AI 失败诊断')) return false;
    const settled = buildDiagnosisCard('任务X', '一、…', 'task-1', { settledAt: '2026-09-04 10:00:00' });
    if (buttonValues(settled).length !== 0) return false; // 终态无按钮
    const settledHeader = (settled.header as { title: { content: string } }).title.content;
    return settledHeader.includes('已按诊断结论重试');
  })());

  check('buildWatchEventCard：失败卡片带「🔍 AI 诊断」按钮（hta_diagnose + attempt）', (() => {
    const card = buildWatchEventCard({
      kind: 'failed',
      title: '任务X',
      url: 'http://localhost:7964/x',
      taskId: 'task-1',
      attemptId: 'att-9',
      text: '…',
    });
    const vals = buttonValues(card);
    const diag = vals.find((v) => v.hta_diagnose);
    return Boolean(diag && diag.hta_diagnose === 'task-1' && diag.attempt === 'att-9');
  })());

  // ---------- handler 集成：hta_diagnose / hta_retry 路由、防重、follow-up 内容、失败路径 ----------
  await checkAsync('hta_diagnose/hta_retry：路由 → 诊断卡片 → 重试 follow-up 含诊断结论，全程防重复', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-diag-handler-'));
    try {
      const cfg = makeCfg('http://127.0.0.1:1');
      const router = new SessionRouter(cfg, null, false, new MemoryStore(tmp));
      const confirmations = new ConfirmationManager(async () => undefined, { timeoutMs: 1000 });
      const channel = new FakeChannel();
      const fakeMcp = { tools: [] } as unknown as KanbanMcp;
      const supervisor = new McpSupervisor({ mcp: fakeMcp, initiallyAlive: false });
      const diagnosisCalls: Array<{ taskId: string }> = [];
      const followUps: Array<{ attemptId: string; prompt: string }> = [];
      const handlers = createBotHandlers({
        channel: channel as unknown as FeishuChannel,
        router,
        confirmations,
        cfg,
        mcp: fakeMcp,
        supervisor,
        reportServer: null,
        helpText: 'HELP',
        diagnosisRunner: async (opts) => {
          diagnosisCalls.push({ taskId: opts.taskId });
          return { text: '一、失败原因归类：测试失败\n三、建议修复方向：补依赖', attemptId: 'att-2' };
        },
        followUpSender: async (_kanbanUrl, attemptId, prompt) => {
          followUps.push({ attemptId, prompt });
        },
      });
      const clickDiagnose = () =>
        handlers.onCardAction({
          operator: { open_id: 'u1' },
          action: { value: { hta_diagnose: 'task-1', attempt: 'att-2', title: '修复登录' } },
        });
      const clickRetry = () =>
        handlers.onCardAction({
          operator: { open_id: 'u1' },
          action: { value: { hta_retry: 'task-1', title: '修复登录' } },
        });

      clickDiagnose();
      await waitFor(() => channel.cards.length === 1, '诊断结果卡片');
      assert.equal(diagnosisCalls.length, 1);
      assert.ok(channel.notifies.some((n) => n.text.includes('AI 诊断已开始')), '应有开始通知');
      const diagCard = channel.cards[0]!.card;
      const retryBtn = buttonValues(diagCard).find((v) => v.hta_retry === 'task-1');
      assert.ok(retryBtn, '诊断卡片应带「按诊断结论重试」按钮');
      // 会话注入：追问有上下文
      const notes = (router.getOrCreate('u1') as unknown as { pendingNotes: Array<{ text: string }> }).pendingNotes;
      assert.ok(notes.some((n) => n.text.includes('AI 失败诊断完成') && n.text.includes('测试失败')), '诊断结论应注入会话');

      // 同一 attempt 重复点诊断：不再调 LLM，提示已诊断
      clickDiagnose();
      await waitFor(() => channel.notifies.some((n) => n.text.includes('已诊断过')), '重复诊断提示');
      assert.equal(diagnosisCalls.length, 1, '同一 attempt 不得重复诊断');

      // 重试：follow-up 指令含诊断结论；诊断卡片原地置终态
      clickRetry();
      await waitFor(() => followUps.length === 1, 'follow-up 发起');
      assert.equal(followUps[0]!.attemptId, 'att-2');
      assert.ok(followUps[0]!.prompt.includes('测试失败'), 'follow-up 应含失败原因');
      assert.ok(followUps[0]!.prompt.includes('补依赖'), 'follow-up 应含修复建议');
      await waitFor(() => channel.updatedCards.length === 1, '诊断卡片置终态');
      assert.equal(channel.updatedCards[0]!.messageId, 'card-1');
      assert.equal(buttonValues(channel.updatedCards[0]!.card).length, 0, '终态卡片不得再有按钮');
      await waitFor(() => channel.notifies.some((n) => n.text.includes('已按诊断结论发起重试')), '重试回执');

      // 重复点重试：不再发起
      clickRetry();
      await waitFor(() => channel.notifies.some((n) => n.text.includes('重试已发起过')), '重复重试提示');
      assert.equal(followUps.length, 1, '重试发起后不得重复发起');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('hta_diagnose：LLM 失败推中文提示；hta_retry 无诊断结论时给明确指引', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-diag-fail-'));
    try {
      const cfg = makeCfg('http://127.0.0.1:1');
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
        reportServer: null,
        helpText: 'HELP',
        diagnosisRunner: async () => {
          throw new Error('AI 诊断超时（6 分钟），已终止。');
        },
      });
      // 先点重试（无诊断结论）：明确指引重新诊断，不沉默
      handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { hta_retry: 'task-9', title: '任务Y' } } });
      await waitFor(() => channel.notifies.some((n) => n.text.includes('找不到') && n.text.includes('诊断结论')), '无结论指引');
      // 诊断 LLM 失败：中文失败提示，不留沉默
      handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { hta_diagnose: 'task-1', attempt: 'att-1', title: '任务X' } } });
      await waitFor(() => channel.notifies.some((n) => n.text.includes('⚠️ AI 诊断失败')), '诊断失败提示');
      const fail = channel.notifies.find((n) => n.text.includes('⚠️ AI 诊断失败'))!;
      assert.ok(fail.text.includes('AI 诊断超时（6 分钟）'), `失败原因应中文化：${fail.text}`);
      assert.equal(channel.cards.length, 0, '诊断失败不得推结果卡片');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
