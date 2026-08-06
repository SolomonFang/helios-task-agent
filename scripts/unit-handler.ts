// Handler 单元测试：fake channel（记录出站消息）+ 真实 SessionRouter / ConfirmationManager，
// LLM 走本地 loopback 假服务（可控挂起/放行），不触飞书 SDK 网络层。Run: npx tsx scripts/unit-handler.ts

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { createBotHandlers, type BotHandlers } from '../src/bot/handler';
import type { FeishuCardAction, FeishuChannel, FeishuInboundMessage } from '../src/channels/feishu';
import { SessionRouter } from '../src/session-router';
import { ConfirmationManager } from '../src/confirm';
import { MemoryStore } from '../src/memory';
import { McpSupervisor } from '../src/bot/supervisor';
import { CLEARED_TEXT } from '../src/commands';
import type { ConfirmRequest } from '../src/guard';
import type { AgentConfig, InboundMessage } from '../src/types';
import type { KanbanMcp } from '../src/kanban/mcp';

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

/** 轮询等待条件成立（队列与 LLM 请求均为异步），超时抛错。 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// --- fake channel：实现 handler 实际用到的 FeishuChannel 方法子集，记录全部出站消息 ---

class FakeChannel {
  readonly name = 'fake-feishu';
  replies: { sessionId: string; text: string }[] = [];
  sent: string[] = [];
  updated: string[] = [];
  notifies: { openId: string; text: string }[] = [];
  addedReactions: string[] = [];
  removedReactions: string[] = [];
  addReactionCalls = 0;
  /** 模拟表情回执权限缺失（addReaction 抛错，触发降级）。 */
  failReactions = false;
  private reactionSeq = 0;
  private messageSeq = 0;

  async reply(msg: InboundMessage, text: string): Promise<void> {
    this.replies.push({ sessionId: msg.sessionId, text });
  }
  async sendText(_chatId: string, text: string): Promise<string | undefined> {
    this.sent.push(text);
    return `ph-${++this.messageSeq}`;
  }
  async updateText(_messageId: string, text: string): Promise<void> {
    this.updated.push(text);
  }
  async addReaction(messageId: string, _emojiType: string): Promise<string | undefined> {
    this.addReactionCalls++;
    if (this.failReactions) throw new Error('no reaction permission');
    this.addedReactions.push(messageId);
    return `r-${++this.reactionSeq}`;
  }
  async removeReaction(messageId: string, _reactionId: string): Promise<void> {
    this.removedReactions.push(messageId);
  }
  async notifyOpenId(openId: string, text: string): Promise<void> {
    this.notifies.push({ openId, text });
  }
  async notifyCardOpenId(_openId: string, _card: Record<string, unknown>): Promise<void> {
    /* 本批用例不触发 */
  }
  lastEventAt(): number {
    return 0;
  }
  connectionState(): null {
    return null;
  }
}

// --- fake LLM 服务：ok 模式立即回固定补全；hang 模式挂起直到 release()（或被 /stop 中断） ---

const COMPLETION = JSON.stringify({
  id: 'cmpl-fake',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: '好的，已收到' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

class FakeLlmServer {
  readonly server: http.Server;
  requestCount = 0;
  mode: 'ok' | 'hang' = 'ok';
  baseUrl = '';
  private hanging: http.ServerResponse[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.requestCount++;
        if (this.mode === 'hang') this.hanging.push(res);
        else FakeLlmServer.respondOk(res);
      });
    });
  }

  private static respondOk(res: http.ServerResponse): void {
    try {
      if (res.destroyed || res.writableEnded) return; // 客户端已中断（/stop）
      res.setHeader('content-type', 'application/json');
      res.end(COMPLETION);
    } catch {
      /* 连接已被 abort 销毁 */
    }
  }

  /** 放行所有挂起的请求。 */
  release(): void {
    const pending = this.hanging.splice(0);
    for (const res of pending) FakeLlmServer.respondOk(res);
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    this.release();
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }
}

// --- 测试装置：真实 SessionRouter / ConfirmationManager / McpSupervisor + fake channel ---

interface Fixture {
  channel: FakeChannel;
  router: SessionRouter;
  confirmations: ConfirmationManager;
  handlers: BotHandlers;
  tmp: string;
  confirmPrompts: { openId: string; req: ConfirmRequest; id: string }[];
}

function setup(llmBaseUrl: string): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-handler-'));
  const cfg: AgentConfig = {
    llmBaseUrl,
    llmApiKey: 'sk-x',
    llmModel: 'm',
    mcpCommand: 'npx',
    mcpArgs: [],
    kanbanUrl: 'http://localhost:1',
    kanbanProjectId: '',
    kanbanRepoId: '',
    kanbanIteration: '',
  };
  const router = new SessionRouter(cfg, null, false, new MemoryStore(tmp));
  const confirmPrompts: Fixture['confirmPrompts'] = [];
  // 短超时：用例失败时挂起的确认定时器不拖住进程
  const confirmations = new ConfirmationManager(
    async (openId, _chatId, req, id) => {
      confirmPrompts.push({ openId, req, id });
      return undefined;
    },
    { timeoutMs: 5000 },
  );
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
    helpText: 'HELP-TEXT',
  });
  return { channel, router, confirmations, handlers, tmp, confirmPrompts };
}

let msgSeq = 0;
/** 构造一条飞书入站消息（messageId 唯一，typing 回执断言用）。 */
function mkMsg(senderId: string, text: string, extra: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    sessionId: `chat-${senderId}`,
    senderId,
    text,
    messageId: `m-${++msgSeq}`,
    messageType: 'text',
    ...extra,
  };
}

function cleanup(f: Fixture): void {
  fs.rmSync(f.tmp, { recursive: true, force: true });
}

async function main(): Promise<void> {
  // typing 回执降级等路径会 console.warn，测试期间静音
  const origWarn = console.warn;
  console.warn = () => {};

  const llm = new FakeLlmServer();
  await llm.start();

  try {
    // ---------- 非文字消息 / 空文本：即时回复，不进入队列 ----------
    await checkAsync('handler：非文字消息与空文本即时拒答', async () => {
      const f = setup(llm.baseUrl);
      await f.handlers.handle(mkMsg('u1', '', { messageType: 'image' }));
      await f.handlers.handle(mkMsg('u1', '   '));
      assert.equal(f.channel.replies.length, 2);
      assert.ok(f.channel.replies[0]!.text.includes('暂只支持文字消息'));
      assert.ok(f.channel.replies[1]!.text.includes('请发送文字内容'));
      cleanup(f);
    });

    // ---------- /help ----------
    await checkAsync('handler：/help 回复帮助文本', async () => {
      const f = setup(llm.baseUrl);
      await f.handlers.handle(mkMsg('u1', '/help'));
      assert.deepEqual(f.channel.replies.map((r) => r.text), ['HELP-TEXT']);
      cleanup(f);
    });

    // ---------- 无 pending 时确认词兜底 ----------
    await checkAsync('handler：无 pending 确认时回复确认词给出兜底提示', async () => {
      const f = setup(llm.baseUrl);
      await f.handlers.handle(mkMsg('u1', '确认'));
      await f.handlers.handle(mkMsg('u1', '取消'));
      assert.equal(f.channel.replies.length, 2);
      for (const r of f.channel.replies) {
        assert.ok(r.text.includes('当前没有待确认的写操作'), `应给兜底提示，实际：${r.text}`);
      }
      cleanup(f);
    });

    // ---------- 有 pending 时确认词路由（批准 / 同类免问 / 取消） ----------
    await checkAsync('handler：确认词路由到挂起的写操作闸门', async () => {
      const f = setup(llm.baseUrl);
      const req: ConfirmRequest = { kind: 'kanban', summary: '创建任务', detail: 'create_task x', batchKey: 'create' };
      const v1 = f.confirmations.request('u1', req);
      await f.handlers.handle(mkMsg('u1', '确认'));
      assert.equal(await v1, 'once');
      assert.ok(f.channel.replies.at(-1)!.text.includes('✅ 已批准，正在执行'));

      const v2 = f.confirmations.request('u1', req);
      await f.handlers.handle(mkMsg('u1', '同类免问'));
      assert.equal(await v2, 'batch');
      assert.ok(f.channel.replies.at(-1)!.text.includes('同类写操作 10 分钟内免问'));

      const v3 = f.confirmations.request('u1', req);
      await f.handlers.handle(mkMsg('u1', '取消'));
      assert.equal(await v3, false);
      assert.ok(f.channel.replies.at(-1)!.text.includes('已取消，操作未执行'));
      cleanup(f);
    });

    // ---------- pending 期间普通消息：即时 ⚠️ 回执并排队照跑 ----------
    await checkAsync('handler：pending 期间普通消息给出确认卡片提醒并排入队列', async () => {
      const f = setup(llm.baseUrl);
      const req: ConfirmRequest = { kind: 'kanban', summary: '更新任务', detail: 'update_task x', batchKey: 'update' };
      const verdict = f.confirmations.request('u1', req);
      const p = f.handlers.handle(mkMsg('u1', '顺便帮我看看进度'));
      await waitFor(
        () => f.channel.replies.some((r) => r.text.includes('有未处理的写操作确认卡片')),
        'pending 排队回执',
      );
      // 确认应答不进队列，立即裁决
      await f.handlers.handle(mkMsg('u1', '确认'));
      assert.equal(await verdict, 'once');
      await p; // 排队消息在 LLM ok 下正常跑完
      assert.ok(f.channel.updated.includes('好的，已收到'), '排队消息应得到最终回复');
      cleanup(f);
    });

    // ---------- 未知命令（走串行队列，无需 LLM） ----------
    await checkAsync('handler：未知命令提示 /help', async () => {
      const f = setup(llm.baseUrl);
      await f.handlers.handle(mkMsg('u1', '/foobar'));
      assert.ok(f.channel.replies.some((r) => r.text.includes('未知命令 /foobar')));
      cleanup(f);
    });

    // ---------- 消息排队：同用户串行执行 + 排队回执 ----------
    await checkAsync('handler：同用户消息严格串行，后到消息先给排队回执', async () => {
      const f = setup(llm.baseUrl);
      llm.mode = 'hang';
      const base = llm.requestCount; // 计数跨用例累计，取基线
      const pA = f.handlers.handle(mkMsg('u1', '第一条'));
      await waitFor(() => llm.requestCount === base + 1, '第一条进入 LLM');
      const pB = f.handlers.handle(mkMsg('u1', '第二条'));
      await waitFor(
        () => f.channel.replies.some((r) => r.text.includes('已收到并排队')),
        '第二条排队回执',
      );
      assert.equal(llm.requestCount, base + 1, '第一条未完成前第二条不得进入 LLM');
      llm.mode = 'ok';
      llm.release();
      await Promise.all([pA, pB]);
      assert.equal(llm.requestCount, base + 2, '第一条完成后第二条才执行');
      assert.equal(
        f.channel.updated.filter((t) => t === '好的，已收到').length,
        2,
        '两条消息都应得到最终回复',
      );
      cleanup(f);
    });

    // ---------- /stop 中断当前轮次 ----------
    await checkAsync('handler：/stop 中断正在执行的轮次', async () => {
      const f = setup(llm.baseUrl);
      llm.mode = 'hang';
      const base = llm.requestCount; // 计数跨用例累计，取基线
      const pA = f.handlers.handle(mkMsg('u1', '来个长任务'));
      await waitFor(() => llm.requestCount === base + 1, '任务进入 LLM');
      await f.handlers.handle(mkMsg('u1', '/stop'));
      assert.ok(
        f.channel.replies.some((r) => r.text.includes('已中断当前任务')),
        '/stop 应回复已中断当前任务',
      );
      await pA;
      assert.ok(
        f.channel.replies.some((r) => r.text === '⏹ 已中断。'),
        '被中断的消息应收到中断回执',
      );
      assert.equal(llm.requestCount, base + 1, '中断后不得再发起 LLM 请求');
      llm.release();
      cleanup(f);
    });

    // ---------- /stop 丢弃排队消息 + typing 回执兜底清理 ----------
    await checkAsync('handler：/stop 丢弃排队消息并兜底清理其敲键盘表情', async () => {
      const f = setup(llm.baseUrl);
      llm.mode = 'hang';
      const base = llm.requestCount; // 计数跨用例累计，取基线
      const msgA = mkMsg('u1', '任务A');
      const pA = f.handlers.handle(msgA);
      await waitFor(() => llm.requestCount === base + 1, '任务A 进入 LLM');
      const msgB = mkMsg('u1', '任务B');
      const pB = f.handlers.handle(msgB);
      await waitFor(
        () => f.channel.addedReactions.includes(msgB.messageId),
        '任务B 排队回执与 typing 表情',
      );
      await f.handlers.handle(mkMsg('u1', '/stop'));
      const stopReply = f.channel.replies.map((r) => r.text).join('\n');
      assert.ok(stopReply.includes('已中断当前任务'), '应中断当前任务');
      assert.ok(stopReply.includes('已丢弃 1 条排队消息'), `应丢弃 1 条排队消息，实际：${stopReply}`);
      // 被丢弃的消息不会执行回调，其 typing 表情由 /stop 兜底移除（含正在中断的 A）
      assert.ok(f.channel.removedReactions.includes(msgB.messageId), '任务B 的 typing 表情应被兜底移除');
      assert.ok(f.channel.removedReactions.includes(msgA.messageId), '任务A 的 typing 表情应被兜底移除');
      llm.mode = 'ok';
      llm.release();
      await Promise.all([pA, pB]);
      assert.equal(llm.requestCount, base + 1, '被丢弃的排队消息不得执行（不发 LLM 请求）');
      assert.ok(!f.channel.updated.includes('好的，已收到'), '被丢弃的消息不得产生最终回复');
      cleanup(f);
    });

    // ---------- /stop 空闲时 ----------
    await checkAsync('handler：空闲时 /stop 提示无任务', async () => {
      const f = setup(llm.baseUrl);
      await f.handlers.handle(mkMsg('u1', '/stop'));
      assert.deepEqual(f.channel.replies.map((r) => r.text), ['当前没有正在执行的任务。']);
      cleanup(f);
    });

    // ---------- typing 回执失败降级：不再重试，消息照常处理 ----------
    await checkAsync('handler：敲键盘表情不可用时降级为静默，不再重试', async () => {
      const f = setup(llm.baseUrl);
      f.channel.failReactions = true;
      await f.handlers.handle(mkMsg('u1', '/clear'));
      await f.handlers.handle(mkMsg('u1', '/clear'));
      assert.equal(f.channel.addReactionCalls, 1, '首次失败后不应再尝试加表情');
      assert.equal(
        f.channel.replies.filter((r) => r.text === CLEARED_TEXT).length,
        2,
        '消息本身应照常处理',
      );
      cleanup(f);
    });

    // ---------- 卡片回调：白名单外静默忽略，未知 id 兜底，有效 id 裁决 ----------
    await checkAsync('handler：卡片回调白名单与确认裁决', async () => {
      const f = setup(llm.baseUrl);
      // 无 hta_confirm / hta_review 的回调不属于本机器人，静默忽略
      f.handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: {} } });
      f.handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { decision: 'yes' } } });
      f.handlers.onCardAction({ action: { value: { hta_confirm: 'x', decision: 'yes' } } }); // 无 operator
      assert.equal(f.channel.notifies.length, 0, '白名单外回调不得有任何出站消息');
      // 未知 / 已过期的确认 id
      f.handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { hta_confirm: 'deadbeef', decision: 'yes' } } });
      assert.ok(f.channel.notifies.at(-1)!.text.includes('该确认已处理或已过期'));
      // 有效确认 id → 裁决放行
      const req: ConfirmRequest = { kind: 'kanban', summary: '创建任务', detail: 'create_task x', batchKey: 'create' };
      const verdict = f.confirmations.request('u1', req);
      await waitFor(() => f.confirmPrompts.length === 1, '确认卡片已发出');
      const id = f.confirmPrompts[0]!.id;
      const action: FeishuCardAction = { operator: { open_id: 'u1' }, action: { value: { hta_confirm: id, decision: 'yes' } } };
      f.handlers.onCardAction(action);
      assert.equal(await verdict, 'once');
      assert.ok(f.channel.notifies.at(-1)!.text.includes('✅ 已批准，正在执行'));
      cleanup(f);
    });
  } finally {
    await llm.stop();
    console.warn = origWarn;
  }

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
