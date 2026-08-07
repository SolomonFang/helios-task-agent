// Resilience unit tests: LLM 重试退避 / watcher 事件粒度送达 / 后台事件注入的网关兼容。
// 仅用本地 mock server，无外部网络。Run: npx tsx scripts/unit-resilience.ts

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { createClient, downgradeSystemNotes, runAgentTurn } from '../src/llm';
import { KanbanWatcher } from '../src/kanban/watcher';
import { McpSupervisor } from '../src/bot/supervisor';
import type { KanbanMcp } from '../src/kanban/mcp';
import { AgentSession } from '../src/session';
import { MemoryStore } from '../src/memory';
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '../src/guard';
import type { AgentConfig, ChatMessage, OpenAiClient } from '../src/types';
import { check, checkAsync, finish } from './testkit';

/** 标准 chat completion 响应体。 */
function completionBody(content: string) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

/**
 * 本地 mock OpenAI 服务：plan 为每次请求返回的状态码序列，用完后重复最后一项。
 * 记录每次请求的状态码序号、重试计数头与最后一次请求体。
 */
async function startMockLlm(plan: number[]) {
  const seen: Array<{ retryCount: string | undefined; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const n = seen.length;
      seen.push({ retryCount: req.headers['x-stainless-retry-count'] as string | undefined, body });
      const status = plan[Math.min(n, plan.length - 1)]!;
      if (status === 200) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completionBody('pong')));
      } else {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock HTTP ${status}`, type: 'mock_error' } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, seen };
}

async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

/** 本地 mock 看板服务：taskStatus 可变，驱动 watcher 产生 done 事件。 */
async function startMockKanban(state: { taskStatus: string }) {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (data: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    };
    if (url.startsWith('/api/tasks?')) return json([{ id: 't1', title: '任务1', status: state.taskStatus }]);
    if (url.startsWith('/api/task-attempts')) return json([]);
    if (url.startsWith('/api/tasks/')) return json({ last_attempt_summary: '摘要' });
    if (url.startsWith('/api/approvals')) return json([]);
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const tickOf = (w: KanbanWatcher) => (w as unknown as { tick: () => Promise<void> }).tick.bind(w);

async function main(): Promise<void> {
  // ---------- LLM：重试预算与错误传播（createClient 把 maxRetries 调为 3，见 src/llm.ts createClient） ----------
  await checkAsync('LLM 重试：瞬时 429 后自动退避重试成功，不整轮报废', async () => {
    const { server, base, seen } = await startMockLlm([429, 429, 200]);
    try {
      const client = createClient({ llmBaseUrl: `${base}/v1`, llmApiKey: 'sk-x', llmModel: 'm' });
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ];
      // 行为断言：自研 runAgentTurn 在瞬时 429 后仍能拿到结果（SDK 内建退避在底层完成）
      const reply = await runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() });
      assert.equal(reply, 'pong');
      assert.equal(seen.length, 3); // 1 + 2 次重试
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('LLM 重试：持续 500 耗尽重试预算（1+3 次）后由 runAgentTurn 原样抛出', async () => {
    const { server, base, seen } = await startMockLlm([500]);
    try {
      const client = createClient({ llmBaseUrl: `${base}/v1`, llmApiKey: 'sk-x', llmModel: 'm' });
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ];
      // 行为断言（替代旧版强转读 SDK 私有字段 maxRetries 的脆性断言）：
      // 请求数恰好 1+maxRetries(3)=4 证明 createClient 的重试预算生效；自研 runAgentTurn
      // 不吞错、不追加自己的重试，终端错误原样抛给调用方。
      await assert.rejects(
        () => runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() }),
        /mock HTTP 500/,
      );
      assert.equal(seen.length, 4); // 1 + maxRetries(3)，自研层不再放大请求量
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('LLM 重试：400 属不可重试错误，不放大请求量', async () => {
    const { server, base, seen } = await startMockLlm([400]);
    try {
      const client = createClient({ llmBaseUrl: `${base}/v1`, llmApiKey: 'sk-x', llmModel: 'm' });
      await assert.rejects(() =>
        client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      );
      assert.equal(seen.length, 1);
    } finally {
      await stopServer(server);
    }
  });

  // ---------- 后台事件注入：非首位 system 降级为 user + UNTRUSTED ----------
  check('downgradeSystemNotes：首位 system 保留，后续 system 降级 user 且 UNTRUSTED 包裹、不重复包裹', (() => {
    const raw = '后台事件原文';
    const wrapped = `${UNTRUSTED_OPEN}\n已包裹\n${UNTRUSTED_CLOSE}`;
    const out = downgradeSystemNotes([
      { role: 'system', content: 'sys' },
      { role: 'system', content: raw },
      { role: 'user', content: 'hi' },
      { role: 'system', content: wrapped },
    ]);
    const note = out[1]!;
    const already = out[3]!;
    return (
      out[0]!.role === 'system' &&
      note.role === 'user' &&
      typeof note.content === 'string' &&
      note.content.includes(UNTRUSTED_OPEN) &&
      note.content.includes(raw) &&
      out[2]!.role === 'user' &&
      already.role === 'user' &&
      already.content === wrapped // 已包裹的保持原样
    );
  })());

  await checkAsync('downgradeSystemNotes：只作用于请求载荷，会话内存储角色不变', async () => {
    let captured: ChatMessage[] = [];
    const client = {
      chat: {
        completions: {
          create: async (req: { messages: ChatMessage[] }) => {
            captured = req.messages;
            return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
          },
        },
      },
    } as unknown as OpenAiClient;
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'system', content: '后台事件X' },
      { role: 'user', content: 'hi' },
    ];
    await runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() });
    assert.equal(captured.filter((m) => m.role === 'system').length, 1); // 载荷只剩首位 system
    assert.equal(captured[1]!.role, 'user');
    assert.ok(String(captured[1]!.content).includes('后台事件X'));
    assert.equal(messages[1]!.role, 'system'); // 存储侧不变
    assert.equal(messages[1]!.content, '后台事件X');
  });

  await checkAsync('flushPendingNotes 端到端：注入事件以 user + UNTRUSTED 到达网关，无多条 system', async () => {
    const { server, base, seen } = await startMockLlm([200]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-note-'));
    try {
      const cfg: AgentConfig = {
        llmBaseUrl: `${base}/v1`,
        llmApiKey: 'sk-x',
        llmModel: 'm',
        mcpCommand: 'npx',
        mcpArgs: [],
        kanbanUrl: 'http://localhost:1',
        kanbanProjectId: '',
        kanbanRepoId: '',
        kanbanIteration: '',
      };
      const session = new AgentSession(cfg, null, false, { userId: 'u1', memory: new MemoryStore(tmp) });
      session.injectSystemNote(`[看板事件通知]\n${UNTRUSTED_OPEN}\n事件内容\n${UNTRUSTED_CLOSE}`);
      const reply = await session.handleUserMessage('在吗');
      assert.equal(reply, 'pong');
      assert.equal(seen.length, 1);
      const sent = JSON.parse(seen[0]!.body).messages as Array<{ role: string; content: string }>;
      assert.equal(sent.filter((m) => m.role === 'system').length, 1); // 网关只见一条 system
      const note = sent.find((m) => m.content.includes('事件内容'));
      assert.ok(note, '注入事件应出现在请求中');
      assert.equal(note!.role, 'user');
      assert.ok(note!.content.includes(UNTRUSTED_OPEN) && note!.content.includes(UNTRUSTED_CLOSE));
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- KanbanWatcher：(事件, owner) 粒度送达追踪 ----------
  await checkAsync('KanbanWatcher：部分 owner 失败后下轮只重投未送达组合，全员送达后不再推', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-watch-'));
    const kanbanState = { taskStatus: 'inprogress' };
    const { server, base } = await startMockKanban(kanbanState);
    const statePath = path.join(tmp, 'watch-state.json');
    try {
      const sent: Array<{ kind: string; owner: string }> = [];
      let o2Down = true;
      const mkWatcher = () =>
        new KanbanWatcher({
          kanbanUrl: base,
          projectId: 'p1',
          statePath,
          notify: async () => undefined, // perOwner 模式下不调用
          owners: () => ['o1', 'o2'],
          notifyOwner: async (e, owner) => {
            if (owner === 'o2' && o2Down) throw new Error('o2 unreachable');
            sent.push({ kind: e.kind, owner });
          },
        });
      const watcher = mkWatcher();
      const tick = tickOf(watcher);
      await tick(); // 基线，不通知
      assert.equal(sent.length, 0);
      kanbanState.taskStatus = 'done';
      await tick(); // o1 送达，o2 失败 → 进 pending
      assert.deepEqual(sent, [{ kind: 'done', owner: 'o1' }]);
      // pending 持久化：o1 已送达，o2 未送达
      const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        pending?: Record<string, { delivered: string[] }>;
      };
      assert.deepEqual(onDisk.pending?.['done:t1']?.delivered, ['o1']);
      o2Down = false; // o2 恢复可达
      await tick(); // 下轮只重投 (done:t1, o2)；o1 不被刷屏
      assert.deepEqual(sent, [
        { kind: 'done', owner: 'o1' },
        { kind: 'done', owner: 'o2' },
      ]);
      const after = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { pending?: unknown };
      assert.equal(after.pending, undefined); // 全员送达后出队
      await tick(); // 无新事件、无 pending：不再推
      assert.equal(sent.length, 2);

      // 重启恢复：构造带 pending 的 state（o3 未送达），新实例只重投未送达组合
      kanbanState.taskStatus = 'inprogress';
      const w2 = mkWatcher();
      const t2 = tickOf(w2);
      await t2(); // 快照推进到 inprogress
      sent.length = 0;
      kanbanState.taskStatus = 'done';
      let o3Down = true;
      const w3 = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath,
        notify: async () => undefined,
        owners: () => ['o1', 'o3'],
        notifyOwner: async (e, owner) => {
          if (owner === 'o3' && o3Down) throw new Error('o3 unreachable');
          sent.push({ kind: e.kind, owner });
        },
      });
      await tickOf(w3)(); // o1 送达，o3 失败进 pending
      assert.deepEqual(sent, [{ kind: 'done', owner: 'o1' }]);
      sent.length = 0;
      o3Down = false;
      const w4 = new KanbanWatcher({ // 模拟进程重启：新实例从 state 文件恢复 pending
        kanbanUrl: base,
        projectId: 'p1',
        statePath,
        notify: async () => undefined,
        owners: () => ['o1', 'o3'],
        notifyOwner: async (e, owner) => {
          sent.push({ kind: e.kind, owner });
        },
      });
      await tickOf(w4)(); // 无新 diff，仅 pending 中 (done:t1, o3) 重投
      assert.deepEqual(sent, [{ kind: 'done', owner: 'o3' }]);
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('KanbanWatcher：传统整批 notify 回调按事件粒度重投（已成功事件不重推）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-watch-leg-'));
    const kanbanState = { taskStatus: 'inprogress' };
    const { server, base } = await startMockKanban(kanbanState);
    try {
      const sent: string[] = [];
      let failOnce = true;
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        notify: async (e) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('feishu down');
          }
          sent.push(e.kind);
        },
      });
      const tick = tickOf(watcher);
      await tick(); // 基线
      kanbanState.taskStatus = 'done';
      await tick(); // 推送失败 → 事件进 pending
      assert.equal(sent.length, 0);
      await tick(); // 仅重投该事件
      assert.deepEqual(sent, ['done']);
      await tick(); // 已送达，不再重复
      assert.deepEqual(sent, ['done']);
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('KanbanWatcher：pending 超 TTL 丢弃不再重投（防 owner 长期不可达时无界增长）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-watch-ttl-'));
    const kanbanState = { taskStatus: 'inprogress' };
    const { server, base } = await startMockKanban(kanbanState);
    const statePath = path.join(tmp, 'watch-state.json');
    try {
      const logs: string[] = [];
      let attempts = 0;
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath,
        pendingTtlMs: 60,
        notify: async () => undefined,
        owners: () => ['o1'],
        notifyOwner: async () => {
          attempts++;
          throw new Error('o1 unreachable'); // owner 长期不可达
        },
        log: (m) => logs.push(m),
      });
      const tick = tickOf(watcher);
      await tick(); // 基线
      kanbanState.taskStatus = 'done';
      await tick(); // 推送失败 → 进 pending
      assert.equal(attempts, 1);
      const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        pending?: Record<string, { enqueuedAt?: unknown }>;
      };
      assert.ok(typeof onDisk.pending?.['done:t1']?.enqueuedAt === 'number', 'pending 应持久化 enqueuedAt');
      await new Promise((r) => setTimeout(r, 80)); // 越过 TTL
      await tick(); // 超期丢弃，不再重投
      assert.equal(attempts, 1, '超期条目不得再重投');
      const after = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { pending?: unknown };
      assert.equal(after.pending, undefined, '超期条目应出队落盘');
      assert.ok(logs.some((m) => m.includes('超期')), '丢弃应记日志');
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('KanbanWatcher：旧格式 pending（无 enqueuedAt）兼容加载并继续重投', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-watch-old-'));
    const kanbanState = { taskStatus: 'done' }; // 与手工 state 快照一致：不再 diff 出新事件
    const { server, base } = await startMockKanban(kanbanState);
    const statePath = path.join(tmp, 'watch-state.json');
    try {
      // 手工构造旧格式 state：pending 条目没有 enqueuedAt 字段
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          tasks: { t1: { title: '任务1', status: 'done', running: false, failed: false, projectId: 'p1' } },
          approvals: [],
          pending: {
            'done:t1': {
              event: { kind: 'done', title: '任务1', text: '✅ 看板任务已完成：《任务1》' },
              delivered: [],
            },
          },
        }),
      );
      const sent: string[] = [];
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath,
        notify: async () => undefined,
        owners: () => ['o1'],
        notifyOwner: async (e, owner) => {
          sent.push(`${e.kind}:${owner}`);
        },
      });
      await tickOf(watcher)(); // 旧条目应从加载时刻起算 TTL：本轮正常重投而非立即过期
      assert.deepEqual(sent, ['done:o1']);
      const after = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { pending?: unknown };
      assert.equal(after.pending, undefined, '送达后应出队');
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- McpSupervisor：stop 竞速超时 ----------
  await checkAsync('McpSupervisor：在途重连挂死时 stop 竞速超时返回，不拖累关闭流程', async () => {
    const logs: string[] = [];
    const fakeMcp = {
      tools: [],
      ping: async () => {
        throw new Error('mcp down');
      },
      reconnect: async () => new Promise<void>(() => {}), // 重连永不返回
    } as unknown as KanbanMcp;
    const sup = new McpSupervisor({
      mcp: fakeMcp,
      initiallyAlive: false,
      failThreshold: 1,
      stopTimeoutMs: 80,
      log: (m) => logs.push(m),
    });
    void sup.tick(); // 触发挂死的重连（tick 永不结束，不 await；无定时器残留）
    await new Promise((r) => setTimeout(r, 20)); // 等重连占位生效
    const t0 = Date.now();
    await sup.stop();
    assert.ok(Date.now() - t0 < 3000, `stop 应在竞速超时后返回，实际 ${Date.now() - t0}ms`);
    assert.ok(logs.some((m) => m.includes('超时')), '超时应记日志');
  });

  finish();
}

void main();
