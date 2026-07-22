import * as Lark from '@larksuiteoapi/node-sdk';
import type { AgentChannel, FeishuBotConfig, InboundMessage } from '../types';

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
  action?: { value?: { hta_confirm?: string; decision?: string } };
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
  private wsClient: Lark.WSClient | null = null;
  private seenMessageIds = new Map<string, number>();
  private readonly seenTtlMs = 10 * 60 * 1000;
  /** Card button callback (card.action.trigger); set by the bot layer. */
  onCardAction?: (data: FeishuCardAction) => void;

  constructor(cfg: FeishuBotConfig) {
    this.cfg = cfg;
    this.client = new Lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      appType: Lark.AppType.SelfBuild,
    });
  }

  private pruneSeen(now: number): void {
    for (const [id, ts] of this.seenMessageIds) {
      if (now - ts > this.seenTtlMs) this.seenMessageIds.delete(id);
    }
  }

  private isAllowed(openId: string): boolean {
    if (!this.cfg.allowedOpenIds.length) return true;
    return this.cfg.allowedOpenIds.includes(openId);
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.wsClient = new Lark.WSClient({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    await this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: FeishuReceivePayload) => {
          const now = Date.now();
          this.pruneSeen(now);

          const message = data.message;
          const sender = data.sender;
          if (!message?.chat_id || !message.message_id) return;

          // Only private chats
          if (message.chat_type !== 'p2p') return;

          // Ignore bot / system senders
          if (sender?.sender_type && sender.sender_type !== 'user') return;

          const openId = sender?.sender_id?.open_id || '';
          if (!openId) return;
          if (!this.isAllowed(openId)) {
            console.warn(`[feishu] ignore open_id not in allowlist: ${openId}`);
            return;
          }

          if (this.seenMessageIds.has(message.message_id)) return;
          this.seenMessageIds.set(message.message_id, now);

          const messageType = message.message_type || 'unknown';
          const text = messageType === 'text' ? parseTextContent(message.content) : '';

          const inbound: FeishuInboundMessage = {
            sessionId: message.chat_id,
            senderId: openId,
            text,
            messageId: message.message_id,
            messageType,
            raw: data,
          };

          // Return immediately; process in background to satisfy <3s ACK.
          void onMessage(inbound).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[feishu] handler error: ${msg}`);
          });
        },
        // 卡片按钮回传（需在开放平台「回调订阅」配置长连接 + 卡片回传交互）
        'card.action.trigger': async (data: FeishuCardAction) => {
          try {
            this.onCardAction?.(data);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[feishu] card action error: ${msg}`);
          }
        },
      }),
    });
  }

  async reply(msg: InboundMessage, text: string): Promise<void> {
    const chatId = msg.sessionId;
    if (!chatId) throw new Error('reply 缺少 chat_id (sessionId)');
    // Feishu text messages: keep under ~4000 chars practically
    const body = text.length > 3500 ? text.slice(0, 3500) + '\n…（已截断）' : text;
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: body }),
      },
    });
    if (res.code !== 0) {
      throw new Error(`飞书发消息失败: code=${res.code} msg=${res.msg}`);
    }
  }

  /** Send an interactive card (e.g. write-op confirmation with buttons). */
  async sendCard(chatId: string, card: Record<string, unknown>): Promise<void> {
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
  }

  /** Proactive DM push to a user (used by the kanban watcher / timeout notices). */
  async notifyOpenId(openId: string, text: string): Promise<void> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    if (res.code !== 0) {
      throw new Error(`飞书推送失败: code=${res.code} msg=${res.msg}`);
    }
  }

  async stop(): Promise<void> {
    // WSClient has no public stop in older SDK versions; process exit tears down the socket.
    this.wsClient = null;
  }
}
