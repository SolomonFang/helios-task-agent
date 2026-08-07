// Handler 单元测试：fake channel（记录出站消息）+ 真实 SessionRouter / ConfirmationManager，
// LLM 走本地 loopback 假服务（可控挂起/放行），不触飞书 SDK 网络层。Run: npx tsx scripts/unit-handler.ts

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { createBotHandlers, MAX_USER_MESSAGE_CHARS, type BotHandlers } from '../src/bot/handler';
import type { FeishuCardAction, FeishuChannel, FeishuInboundMessage } from '../src/channels/feishu';
import { SessionRouter } from '../src/session-router';
import { ConfirmationManager } from '../src/confirm';
import { MemoryStore } from '../src/memory';
import { McpSupervisor } from '../src/bot/supervisor';
import { CLEARED_TEXT } from '../src/commands';
import type { ConfirmRequest } from '../src/guard';
import type { AgentConfig, InboundMessage } from '../src/types';
import type { KanbanMcp } from '../src/kanban/mcp';
import { redactSnippet } from '../src/audit';
import { checkAsync, finish } from './testkit';

/** 轮询等待条件成立（队列与 LLM 请求均为异步），超时抛错。 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// --- fake channel：实现 handler 实际用到的 FeishuChannel 方法子集，记录全部出站消息 ---

/**
 * handler 实际依赖的 FeishuChannel 最小接口：FakeChannel 显式 implements，
 * FeishuChannel 删掉其中任一方法时 tsc 会在此处报错（接口漂移受类型检查保护）。
 */
type ChannelUnderTest = Pick<
  FeishuChannel,
  | 'name'
  | 'reply'
  | 'sendText'
  | 'updateText'
  | 'addReaction'
  | 'removeReaction'
  | 'notifyOpenId'
  | 'notifyCardOpenId'
  | 'lastEventAt'
  | 'connectionState'
>;

class FakeChannel implements ChannelUnderTest {
  // FeishuChannel.name 是字面量类型 'feishu'；fake 仅满足类型面，值不参与任何断言
  readonly name = 'feishu';
  replies: { sessionId: string; text: string }[] = [];
  sent: string[] = [];
  updated: string[] = [];
  notifies: { openId: string; text: string }[] = [];
  addedReactions: string[] = [];
  removedReactions: string[] = [];
  addReactionCalls = 0;
  /** 模拟表情回执失败（addReaction 抛错）。 */
  failReactions = false;
  /** 失败时的错误文案：权限类（永久性）或网络类（瞬时）。 */
  reactionError = 'no reaction permission';
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
    if (this.failReactions) throw new Error(this.reactionError);
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

function setup(llmBaseUrl: string, kanbanUrl = 'http://localhost:1'): Fixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-handler-'));
  const cfg: AgentConfig = {
    llmBaseUrl,
    llmApiKey: 'sk-x',
    llmModel: 'm',
    mcpCommand: 'npx',
    mcpArgs: [],
    kanbanUrl,
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
  // fake MCP：handler/supervisor 实际依赖的最小接口（tools 列表 + 健康探测），同样受类型检查保护；
  // 两处强转各自只做一次收窄（私有字段导致无法直接赋值）。
  const fakeMcpTyped: Pick<KanbanMcp, 'tools' | 'ping' | 'reconnect'> = {
    tools: [],
    async ping() {},
    async reconnect() {},
  };
  const fakeMcp = fakeMcpTyped as unknown as KanbanMcp;
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

    // ---------- 消息长度上限：超限直接拒答，不排队不送 LLM ----------
    await checkAsync('handler：超长消息直接拒答，不进入队列与 LLM', async () => {
      const f = setup(llm.baseUrl);
      const base = llm.requestCount; // 计数跨用例累计，取基线
      await f.handlers.handle(mkMsg('u1', '长'.repeat(MAX_USER_MESSAGE_CHARS + 1)));
      assert.ok(
        f.channel.replies.some((r) => r.text.includes('太长了') && r.text.includes(String(MAX_USER_MESSAGE_CHARS))),
        '超限应提示长度上限',
      );
      assert.equal(llm.requestCount, base, '超长消息不得发 LLM 请求');
      // 边界：恰好上限的消息正常处理
      await f.handlers.handle(mkMsg('u1', '长'.repeat(MAX_USER_MESSAGE_CHARS)));
      await waitFor(() => llm.requestCount === base + 1, '上限内消息进入 LLM');
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
      assert.ok(f.channel.replies.at(-1)!.text.includes('同类写操作本会话内免问'));

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

    // ---------- typing 回执瞬时错误：不永久禁用，下条消息重试 ----------
    await checkAsync('handler：敲键盘表情瞬时错误（限流/网络）下条消息重试', async () => {
      const f = setup(llm.baseUrl);
      f.channel.failReactions = true;
      f.channel.reactionError = '飞书添加表情回复失败: code=99991400 msg=network timeout';
      await f.handlers.handle(mkMsg('u1', '/clear'));
      await f.handlers.handle(mkMsg('u1', '/clear'));
      assert.equal(f.channel.addReactionCalls, 2, '瞬时错误后下条消息应重试加表情');
      f.channel.reactionError = 'no reaction permission'; // 永久性错误：此后禁用
      await f.handlers.handle(mkMsg('u1', '/clear'));
      await f.handlers.handle(mkMsg('u1', '/clear'));
      assert.equal(f.channel.addReactionCalls, 3, '永久性错误后不再重试');
      cleanup(f);
    });

    // ---------- 排队上限：满员拒收并提示 ----------
    await checkAsync('handler：排队满 20 条后拒收并提示「排队消息已满」', async () => {
      const f = setup(llm.baseUrl);
      llm.mode = 'hang';
      const base = llm.requestCount; // 计数跨用例累计，取基线
      const pA = f.handlers.handle(mkMsg('u1', '长任务'));
      await waitFor(() => llm.requestCount === base + 1, '长任务进入 LLM');
      const queued: Promise<void>[] = [];
      for (let i = 0; i < 20; i++) queued.push(f.handlers.handle(mkMsg('u1', `排队${i}`)));
      await waitFor(() => f.router.queuedCount('u1') === 20, '20 条排队');
      await f.handlers.handle(mkMsg('u1', '第 21 条'));
      assert.ok(
        f.channel.replies.some((r) => r.text.includes('排队消息已满')),
        '满员后应提示排队消息已满',
      );
      assert.equal(f.router.queuedCount('u1'), 20, '满员后不再入队');
      await f.handlers.handle(mkMsg('u1', '/stop')); // 清场：中断长任务并丢弃排队
      llm.mode = 'ok';
      llm.release();
      await Promise.all([pA, ...queued]);
      cleanup(f);
    });

    // ---------- AI 审查：全局并发上限（最多 2 个），超出提示稍后再试 ----------
    await checkAsync('handler：AI 审查全局并发上限，第三个被拒并提示', async () => {
      // 假看板：响应头给出后永不结束 body，让 resolveReviewTarget 的 apiGet 挂起（审查进行中）
      const kanban = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"success":true,"data":');
      });
      await new Promise<void>((r) => kanban.listen(0, '127.0.0.1', r));
      const kbUrl = `http://127.0.0.1:${(kanban.address() as AddressInfo).port}`;
      const f = setup(llm.baseUrl, kbUrl);
      const click = (attempt: string) =>
        f.handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { hta_review: attempt, title: attempt } } });
      click('a1');
      click('a2');
      await waitFor(
        () => f.channel.notifies.filter((n) => n.text.includes('AI 审查已开始')).length === 2,
        '两个审查进入进行中',
      );
      click('a3'); // 第三个（不同 attempt）：并发上限拒收
      await waitFor(
        () => f.channel.notifies.some((n) => n.text.includes('已达上限')),
        '并发上限提示',
      );
      click('a1'); // 同 attempt 连点：仍走去重提示
      await waitFor(
        () => f.channel.notifies.some((n) => n.text.includes('正在进行中')),
        'attempt 去重提示',
      );
      // 收尾：断开假看板连接，两个挂起的审查以失败结束（不拖累进程退出）
      kanban.closeAllConnections?.();
      await new Promise((r) => kanban.close(r));
      await waitFor(
        () => f.channel.notifies.filter((n) => n.text.includes('AI 审查失败')).length === 2,
        '挂起审查收尾',
      );
      cleanup(f);
    });

    // ---------- AI 审查：/stop 可中断（卡片回调触发的审查在串行队列外运行） ----------
    await checkAsync('handler：/stop 中断进行中的 AI 审查', async () => {
      // 假看板：响应头给出后永不结束 body，让 resolveReviewTarget 的 apiGet 挂起（审查进行中）
      const kanban = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"success":true,"data":');
      });
      await new Promise<void>((r) => kanban.listen(0, '127.0.0.1', r));
      const kbUrl = `http://127.0.0.1:${(kanban.address() as AddressInfo).port}`;
      const f = setup(llm.baseUrl, kbUrl);
      try {
        f.handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { hta_review: 'a1', title: 'a1' } } });
        await waitFor(
          () => f.channel.notifies.some((n) => n.text.includes('AI 审查已开始')),
          '审查进入进行中',
        );
        await f.handlers.handle(mkMsg('u1', '/stop'));
        assert.ok(
          f.channel.replies.some((r) => r.text.includes('已中断 1 个 AI 审查')),
          `/stop 应报告中断 AI 审查，实际：${f.channel.replies.map((r) => r.text).join(' | ')}`,
        );
        await waitFor(
          () => f.channel.notifies.some((n) => n.text.includes('AI 审查已中断')),
          '审查中断回执',
        );
        assert.ok(
          !f.channel.notifies.some((n) => n.text.includes('AI 审查失败')),
          '被中断的审查不应再报「审查失败」',
        );
      } finally {
        // 收尾：断开假看板连接，孤儿 runAiReview 以失败结束（race 已挂反应，不成未处理 rejection）
        kanban.closeAllConnections?.();
        await new Promise((r) => kanban.close(r));
        cleanup(f);
      }
    });

    // ---------- 卡片回调：非本机器人 payload / 无操作者静默忽略，未知 id 兜底，有效 id 裁决 ----------
    // （open_id 白名单在 feishu.ts WS 层，由 unit-feishu-filter.ts 覆盖；本用例测 handler 层入口过滤）
    await checkAsync('handler：卡片回调入口过滤（非本机器人/无操作者）与确认裁决', async () => {
      const f = setup(llm.baseUrl);
      // 无 hta_confirm / hta_review 的回调不属于本机器人，静默忽略
      f.handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: {} } });
      f.handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { decision: 'yes' } } });
      f.handlers.onCardAction({ action: { value: { hta_confirm: 'x', decision: 'yes' } } }); // 无 operator
      assert.equal(f.channel.notifies.length, 0, '非本机器人/无操作者回调不得有任何出站消息');
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

    // ---------- 审计脱敏：写操作 resultSnippet 中的密钥字段不落盘 ----------
    await checkAsync('audit：redactSnippet 替换 token/密钥字段与 Bearer 头', async () => {
      const json = redactSnippet('{"access_token":"abc123","password": "p@ss","title":"普通内容"}');
      assert.ok(json.includes('"access_token":"***"') && json.includes('"password": "***"'), `JSON 密钥值应替换为 ***，实际：${json}`);
      assert.ok(!json.includes('abc123') && !json.includes('p@ss'), '原密钥值不得残留');
      assert.ok(json.includes('普通内容'), '非敏感内容应保持不变');
      const bearer = redactSnippet('请求失败 Authorization: Bearer sk-live-abcdef 重试');
      assert.ok(bearer.includes('Bearer ***') && !bearer.includes('sk-live-abcdef'), `Bearer 头应脱敏，实际：${bearer}`);
    });
  } finally {
    await llm.stop();
    console.warn = origWarn;
  }

  finish();
}

void main();
