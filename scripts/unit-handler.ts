// Handler 单元测试：fake channel（记录出站消息）+ 真实 SessionRouter / ConfirmationManager，
// LLM 走本地 loopback 假服务（可控挂起/放行），不触飞书 SDK 网络层。Run: npx tsx scripts/unit-handler.ts

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { createBotHandlers, MAX_IMAGE_BYTES, MAX_USER_MESSAGE_CHARS, type BotHandlerDeps, type BotHandlers } from '../src/bot/handler';
import type { FeishuCardAction, FeishuChannel, FeishuInboundMessage } from '../src/channels/feishu';
import { SessionRouter } from '../src/agent/session-router';
import { ConfirmationManager } from '../src/agent/confirm';
import { MemoryStore } from '../src/agent/memory';
import { McpSupervisor } from '../src/bot/supervisor';
import { CLEARED_TEXT } from '../src/commands';
import { withBatchApproval, type ConfirmRequest } from '../src/agent/guard';
import type { AgentConfig, InboundMessage } from '../src/types';
import type { KanbanMcp } from '../src/kanban/mcp';
import { redactSnippet } from '../src/infra/audit';
import { checkAsync, finish } from './testkit';

/** 轮询等待条件成立（队列与 LLM 请求均为异步），超时抛错。上限放宽到 10s，避免 CI 高负载下误判超时。 */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 10000): Promise<void> {
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
  cards: { openId: string; card: Record<string, unknown> }[] = [];
  addedReactions: string[] = [];
  removedReactions: string[] = [];
  addReactionCalls = 0;
  /** 模拟表情回执失败（addReaction 抛错）。 */
  failReactions = false;
  /** 失败时的错误文案：权限类（永久性）或网络类（瞬时）。 */
  reactionError = 'no reaction permission';
  /** 模拟卡片推送失败（notifyCardOpenId 抛错）。 */
  failCard = false;
  /** 模拟 sendText / updateText 按内容选择性失败（命中子串即抛错，占位/进度文案不受影响）。 */
  failSendIfIncludes: string | null = null;
  failUpdateIfIncludes: string | null = null;
  private reactionSeq = 0;
  private messageSeq = 0;

  async reply(msg: InboundMessage, text: string): Promise<void> {
    this.replies.push({ sessionId: msg.sessionId, text });
  }
  async sendText(_chatId: string, text: string): Promise<string | undefined> {
    if (this.failSendIfIncludes && text.includes(this.failSendIfIncludes)) throw new Error('sendText mock failure');
    this.sent.push(text);
    return `ph-${++this.messageSeq}`;
  }
  async updateText(_messageId: string, text: string): Promise<void> {
    if (this.failUpdateIfIncludes && text.includes(this.failUpdateIfIncludes)) throw new Error('updateText mock failure');
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
  async notifyCardOpenId(openId: string, card: Record<string, unknown>): Promise<void> {
    if (this.failCard) throw new Error('card mock failure');
    this.cards.push({ openId, card });
  }
  lastEventAt(): number {
    return 0;
  }
  connectionState(): null {
    return null;
  }
}

// --- fake LLM 服务：ok 模式立即回固定补全；hang 模式挂起直到 release()（或被 /stop 中断） ---

class FakeLlmServer {
  readonly server: http.Server;
  requestCount = 0;
  mode: 'ok' | 'hang' = 'ok';
  baseUrl = '';
  /** ok 模式返回的 assistant 文本（deliverReply 分段测试会换成超长回复）。 */
  replyText = '好的，已收到';
  /** 收到的请求体（JSON 解析结果，解析失败为 null）：多模态 content 断言用。 */
  bodies: unknown[] = [];
  private hanging: http.ServerResponse[] = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.requestCount++;
        try {
          this.bodies.push(JSON.parse(body));
        } catch {
          this.bodies.push(null);
        }
        if (this.mode === 'hang') this.hanging.push(res);
        else this.respondOk(res);
      });
    });
  }

  private respondOk(res: http.ServerResponse): void {
    try {
      if (res.destroyed || res.writableEnded) return; // 客户端已中断（/stop）
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'cmpl-fake',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [{ index: 0, message: { role: 'assistant', content: this.replyText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    } catch {
      /* 连接已被 abort 销毁 */
    }
  }

  /** 放行所有挂起的请求。 */
  release(): void {
    const pending = this.hanging.splice(0);
    for (const res of pending) this.respondOk(res);
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

function setup(
  llmBaseUrl: string,
  kanbanUrl = 'http://localhost:1',
  extra: Partial<Pick<BotHandlerDeps, 'reportServer' | 'aiReviewRunner' | 'progressHeartbeatMs' | 'imageFetcher'>> & {
    visionEnabled?: boolean;
  } = {},
): Fixture {
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
  if (extra.visionEnabled) cfg.visionEnabled = true;
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
    reportServer: extra.reportServer ?? null,
    helpText: 'HELP-TEXT',
    ...(extra.aiReviewRunner ? { aiReviewRunner: extra.aiReviewRunner } : {}),
    ...(extra.progressHeartbeatMs ? { progressHeartbeatMs: extra.progressHeartbeatMs } : {}),
    ...(extra.imageFetcher ? { imageFetcher: extra.imageFetcher } : {}),
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

    // ---------- vision 开关关闭：image 消息（含 image_key）仍按非文字消息拒答 ----------
    await checkAsync('handler：vision 未开启时 image 消息仍拒答，行为与文案不变', async () => {
      const f = setup(llm.baseUrl);
      const base = llm.requestCount; // 计数跨用例累计，取基线
      await f.handlers.handle(mkMsg('u1', '', { messageType: 'image', imageKey: 'img_off' }));
      assert.deepEqual(f.channel.replies.map((r) => r.text), [
        '暂只支持文字消息：图片/文件等内容，请把关键信息打字或粘贴成文字发给我。',
      ]);
      assert.equal(llm.requestCount, base, '未开启 vision 不得发 LLM 请求');
      cleanup(f);
    });

    // ---------- vision 开启：图片下载并以多模态 content 送入 LLM，历史仅存文本占位 ----------
    await checkAsync('handler：vision 开启时图片以 image_url 送入 LLM，后续请求不再携带 base64', async () => {
      const raw = Buffer.from('fake-image-bytes');
      const f = setup(llm.baseUrl, undefined, {
        visionEnabled: true,
        imageFetcher: async () => ({ data: raw, mimeType: 'image/png' }),
      });
      const base = llm.requestCount; // 计数跨用例累计，取基线
      const bodyBase = llm.bodies.length;
      await f.handlers.handle(mkMsg('u1', '', { messageType: 'image', imageKey: 'img_1' }));
      assert.equal(llm.requestCount, base + 1, '图片消息应产生一次 LLM 请求');
      // 首个请求：末尾 user 消息为多模态 content 数组（image_url + text 默认提示）
      const body = llm.bodies[bodyBase] as { messages: { role: string; content: unknown }[] };
      const last = body.messages.at(-1)!;
      assert.equal(last.role, 'user');
      const content = last.content as { type: string; image_url?: { url: string }; text?: string }[];
      assert.ok(Array.isArray(content), 'user content 应为多模态数组');
      assert.equal(content[0]!.type, 'image_url');
      assert.equal(
        content[0]!.image_url!.url,
        `data:image/png;base64,${raw.toString('base64')}`,
        'image_url 应为下载字节的 base64 data URL',
      );
      assert.equal(content[1]!.type, 'text');
      assert.ok(content[1]!.text, '无配文时应给默认提示文本');
      // 走既有占位/进度链路：最终回复替换占位消息
      assert.ok(f.channel.updated.includes('好的，已收到'), '应经占位消息链路投递最终回复');
      // 会话历史不存图片：后续请求中该轮为「[图片]」文本占位，且不再携带 base64
      await f.handlers.handle(mkMsg('u1', '继续'));
      const body2 = llm.bodies.at(-1) as { messages: { role: string; content: unknown }[] };
      assert.ok(
        body2.messages.some((m) => typeof m.content === 'string' && m.content.includes('[图片]')),
        '历史应含 [图片] 文本占位',
      );
      assert.ok(
        !JSON.stringify(body2).includes(raw.toString('base64')),
        '后续请求不得再携带图片 base64',
      );
      cleanup(f);
    });

    // ---------- vision 开启：超过 10MB 的图片直接拒答，不送 LLM ----------
    await checkAsync('handler：超过大小上限的图片直接拒答，不送 LLM', async () => {
      const f = setup(llm.baseUrl, undefined, {
        visionEnabled: true,
        imageFetcher: async () => ({ data: Buffer.alloc(MAX_IMAGE_BYTES + 1), mimeType: 'image/png' }),
      });
      const base = llm.requestCount; // 计数跨用例累计，取基线
      await f.handlers.handle(mkMsg('u1', '', { messageType: 'image', imageKey: 'img_big' }));
      assert.ok(
        f.channel.replies.some((r) => r.text.includes('图片太大了')),
        `超限应提示图片太大，实际：${f.channel.replies.map((r) => r.text).join(' | ')}`,
      );
      assert.equal(llm.requestCount, base, '超限图片不得发 LLM 请求');
      cleanup(f);
    });

    // ---------- vision 开启：下载失败给友好中文提示，不外抛敏感细节 ----------
    await checkAsync('handler：图片下载失败回复友好提示，不外抛内部错误', async () => {
      const f = setup(llm.baseUrl, undefined, {
        visionEnabled: true,
        imageFetcher: async () => {
          throw new Error('sdk internal: connect ECONNREFUSED 10.0.0.1:443');
        },
      });
      const base = llm.requestCount; // 计数跨用例累计，取基线
      const origErr = console.error;
      console.error = () => {}; // 下载失败会记日志，测试期间静音
      try {
        await f.handlers.handle(mkMsg('u1', '', { messageType: 'image', imageKey: 'img_fail' }));
      } finally {
        console.error = origErr;
      }
      const reply = f.channel.replies.at(-1)!.text;
      assert.ok(reply.includes('图片下载失败'), `应给友好提示，实际：${reply}`);
      assert.ok(!reply.includes('ECONNREFUSED'), '不得外抛内部错误细节');
      assert.equal(llm.requestCount, base, '下载失败不得发 LLM 请求');
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

    // ---------- 静默期心跳：LLM 长思考时占位消息定时刷新，回复就绪即停 ----------
    await checkAsync('handler：静默期心跳刷新占位消息，回复就绪后停止', async () => {
      const f = setup(llm.baseUrl, undefined, { progressHeartbeatMs: 40 });
      llm.mode = 'hang';
      const base = llm.requestCount; // 计数跨用例累计，取基线
      const p = f.handlers.handle(mkMsg('u1', '想一会儿再回答'));
      await waitFor(() => llm.requestCount === base + 1, '消息进入 LLM');
      await waitFor(
        () => f.channel.updated.some((t) => t.includes('仍在处理')),
        '静默期心跳刷新占位消息',
      );
      llm.mode = 'ok';
      llm.release();
      await p;
      assert.ok(f.channel.updated.includes('好的，已收到'), '最终回复应替换占位消息');
      const settled = f.channel.updated.length;
      await new Promise((r) => setTimeout(r, 150)); // 等若干个心跳周期
      assert.equal(f.channel.updated.length, settled, '回复就绪后心跳应停止，不再刷新占位');
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

    // ---------- /confirm revoke：完整文本判定（parseCommand 只取首分词，cmd 恒为 '/confirm'） ----------
    await checkAsync('handler：/confirm revoke 真正撤销「同类免问」（而非只打印状态）', async () => {
      const f = setup(llm.baseUrl);
      // 用真实 withBatchApproval 装配一个生效中的 batch 授权（直接喂 verdict='batch'）
      const session = f.router.getOrCreate('u1') as unknown as {
        batchedConfirm?: ReturnType<typeof withBatchApproval>;
        activeBatchApprovals(): number;
      };
      session.batchedConfirm = withBatchApproval(async () => 'batch');
      await session.batchedConfirm({ kind: 'kanban', summary: '创建任务', detail: 'create_task x', batchKey: 'create' });
      assert.equal(session.activeBatchApprovals(), 1);
      await f.handlers.handle(mkMsg('u1', '/confirm revoke'));
      const reply = f.channel.replies.at(-1)!.text;
      assert.ok(reply.includes('已恢复逐次确认') && reply.includes('撤销 1 类'), `应撤销 1 类免问，实际：${reply}`);
      assert.equal(session.activeBatchApprovals(), 0, '免问授权应已被撤销');
      cleanup(f);
    });

    await checkAsync('handler：/confirm revoke 无免问时给撤销兜底文案，/confirm 仍打印状态', async () => {
      const f = setup(llm.baseUrl);
      await f.handlers.handle(mkMsg('u1', '/confirm revoke'));
      assert.ok(
        f.channel.replies.at(-1)!.text.includes('无需撤销'),
        `撤销分支应给兜底文案，实际：${f.channel.replies.at(-1)!.text}`,
      );
      await f.handlers.handle(mkMsg('u1', '/confirm'));
      assert.ok(
        f.channel.replies.at(-1)!.text.includes('写操作逐次确认'),
        `查询分支应打印状态，实际：${f.channel.replies.at(-1)!.text}`,
      );
      cleanup(f);
    });

    // ---------- deliverReply：超长回复分段续发，一段失败不丢后续段 ----------
    await checkAsync('handler：回复分段续发时一段失败记日志继续，后续段不丢', async () => {
      const f = setup(llm.baseUrl);
      const origErr = console.error;
      const errLogs: string[] = [];
      console.error = (...args: unknown[]) => errLogs.push(args.map(String).join(' '));
      try {
        llm.replyText = `${'A'.repeat(2000)}\n\n${'B'.repeat(2000)}\n\n${'C'.repeat(2000)}`;
        f.channel.failSendIfIncludes = 'BBB'; // 第二段续发失败
        await f.handlers.handle(mkMsg('u1', '给我长回复'));
        assert.ok(f.channel.updated.some((t) => t.includes('AAA')), '首段应替换占位消息');
        assert.ok(!f.channel.sent.some((t) => t.includes('BBB')), '失败段不应出现');
        assert.ok(f.channel.sent.some((t) => t.includes('CCC')), '失败段之后的分段仍应送达');
        assert.ok(errLogs.some((m) => m.includes('续发分段失败')), '分段失败应记日志');
        assert.ok(!f.channel.updated.some((t) => t.includes('回复投递失败')), '首段成功不应报投递失败');
      } finally {
        console.error = origErr;
        llm.replyText = '好的，已收到';
        cleanup(f);
      }
    });

    await checkAsync('handler：首段更新与直发都失败时占位消息更新为「回复投递失败」', async () => {
      const f = setup(llm.baseUrl);
      const origErr = console.error;
      console.error = () => {};
      try {
        llm.replyText = `${'A'.repeat(2000)}\n\n${'B'.repeat(2000)}`;
        f.channel.failUpdateIfIncludes = 'AAA'; // 首段更新失败（进度更新文案不含 AAA，不受影响）
        f.channel.failSendIfIncludes = 'AAA'; // 首段直发降级也失败
        await f.handlers.handle(mkMsg('u1', '给我长回复'));
        assert.ok(
          f.channel.updated.some((t) => t.includes('回复投递失败')),
          '首段彻底失败应把占位更新为投递失败提示',
        );
        assert.ok(f.channel.sent.some((t) => t.includes('BBB')), '续发段仍应送达');
      } finally {
        console.error = origErr;
        llm.replyText = '好的，已收到';
        cleanup(f);
      }
    });

    // ---------- AI 审查：投递段（报告写盘/卡片推送）失败降级文本，不误报「AI 审查失败」 ----------
    await checkAsync('handler：AI 审查卡片推送失败时降级文本推送审查结果', async () => {
      // writeReviewReport 会真实落盘：数据目录指向临时目录，不污染真实用户目录
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-handler-home-'));
      process.env.HELIOS_TASK_AGENT_HOME = home;
      const origErr = console.error;
      const errLogs: string[] = [];
      console.error = (...args: unknown[]) => errLogs.push(args.map(String).join(' '));
      try {
        const f = setup(llm.baseUrl, 'http://localhost:1', {
          reportServer: { baseUrl: 'http://report.local', close: () => {}, server: http.createServer() },
          aiReviewRunner: async () => '审查结论：无问题',
        });
        f.channel.failCard = true; // 卡片推送失败
        f.handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { hta_review: 'a9', title: '任务X' } } });
        await waitFor(() => f.channel.notifies.some((n) => n.text.includes('改为文本推送')), '降级文本推送');
        const degraded = f.channel.notifies.find((n) => n.text.includes('改为文本推送'))!;
        assert.ok(degraded.text.includes('AI 审查结果'), '降级推送应带审查结果');
        assert.ok(degraded.text.includes('审查结论：无问题'), '审查结果本身不得丢失');
        assert.ok(degraded.text.includes('card mock failure'), '应注明卡片失败原因');
        assert.ok(
          !f.channel.notifies.some((n) => n.text.includes('AI 审查失败')),
          '投递失败不得误报为「AI 审查失败」',
        );
        assert.ok(errLogs.some((m) => m.includes('报告写盘/卡片推送失败')), '投递失败应记日志');
        cleanup(f);
      } finally {
        console.error = origErr;
        delete process.env.HELIOS_TASK_AGENT_HOME;
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    // ---------- confirm：超时定时器 unref（不应成为保活理由） ----------
    await checkAsync('confirm：确认超时定时器已 unref，不阻止进程退出', async () => {
      const mgr = new ConfirmationManager(async () => undefined, { timeoutMs: 60000 });
      const verdict = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
      const pendings = (mgr as unknown as { pendings: Map<string, { timer: NodeJS.Timeout }> }).pendings;
      assert.equal(pendings.get('u1')!.timer.hasRef(), false, '超时定时器应 unref');
      mgr.cancel('u1');
      assert.equal(await verdict, false);
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
