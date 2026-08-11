// Resilience unit tests: LLM 重试退避 / watcher 事件粒度送达 / 后台事件注入的网关兼容。
// 仅用本地 mock server，无外部网络。Run: npx tsx scripts/unit-resilience.ts

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { createClient, downgradeSystemNotes, runAgentTurn } from '../src/agent/llm';
import { KanbanWatcher } from '../src/kanban/watcher';
import { McpSupervisor } from '../src/bot/supervisor';
import { KanbanMcp, connectMcp } from '../src/kanban/mcp';
import { fetchHealth } from '../src/kanban/kanban-ensure';
import { startReportServer } from '../src/report/report-server';
import { apiGet } from '../src/kanban/http';
import { AgentSession } from '../src/agent/session';
import { MemoryStore } from '../src/agent/memory';
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '../src/agent/guard';
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
  // ---------- LLM：重试预算与错误传播（createClient 把 maxRetries 调为 3，见 src/agent/llm.ts createClient） ----------
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
        // TTL 100ms + 下方 sleep 300ms：留足余量，避免 CI 抖动下定时器误差导致 flaky
        pendingTtlMs: 100,
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
      await new Promise((r) => setTimeout(r, 300)); // 越过 TTL（100ms），余量充足
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
    // stop 的竞速定时器是 unref 的（生产侧不拖累退出）：测试进程此时无其他 ref 句柄，
    // 事件循环一旦清空进程会以 0 静默退出、后续用例整段丢失——持一个 ref 定时器保活
    const keepAlive = setInterval(() => {}, 1000);
    const t0 = Date.now();
    await sup.stop();
    clearInterval(keepAlive);
    assert.ok(Date.now() - t0 < 3000, `stop 应在竞速超时后返回，实际 ${Date.now() - t0}ms`);
    assert.ok(logs.some((m) => m.includes('超时')), '超时应记日志');
  });

  // ---------- McpSupervisor：onLost/onRecovered 回调异常兜底 ----------
  await checkAsync('McpSupervisor：onLost/onRecovered 回调抛异常被吞并记日志，不击穿 tick', async () => {
    const logs: string[] = [];
    let pingOk = false;
    const fakeMcp = {
      tools: [],
      ping: async () => {
        if (!pingOk) throw new Error('mcp down');
      },
      reconnect: async () => {
        pingOk = true;
      },
    } as unknown as KanbanMcp;
    const sup = new McpSupervisor({
      mcp: fakeMcp,
      initiallyAlive: true,
      failThreshold: 1,
      onLost: () => {
        throw new Error('onLost boom');
      },
      onRecovered: () => {
        throw new Error('onRecovered boom');
      },
      log: (m) => logs.push(m),
    });
    await sup.tick(); // ping 失败 → onLost 抛：不得成 unhandledRejection
    assert.equal(sup.isAlive, false);
    await sup.tick(); // 重连成功 → ping 恢复 → onRecovered 抛：同样被吞
    assert.equal(sup.isAlive, true);
    assert.ok(logs.some((m) => m.includes('onLost 回调异常')), 'onLost 异常应记日志');
    assert.ok(logs.some((m) => m.includes('onRecovered 回调异常')), 'onRecovered 异常应记日志');
  });

  // ---------- KanbanMcp：connect 在途时 close() 挂起，connect 完成后自我关闭 ----------
  await checkAsync('KanbanMcp：connect 在途期间 close()，连接完成后立即关闭（不留孤儿子进程）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-mcp-'));
    try {
      // 真实 stdio MCP 服务（用项目依赖的 SDK 起最小 Server），验证与真实子进程的交互
      const sdkRoot = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol/sdk', 'dist', 'cjs');
      const serverScript = path.join(tmp, 'mock-mcp-server.cjs');
      fs.writeFileSync(
        serverScript,
        [
          `const { Server } = require(${JSON.stringify(path.join(sdkRoot, 'server', 'index.js'))});`,
          `const { StdioServerTransport } = require(${JSON.stringify(path.join(sdkRoot, 'server', 'stdio.js'))});`,
          `const { ListToolsRequestSchema } = require(${JSON.stringify(path.join(sdkRoot, 'types.js'))});`,
          `const server = new Server({ name: 'mock', version: '1.0.0' }, { capabilities: { tools: {} } });`,
          `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));`,
          `server.connect(new StdioServerTransport()).catch(() => process.exit(1));`,
        ].join('\n'),
      );
      // 对照组：正常 connect 后 connected 为 true
      const mcp1 = new KanbanMcp({ command: process.execPath, args: [serverScript] });
      await mcp1.connect({ timeoutMs: 15000 });
      assert.equal(mcp1.connected, true);
      await mcp1.close();
      assert.equal(mcp1.connected, false);
      // close() 在 connect 完成前调用：client 尚为 null，靠 closePending 在 connect 完成后自我关闭
      const mcp2 = new KanbanMcp({ command: process.execPath, args: [serverScript] });
      const p = mcp2.connect({ timeoutMs: 15000 });
      await mcp2.close();
      await p; // connect 正常完成
      assert.equal(mcp2.connected, false, 'closePending 应在 connect 完成后触发自我关闭');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- KanbanMcp：close 后清理残留孙进程（SDK 不透传 detached，无进程组杀） ----------
  await checkAsync('KanbanMcp：close 补杀被 reparent 的孙进程，重复 close 幂等不报错', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return; // 清理仅覆盖 darwin/linux
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-mcp-tree-'));
    const pidFile = path.join(tmp, 'grandchild.pid');
    try {
      // 包装脚本：既是 MCP stdio server，又在启动时 spawn 一个孙进程 sleeper 并落 pid 文件
      // （孙进程 stdio ignore + unref，父死後被 reparent——正是泄漏场景的最小复现）
      const sdkRoot = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol/sdk', 'dist', 'cjs');
      const wrapperScript = path.join(tmp, 'mock-mcp-with-grandchild.cjs');
      fs.writeFileSync(
        wrapperScript,
        [
          `const { spawn } = require('child_process');`,
          `const fs = require('fs');`,
          `const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 60000)'], { stdio: 'ignore' });`,
          `gc.unref();`,
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));`,
          `const { Server } = require(${JSON.stringify(path.join(sdkRoot, 'server', 'index.js'))});`,
          `const { StdioServerTransport } = require(${JSON.stringify(path.join(sdkRoot, 'server', 'stdio.js'))});`,
          `const { ListToolsRequestSchema } = require(${JSON.stringify(path.join(sdkRoot, 'types.js'))});`,
          `const server = new Server({ name: 'mock', version: '1.0.0' }, { capabilities: { tools: {} } });`,
          `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));`,
          `server.connect(new StdioServerTransport()).catch(() => process.exit(1));`,
        ].join('\n'),
      );
      const mcp = new KanbanMcp({ command: process.execPath, args: [wrapperScript] });
      await mcp.connect({ timeoutMs: 15000 });
      // 等孙进程 pid 落盘（spawn→写文件与 MCP 握手并发）
      let gcPid = 0;
      for (let i = 0; i < 50 && !gcPid; i++) {
        if (fs.existsSync(pidFile)) gcPid = Number(fs.readFileSync(pidFile, 'utf8'));
        if (!gcPid) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(gcPid > 0, '孙进程应已启动并落盘 pid');
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      assert.ok(alive(gcPid), 'close 前孙进程应存活');
      await mcp.close();
      // close 内部已含 SIGTERM→300ms→SIGKILL：resolve 时孙进程应已被补杀（短轮询吸收信号时延）
      let dead = !alive(gcPid);
      for (let i = 0; i < 20 && !dead; i++) {
        await new Promise((r) => setTimeout(r, 100));
        dead = !alive(gcPid);
      }
      assert.ok(dead, `close 后孙进程 ${gcPid} 不应残留`);
      await mcp.close(); // 幂等：无 client、无快照，不得报错
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- apiGet：signal 与超时组合 / 重试策略 ----------
  await checkAsync('apiGet：传 signal 后 timeoutMs 仍兜底（signal 未触发时按超时中断）', async () => {
    // 挂起服务：接受连接但永不响应
    const server = http.createServer(() => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ctl = new AbortController();
      const t0 = Date.now();
      await assert.rejects(() => apiGet(base, '/hang', { signal: ctl.signal, timeoutMs: 200 }));
      assert.ok(Date.now() - t0 < 3000, `超时兜底应生效，实际 ${Date.now() - t0}ms`);
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('apiGet：调用方 signal 中断仍然生效（AbortError 不重试、不等超时）', async () => {
    const server = http.createServer(() => {});
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ctl = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ctl.abort(), 100);
      await assert.rejects(() => apiGet(base, '/hang', { signal: ctl.signal, timeoutMs: 30000 }));
      assert.ok(Date.now() - t0 < 5000, `中断应立刻生效，实际 ${Date.now() - t0}ms`);
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('apiGet 重试策略：4xx 不重试，5xx 间隔 500ms 重试一次', async () => {
    let count404 = 0;
    let count500 = 0;
    const server = http.createServer((req, res) => {
      if ((req.url || '').includes('/missing')) {
        count404++;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      count500++;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await assert.rejects(() => apiGet(base, '/missing'), /HTTP 404/);
      assert.equal(count404, 1, '4xx 不应重试');
      const t0 = Date.now();
      await assert.rejects(() => apiGet(base, '/boom'), /HTTP 500/);
      assert.equal(count500, 2, '5xx 应重试一次');
      assert.ok(Date.now() - t0 >= 300, '重试应有 500ms 间隔（下限留余量防定时器误差）');
    } finally {
      await stopServer(server);
    }
  });

  // ---------- KanbanWatcher：stop 等待在途 tick ----------
  await checkAsync('KanbanWatcher：stop 等待在途 tick 结束，兜底超时后照常返回', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-watch-stop-'));
    const kanbanState = { taskStatus: 'inprogress' };
    const { server, base } = await startMockKanban(kanbanState);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let notifyEntered = false;
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        notify: async () => {
          notifyEntered = true;
          await gate; // 推送挂起，模拟在途 tick
        },
      });
      const tick = tickOf(watcher);
      await tick(); // 基线
      kanbanState.taskStatus = 'done'; // 下轮产生 done 事件 → notify 挂起
      const inflight = tick();
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(notifyEntered, 'tick 应已进入挂起的推送');
      let stopped = false;
      const sp = watcher.stop().then(() => {
        stopped = true;
      });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(stopped, false, '在途 tick 未结束时 stop 不应返回');
      release();
      await inflight;
      await sp;
      assert.equal(stopped, true, '在途 tick 结束后 stop 应返回');

      // 兜底超时：tick 挂死不释放时 stop 按 stopTimeoutMs 照常返回并记日志
      const logs: string[] = [];
      const hanging = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state2.json'),
        stopTimeoutMs: 100,
        notify: () => new Promise<void>(() => {}), // 永不返回
        log: (m) => logs.push(m),
      });
      const tick2 = tickOf(hanging);
      await tick2(); // 基线（状态文件独立，首轮只建基线）
      kanbanState.taskStatus = 'inprogress';
      await tick2(); // 快照推进到 inprogress
      kanbanState.taskStatus = 'done';
      void tick2(); // 事件推送挂死，不 await
      await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      await hanging.stop();
      assert.ok(Date.now() - t0 < 3000, `兜底超时后 stop 应返回，实际 ${Date.now() - t0}ms`);
      assert.ok(logs.some((m) => m.includes('超时')), '兜底超时应记日志');
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- KanbanWatcher：approvals 拉取失败按「未知」处理（沿用旧快照） ----------
  await checkAsync('KanbanWatcher：approvals 瞬时失败沿用旧快照，恢复后不把全部 pending 当新审批重推', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-watch-appr-'));
    let approvalsFail = false;
    const approvalsList: Array<Record<string, unknown>> = [{ id: 'a1', status: 'pending', title: '审批1' }];
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url.startsWith('/api/approvals')) {
        if (approvalsFail) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        return json(approvalsList);
      }
      if (url.startsWith('/api/tasks?')) return json([]);
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const sent: string[] = [];
      const logs: string[] = [];
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        notify: async (e) => {
          sent.push(e.kind);
        },
        log: (m) => logs.push(m),
      });
      const tick = tickOf(watcher);
      await tick(); // 基线：a1 已在 pending（基线不通知）
      approvalsFail = true;
      await tick(); // approvals 500：按「未知」沿用旧快照 [a1]，不得推进为 []
      assert.ok(logs.some((m) => m.includes('approvals 拉取失败')), '拉取失败应记日志');
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'watch-state.json'), 'utf8')) as {
        approvals: Array<{ id: string }>;
      };
      assert.deepEqual(onDisk.approvals.map((a) => a.id), ['a1'], '失败轮不得把 approvals 推进为空');
      approvalsFail = false;
      await tick(); // 恢复：a1 不是「新」审批，不得全量重推
      assert.deepEqual(sent, [], '恢复后不得把既有 pending 审批当新审批重推');
      approvalsList.push({ id: 'a2', status: 'pending', title: '审批2' });
      await tick(); // 真正新增的审批仍要推
      assert.deepEqual(sent, ['approvals']);
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- McpSupervisor：重连退避节奏（前 3 次连续，之后每 5 个周期） ----------
  await checkAsync('McpSupervisor：退避节奏为 failures 1/2/3 连续试、之后 8/13…（每 5 个周期）', async () => {
    const reconnectTicks: number[] = [];
    let tickNo = 0;
    const fakeMcp = {
      tools: [],
      ping: async () => {
        throw new Error('mcp down');
      },
      reconnect: async () => {
        reconnectTicks.push(tickNo);
      },
    } as unknown as KanbanMcp;
    const sup = new McpSupervisor({ mcp: fakeMcp, initiallyAlive: false, failThreshold: 1 });
    for (tickNo = 1; tickNo <= 13; tickNo++) await sup.tick();
    // 旧条件 failures%5===0 会在 failures=5 时（距上次仅 2 个周期）误触发重连
    assert.deepEqual(reconnectTicks, [1, 2, 3, 8, 13], `退避节奏应为 1/2/3/8/13，实际 ${reconnectTicks.join(',')}`);
  });

  // ---------- McpSupervisor：看板健康探测补 stdio 探活 ----------
  await checkAsync('McpSupervisor：stdio 活着但看板假死时连续失败走 onLost，看板恢复后 onRecovered', async () => {
    let kanbanUp = false;
    const fakeMcp = {
      tools: [],
      ping: async () => {}, // stdio 探活始终通过（旧实现据此误判健康）
      reconnect: async () => {},
    } as unknown as KanbanMcp;
    let lost = 0;
    let recovered = 0;
    const sup = new McpSupervisor({
      mcp: fakeMcp,
      initiallyAlive: true,
      failThreshold: 2,
      kanbanHealth: async () => {
        if (!kanbanUp) throw new Error('kanban down');
      },
      onLost: () => {
        lost++;
      },
      onRecovered: () => {
        recovered++;
      },
    });
    await sup.tick(); // 看板探测失败 #1（未达阈值）
    assert.equal(sup.isAlive, true);
    assert.equal(lost, 0);
    await sup.tick(); // 上次失败后逐 tick 复查：失败 #2 → onLost
    assert.equal(sup.isAlive, false);
    assert.equal(lost, 1);
    kanbanUp = true;
    await sup.tick(); // 看板恢复 → onRecovered
    assert.equal(sup.isAlive, true);
    assert.equal(recovered, 1);
  });

  await checkAsync('McpSupervisor：看板健康时按间隔节流，不每 tick 打看板', async () => {
    let probes = 0;
    const fakeMcp = {
      tools: [],
      ping: async () => {},
      reconnect: async () => {},
    } as unknown as KanbanMcp;
    const sup = new McpSupervisor({
      mcp: fakeMcp,
      initiallyAlive: true,
      kanbanHealthIntervalMs: 60000,
      kanbanHealth: async () => {
        probes++;
      },
    });
    await sup.tick();
    await sup.tick();
    await sup.tick();
    assert.equal(probes, 1, `间隔内只应探测一次看板，实际 ${probes} 次`);
  });

  // ---------- fetchHealth：看板信封字段组合校验（防冒充） ----------
  await checkAsync('fetchHealth：仅含 "success":true 的响应不再算看板（需 error_data/message 字段组合）', async () => {
    const mk = async (body: string, contentType = 'application/json') => {
      const s = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': contentType });
        res.end(body);
      });
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    const kanban = await mk('{"success":true,"data":"OK","error_data":null,"message":null}');
    assert.equal(await fetchHealth(kanban.url, 1500), true, '完整看板信封应判健康');
    await stopServer(kanban.s);
    const partial = await mk('{"success":true}');
    assert.equal(await fetchHealth(partial.url, 1500), false, '仅 success:true 不得判健康');
    await stopServer(partial.s);
    const html = await mk('<html>{"success":true,"error_data":null,"message":null}</html>', 'text/html');
    assert.equal(await fetchHealth(html.url, 1500), false, '非 JSON 响应内嵌字段不得判健康');
    await stopServer(html.s);
  });

  // ---------- connectMcp：onCreate 在实例创建时同步回调（连接窗口内即可登记清理） ----------
  await checkAsync('connectMcp：onCreate 于 connect settle 前同步触发，拿到 in-flight 实例', async () => {
    const holder: { m: KanbanMcp | null; syncFired: boolean } = { m: null, syncFired: false };
    const p = connectMcp(
      { mcpCommand: process.execPath, mcpArgs: ['-e', 'process.exit(1)'] }, // 快速失败
      {
        onCreate: (m) => {
          holder.m = m;
        },
      },
    );
    holder.syncFired = holder.m !== null; // await 之前已回调：不等 connect resolve
    const r = await p;
    assert.ok(holder.syncFired, 'onCreate 应在 connect settle 前同步触发');
    assert.ok(holder.m instanceof KanbanMcp);
    assert.equal(r.mcp, holder.m, '回调拿到的就是最终返回的实例');
    assert.equal(r.ok, false, '失败命令应连接失败');
  });

  // ---------- report-server：listen 后 error 监听换挂为记日志 ----------
  await checkAsync('report-server：listen 成功后启动期 reject 监听被移除，运行时 error 记日志不吞', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-res-report-'));
    const origErr = console.error;
    const errLogs: string[] = [];
    console.error = (...args: unknown[]) => errLogs.push(args.map(String).join(' '));
    try {
      const rs = await startReportServer(tmp, 'http://localhost:7964');
      assert.equal(rs.server.listenerCount('error'), 1, 'listen 后应只剩一个 error 监听（记日志）');
      rs.server.emit('error', new Error('boom')); // 启动期的 reject 监听若还挂着会被静默吞掉
      assert.ok(
        errLogs.some((m) => m.includes('报告服务运行时错误') && m.includes('boom')),
        '运行时 error 应记日志',
      );
      rs.close();
    } finally {
      console.error = origErr;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  finish();
}

void main();
