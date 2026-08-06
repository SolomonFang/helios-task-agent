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
import { AgentSession } from '../src/session';
import { MemoryStore } from '../src/memory';
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '../src/guard';
import type { AgentConfig, ChatMessage, OpenAiClient } from '../src/types';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/** try/catch 包装：异常即 FAIL。 */
async function checkAsync(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    check(name, true);
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
  }
}

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
  // ---------- LLM：SDK 内建退避重试 ----------
  check('createClient：maxRetries 调大为 3（SDK 内建退避覆盖 429/5xx/连接错误）', (() => {
    const client = createClient({ llmBaseUrl: 'http://localhost:1/v1', llmApiKey: 'sk-x', llmModel: 'm' });
    return (client as unknown as { maxRetries: number }).maxRetries === 3;
  })());

  await checkAsync('LLM 重试：瞬时 429 后自动退避重试成功，不整轮报废', async () => {
    const { server, base, seen } = await startMockLlm([429, 429, 200]);
    try {
      const client = createClient({ llmBaseUrl: `${base}/v1`, llmApiKey: 'sk-x', llmModel: 'm' });
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ];
      const reply = await runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() });
      assert.equal(reply, 'pong');
      assert.equal(seen.length, 3); // 1 + 2 次重试
      assert.deepEqual(seen.map((s) => s.retryCount), ['0', '1', '2']); // SDK 退避重试计数
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('LLM 重试：持续 500 在 1+3 次后抛出，不无限重试', async () => {
    const { server, base, seen } = await startMockLlm([500]);
    try {
      const client = createClient({ llmBaseUrl: `${base}/v1`, llmApiKey: 'sk-x', llmModel: 'm' });
      await assert.rejects(() =>
        client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
      );
      assert.equal(seen.length, 4); // 1 + maxRetries(3)
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

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
