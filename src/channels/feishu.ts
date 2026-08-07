import * as Lark from '@larksuiteoapi/node-sdk';
import type { AgentChannel, FeishuBotConfig, InboundMessage } from '../types';
import { errMessage } from '../err';

export interface FeishuReceivePayload {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

/** Extend inbound with Feishu-specific fields for reply + dedupe. */
export interface FeishuInboundMessage extends InboundMessage {
  messageId: string;
  messageType: string;
}

/** Subset of the card.action.trigger callback payload we care about. */
export interface FeishuCardAction {
  operator?: { open_id?: string };
  action?: { value?: { hta_confirm?: string; decision?: string; hta_review?: string; title?: string } };
}

export type AccessDecision = 'allow' | 'claim' | 'deny';

/** 飞书 REST 单请求超时：覆盖发消息/卡片/表情等全部 REST 调用（含 SDK 内部取 token）。 */
export const FEISHU_HTTP_TIMEOUT_MS = 20000;

/**
 * Owner-claim access control: with an empty allowlist, the FIRST user to DM
 * the bot becomes the owner (persisted to .env by the caller); everyone else
 * is denied. With a configured allowlist, only listed users pass.
 */
export function createAccessChecker(initialAllowed: string[]): {
  check: (openId: string) => AccessDecision;
  list: () => string[];
  /** 撤销运行时认领（owner 绑定未持久化时 fail-closed 用）。 */
  unclaim: (openId: string) => void;
} {
  const allowed = new Set(initialAllowed.filter(Boolean));
  let claimable = allowed.size === 0;
  return {
    check(openId: string): AccessDecision {
      if (allowed.has(openId)) return 'allow';
      if (claimable) {
        claimable = false;
        allowed.add(openId);
        return 'claim';
      }
      return 'deny';
    },
    list(): string[] {
      return [...allowed];
    },
    unclaim(openId: string): void {
      if (allowed.delete(openId)) claimable = allowed.size === 0;
    },
  };
}

/** WS 消息事件基础过滤的产出：必填字段齐全 + p2p 私聊 + 真人发送者。 */
export interface FilteredIncomingMessage {
  chatId: string;
  messageId: string;
  openId: string;
  messageType: string;
  content?: string;
}

/**
 * 消息事件入口过滤（纯函数）：仅放行字段齐全的 p2p 私聊、真人（非 bot/系统）发送者。
 * 返回 null = 丢弃该事件。
 */
export function filterIncomingMessage(data: FeishuReceivePayload): FilteredIncomingMessage | null {
  const message = data.message;
  const sender = data.sender;
  if (!message?.chat_id || !message.message_id) return null;

  // Only private chats
  if (message.chat_type !== 'p2p') return null;

  // Ignore bot / system senders（sender_type 缺失视为不可信，同样丢弃）
  if (sender?.sender_type !== 'user') return null;

  const openId = sender?.sender_id?.open_id || '';
  if (!openId) return null;

  return {
    chatId: message.chat_id,
    messageId: message.message_id,
    openId,
    messageType: message.message_type || 'unknown',
    content: message.content,
  };
}

/** message_id 去重表：TTL 过期清理（prune 由调用方在事件入口触发）。 */
export interface MessageDedupe {
  /** 清理超过 TTL 的条目。 */
  prune: (now: number) => void;
  /** 已见过返回 true；否则记录（时间戳 now）并返回 false。 */
  isDuplicate: (id: string, now: number) => boolean;
}

export function createMessageDedupe(ttlMs: number): MessageDedupe {
  const seen = new Map<string, number>();
  return {
    prune(now: number): void {
      for (const [id, ts] of seen) {
        if (now - ts > ttlMs) seen.delete(id);
      }
    },
    isDuplicate(id: string, now: number): boolean {
      if (seen.has(id)) return true;
      seen.set(id, now);
      return false;
    },
  };
}

/** resolveAccess 的判定结果。 */
export interface AccessResolution {
  /** 最终放行判定（claim 持久化成功按 allow）。 */
  decision: 'allow' | 'deny';
  /** 本次事件首次触发 owner 认领。 */
  claimed: boolean;
  /** 认领未持久化：已撤销内存放行并加入阻断集（fail-closed）。 */
  claimRevoked: boolean;
}

export interface AccessHooks {
  /** owner 认领持久化（写 .env）；返回 false 或抛错均按未持久化处理。 */
  persistClaim: (openId: string) => boolean;
  /** 认领 hook 抛错时的错误文案回调（日志用，参数为 errMessage 结果）。 */
  onClaimError?: (message: string) => void;
}

/**
 * 消息发送者的接入判定（fail-closed）：
 * 白名单内放行；空白名单时首个用户触发认领，认领未持久化则撤销内存放行、
 * 加入 claimBlocked 阻断集并按拒绝处理；阻断集中的用户一律拒绝。
 */
export function resolveAccess(
  access: ReturnType<typeof createAccessChecker>,
  claimBlocked: Set<string>,
  openId: string,
  hooks: AccessHooks,
): AccessResolution {
  const first = access.check(openId);
  let claimed = false;
  let claimRevoked = false;
  let decision: 'allow' | 'deny';
  if (first === 'claim') {
    claimed = true;
    let persisted = false;
    try {
      persisted = hooks.persistClaim(openId);
    } catch (err) {
      hooks.onClaimError?.(errMessage(err));
    }
    if (!persisted) {
      // fail-closed：绑定未写回 .env，撤销内存放行并阻断重试（重启前该用户按拒绝处理）
      claimRevoked = true;
      access.unclaim(openId);
      // Set 无清理会无界增长：超上限整体清空（代价只是老条目重新判定一次）
      if (claimBlocked.size >= 1000) claimBlocked.clear();
      claimBlocked.add(openId);
    }
    decision = persisted ? 'allow' : 'deny';
  } else {
    decision = first === 'allow' ? 'allow' : 'deny';
  }
  if (claimBlocked.has(openId)) decision = 'deny';
  return { decision, claimed, claimRevoked };
}

/**
 * 卡片回调操作者白名单判定（纯函数）：与消息同一套白名单。
 * 卡片可能被转发，任何人都能点按钮；不过滤会让陌生人触发 AI 审查（耗 LLM 配额、读本机仓库 diff）。
 */
export function isCardActionAllowed(data: FeishuCardAction, allowedOpenIds: string[]): boolean {
  const openId = data.operator?.open_id || '';
  return !!openId && allowedOpenIds.includes(openId);
}

/** Split long text into ≤ limit chunks on paragraph/newline boundaries (hard cut as fallback). */
export function splitText(text: string, limit = 3000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function parseTextContent(content: string | undefined): string {
  if (!content) return '';
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return content.trim();
  }
}

/** Flatten a Feishu post (rich text) message into plain text. */
export function parsePostContent(content: string | undefined): string {
  if (!content) return '';
  let post: { title?: string; content?: unknown };
  try {
    post = JSON.parse(content) as { title?: string; content?: unknown };
  } catch {
    return '';
  }
  const lines: string[] = [];
  if (typeof post.title === 'string' && post.title.trim()) lines.push(post.title.trim());
  if (!Array.isArray(post.content)) return lines.join('\n');
  for (const para of post.content) {
    if (!Array.isArray(para)) continue;
    const segs: string[] = [];
    for (const node of para as Array<Record<string, unknown>>) {
      const text = typeof node.text === 'string' ? node.text : '';
      switch (node.tag) {
        case 'text':
          segs.push(text);
          break;
        case 'a':
          segs.push(node.href ? `${text}(${node.href})` : text);
          break;
        case 'at':
          segs.push(`@${node.user_name || node.user_id || '某人'}`);
          break;
        case 'img':
          segs.push('[图片]');
          break;
        case 'media':
        case 'file':
          segs.push('[文件]');
          break;
        case 'emotion':
          segs.push(`[${node.emoji_type || '表情'}]`);
          break;
        case 'code_block':
          segs.push(`\n${text}\n`);
          break;
        default:
          if (text) segs.push(text);
      }
    }
    const line = segs.join('').trim();
    if (line) lines.push(line);
  }
  return lines.join('\n').trim();
}

/**
 * Feishu IM channel via official WS long connection.
 * Only p2p (DM) text messages are forwarded to the handler.
 *
 * Important: the SDK requires the event callback to return quickly (<3s).
 * Callers should schedule heavy work asynchronously after start()'s handler returns.
 */
export class FeishuChannel implements AgentChannel {
  readonly name = 'feishu';
  private readonly cfg: FeishuBotConfig;
  private readonly client: Lark.Client;
  private readonly access: ReturnType<typeof createAccessChecker>;
  private wsClient: Lark.WSClient | null = null;
  /** 最近一次收到长连接事件（消息/卡片回传）的时间（ms；0 = 尚未收到），/status 探活用。 */
  private lastEventAtMs = 0;
  private readonly dedupe = createMessageDedupe(10 * 60 * 1000);
  private deniedNotified = new Set<string>();
  /** owner 绑定写盘失败的用户（fail-closed）：重启前按拒绝处理，避免每条消息重试写盘。 */
  private claimBlocked = new Set<string>();
  /** Card button callback (card.action.trigger); set by the bot layer. */
  onCardAction?: (data: FeishuCardAction) => void;
  /** WS 长连接状态变化钩子（进入重连/重连成功/重连耗尽），由 bot 层接告警。 */
  onWsStateChange?: (state: 'reconnecting' | 'reconnected' | 'failed', err?: Error) => void;
  /** First DM user claimed ownership (empty allowlist); persist + welcome in the bot layer.
   *  返回 false（或抛错）= 绑定未持久化：channel 撤销内存放行并阻断重试（fail-closed）。 */
  onOwnerClaim?: (openId: string) => boolean;

  constructor(cfg: FeishuBotConfig) {
    this.cfg = cfg;
    this.access = createAccessChecker(cfg.allowedOpenIds);
    // SDK 内部 axios 默认 timeout=0（永不超时）：一个挂死的 TCP 连接会让 reply/updateText
    // 永久 pending，卡死用户队列与 watcher 推送。defaultHttpInstance 是 SDK 导出的共享实例
    // （带响应解包拦截器，自建实例需复制拦截器否则 res.code 解析会坏），配默认超时即可；
    // 超时抛 AxiosError（timeout of …ms exceeded），由上层既有错误处理消化。
    Lark.defaultHttpInstance.defaults.timeout = FEISHU_HTTP_TIMEOUT_MS;
    this.client = new Lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      appType: Lark.AppType.SelfBuild,
    });
  }

  /** Current effective allowlist (owner claimed at runtime is included). */
  allowedOpenIds(): string[] {
    return this.access.list();
  }

  /** 最近一次收到长连接事件的时间（ms；0 = 尚未收到）。 */
  lastEventAt(): number {
    return this.lastEventAtMs;
  }

  /** SDK WSClient 连接状态快照（未启动返回 null）。 */
  connectionState(): Lark.WSConnectionState | null {
    return this.wsClient?.getConnectionStatus().state ?? null;
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.wsClient = new Lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      // 断线监测：SDK 负责重连，这里只透传状态给 bot 层做日志/告警，避免"进程活着但收不到消息"的僵尸态无人察觉
      onReconnecting: () => {
        console.warn('[feishu] 长连接断开，正在自动重连…');
        this.onWsStateChange?.('reconnecting');
      },
      onReconnected: () => {
        console.log('[feishu] 长连接已恢复');
        this.onWsStateChange?.('reconnected');
      },
      onError: (err) => {
        console.error(`[feishu] 长连接重连失败（SDK 已放弃重试）: ${err.message}`);
        this.onWsStateChange?.('failed', err);
      },
    });

    await this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: FeishuReceivePayload) => {
          const now = Date.now();
          this.lastEventAtMs = now;
          this.dedupe.prune(now);

          // 基础过滤：字段齐全 + p2p 私聊 + 真人发送者
          const filtered = filterIncomingMessage(data);
          if (!filtered) return;
          const { openId } = filtered;

          const gate = resolveAccess(this.access, this.claimBlocked, openId, {
            persistClaim: (id) => (this.onOwnerClaim ? this.onOwnerClaim(id) : true),
            onClaimError: (msg) => console.error(`[feishu] owner claim hook error: ${msg}`),
          });
          if (gate.claimed) console.log(`[feishu] owner claimed by ${openId}`);
          if (gate.claimRevoked) {
            console.error(`[feishu] owner 绑定未持久化，已撤销内存放行: ${openId}`);
            return; // 告警文案由 onOwnerClaim 侧发送；触发认领的这条消息不再处理
          }
          if (gate.decision === 'deny') {
            console.warn(`[feishu] ignore open_id not in allowlist: ${openId}`);
            if (!this.deniedNotified.has(openId)) {
              // Set 无清理会无界增长：超上限整体清空（代价只是老用户再收一次提醒）
              if (this.deniedNotified.size >= 1000) this.deniedNotified.clear();
              this.deniedNotified.add(openId);
              void this.notifyOpenId(
                openId,
                '抱歉，这是私人专用机器人实例，已绑定给其他用户。如需使用，请联系实例 owner 开通，或自行部署一个实例。\n' +
                  `若你就是本实例的部署者，请把本账号的 open_id 加入部署目录 .env 的 FEISHU_ALLOWED_OPEN_IDS 后重启机器人：\n${openId}`,
              ).catch(() => {});
            }
            return;
          }

          if (this.dedupe.isDuplicate(filtered.messageId, now)) return;

          const text =
            filtered.messageType === 'text'
              ? parseTextContent(filtered.content)
              : filtered.messageType === 'post'
                ? parsePostContent(filtered.content)
                : '';

          const inbound: FeishuInboundMessage = {
            sessionId: filtered.chatId,
            senderId: openId,
            text,
            messageId: filtered.messageId,
            messageType: filtered.messageType,
            raw: data,
          };

          // Return immediately; process in background to satisfy <3s ACK.
          void onMessage(inbound).catch((err) => {
            const msg = errMessage(err);
            console.error(`[feishu] handler error: ${msg}`);
          });
        },
        // 卡片按钮回传（需在开放平台「回调订阅」配置长连接 + 卡片回传交互）
        'card.action.trigger': async (data: FeishuCardAction) => {
          try {
            // 与消息同一套白名单：卡片可能被转发，任何人都能点按钮
            if (!isCardActionAllowed(data, this.access.list())) {
              console.warn(`[feishu] ignore card action from open_id not in allowlist: ${data.operator?.open_id || '(unknown)'}`);
              return;
            }
            this.lastEventAtMs = Date.now();
            this.onCardAction?.(data);
          } catch (err) {
            const msg = errMessage(err);
            console.error(`[feishu] card action error: ${msg}`);
          }
        },
      }),
    });
  }

  private async createMessage(receiveIdType: 'chat_id' | 'open_id', receiveId: string, text: string): Promise<string | undefined> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    if (res.code !== 0) {
      throw new Error(`飞书发消息失败: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.message_id;
  }

  /** Send a text message to a chat; returns the message_id (for later update). */
  async sendText(chatId: string, text: string): Promise<string | undefined> {
    return this.createMessage('chat_id', chatId, text);
  }

  /** Replace the content of a previously sent message (progress feedback). */
  async updateText(messageId: string, text: string): Promise<void> {
    const res = await this.client.im.v1.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    if (res.code !== 0) {
      throw new Error(`飞书更新消息失败: code=${res.code} msg=${res.msg}`);
    }
  }

  /** Add an emoji reaction to a message（如「Typing」敲键盘表情做即时回执）；returns reaction_id. */
  async addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const res = await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
    if (res.code !== 0) {
      throw new Error(`飞书添加表情回复失败: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.reaction_id;
  }

  /** Remove a reaction previously added by addReaction. */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    const res = await this.client.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    if (res.code !== 0) {
      throw new Error(`飞书删除表情回复失败: code=${res.code} msg=${res.msg}`);
    }
  }

  async reply(msg: InboundMessage, text: string): Promise<void> {
    const chatId = msg.sessionId;
    if (!chatId) throw new Error('reply 缺少 chat_id (sessionId)');
    // Long replies are split into multiple messages instead of truncated.
    for (const chunk of splitText(text)) {
      await this.createMessage('chat_id', chatId, chunk);
    }
  }

  /** Send an interactive card (e.g. write-op confirmation with buttons); returns message_id. */
  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string | undefined> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    if (res.code !== 0) {
      throw new Error(`飞书发卡片失败: code=${res.code} msg=${res.msg}`);
    }
    return res.data?.message_id;
  }

  /** Replace an interactive card in place（确认卡片决策/超时后更新为终态）。 */
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const res = await this.client.im.v1.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    if (res.code !== 0) {
      throw new Error(`飞书更新卡片失败: code=${res.code} msg=${res.msg}`);
    }
  }

  /** Proactive DM push to a user (watcher / timeout notices); chunked when long. */
  async notifyOpenId(openId: string, text: string): Promise<void> {
    for (const chunk of splitText(text)) {
      await this.createMessage('open_id', openId, chunk);
    }
  }

  /** Proactive interactive-card push to a user (watcher notifications). */
  async notifyCardOpenId(openId: string, card: Record<string, unknown>): Promise<void> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    if (res.code !== 0) {
      throw new Error(`飞书发卡片失败: code=${res.code} msg=${res.msg}`);
    }
  }

  async stop(): Promise<void> {
    // 当前 SDK（≥1.71）WSClient 提供 close()：主动断开长连接并停掉重连/保活定时器，
    // 不再只靠进程退出回收 socket（bot 的 8s 强退兜底仍保留）。
    this.wsClient?.close();
    this.wsClient = null;
  }
}
