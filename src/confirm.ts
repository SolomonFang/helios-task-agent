import crypto from 'crypto';
import type { ConfirmRequest, ConfirmVerdict } from './guard';

/**
 * Bot-side write confirmation: one pending action per user.
 * The agent's tool handler awaits request(); the user's answer arrives either
 * as a plain text reply（「确认」/「都允许」/「取消」）or as a card button callback
 * (card.action.trigger), resolving the promise — both bypass the per-user
 * message queue, so there is no deadlock.
 *
 * 裁决三态：'once' = 批准仅此次；'batch' = 批准且同类免问 10 分钟；false = 拒绝。
 * 超时分级：可批量操作 120s；破坏性操作（无 batchKey）决策成本高，放宽到 300s。
 * 终态回调（onSettled）：携带确认卡片 message id，bot 层据此把卡片原地更新为
 * 终态（按钮消失），避免"点了没反应"与过期卡片误点。
 */

/** 'approved' = 仅此次；'approved_batch' = 同类免问；'denied'；'ignored' = 无 pending 或非应答。 */
export type ConfirmAnswer = 'approved' | 'approved_batch' | 'denied' | 'ignored';

/**
 * 确认请求的终态：once/batch = 批准；denied = 用户取消（含 /stop 一并取消）；
 * timeout = 超时自动拒绝；superseded = 被新的写操作确认替代。
 */
export type ConfirmSettle = 'once' | 'batch' | 'denied' | 'timeout' | 'superseded';

interface Pending {
  id: string;
  req: ConfirmRequest;
  resolve: (ok: ConfirmVerdict) => void;
  timer: NodeJS.Timeout;
  /** 确认卡片的消息 id（文本降级时无），异步回填，用于终态时原地更新卡片。 */
  cardMessageId?: string;
}

// 收窄的确认词：「好/可以/ok」这类随口应答不算批准，避免 pending 期间误放行写操作
const YES_RE = /^(确认|确认执行|同意|批准|执行|y|yes)$/i;
const BATCH_RE = /^(都允许|同类免问|批量允许|以后都|batch|b)$/i;
const NO_RE = /^(取消|算了|不用|否|拒绝|n|no)$/i;

export class ConfirmationManager {
  private pendings = new Map<string, Pending>();
  private chatIds = new Map<string, string>();

  constructor(
    /** 发送确认请求；返回确认卡片的消息 id（文本降级返回 undefined）。 */
    private sendPrompt: (
      openId: string,
      chatId: string | undefined,
      req: ConfirmRequest,
      id: string,
      timeoutMs: number,
    ) => Promise<string | undefined>,
    private opts: {
      /** 非破坏性操作（可批量）的确认超时，默认 120s。 */
      timeoutMs?: number;
      /** 破坏性操作（无 batchKey：删除/取消/停止/deny 及飞书写）的确认超时，默认 300s。 */
      destructiveTimeoutMs?: number;
      onTimeout?: (openId: string, req: ConfirmRequest) => void;
      /** 新写操作顶掉未应答的 pending 时通知（否则用户会以为是自己拒绝的）。 */
      onSuperseded?: (openId: string, req: ConfirmRequest) => void;
      /** 请求进入终态时回调；带卡片 message id 时可原地更新为终态卡片。 */
      onSettled?: (openId: string, req: ConfirmRequest, settle: ConfirmSettle, cardMessageId?: string) => void;
    } = {},
  ) {}

  /** Remember the user's chat so the confirm card can be delivered later. */
  noteChat(openId: string, chatId: string): void {
    if (chatId) this.chatIds.set(openId, chatId);
  }

  hasPending(openId: string): boolean {
    return this.pendings.has(openId);
  }

  private timeoutFor(req: ConfirmRequest): number {
    const base = this.opts.timeoutMs ?? 120000;
    return req.batchKey ? base : Math.max(base, this.opts.destructiveTimeoutMs ?? 300000);
  }

  /** Called from the write gate; resolves the user's verdict ('once' / 'batch' / false). */
  request(openId: string, req: ConfirmRequest): Promise<ConfirmVerdict> {
    const prev = this.pendings.get(openId);
    if (prev) {
      clearTimeout(prev.timer);
      prev.resolve(false);
      this.pendings.delete(openId);
      this.opts.onSuperseded?.(openId, prev.req);
      this.opts.onSettled?.(openId, prev.req, 'superseded', prev.cardMessageId);
    }
    const timeoutMs = this.timeoutFor(req);
    return new Promise((resolve) => {
      const id = crypto.randomBytes(4).toString('hex');
      const timer = setTimeout(() => {
        const p = this.pendings.get(openId);
        if (p && p.id === id) {
          this.pendings.delete(openId);
          this.opts.onTimeout?.(openId, req);
          this.opts.onSettled?.(openId, req, 'timeout', p.cardMessageId);
          resolve(false);
        }
      }, timeoutMs);
      this.pendings.set(openId, { id, req, resolve, timer });
      void this.sendPrompt(openId, this.chatIds.get(openId), req, id, timeoutMs)
        .then((messageId) => {
          // 回填卡片 message id 前确认 pending 仍是这一条（可能已被答复/替代）
          const p = this.pendings.get(openId);
          if (p && p.id === id && messageId) p.cardMessageId = messageId;
        })
        .catch(() => {});
    });
  }

  /** Plain-text answer. 'ignored' = no pending or text is not an answer. */
  resolveFromText(openId: string, text: string): ConfirmAnswer {
    const p = this.pendings.get(openId);
    if (!p) return 'ignored';
    const t = text.trim();
    if (BATCH_RE.test(t) && p.req.batchKey) {
      this.finish(openId, p, 'batch');
      return 'approved_batch';
    }
    if (YES_RE.test(t)) {
      this.finish(openId, p, 'once');
      return 'approved';
    }
    if (NO_RE.test(t)) {
      this.finish(openId, p, false);
      return 'denied';
    }
    return 'ignored';
  }

  /** Card button callback. */
  resolveFromCard(openId: string, confirmId: string, decision: string): ConfirmAnswer {
    const p = this.pendings.get(openId);
    if (!p || p.id !== confirmId) return 'ignored';
    if (decision === 'batch' && p.req.batchKey) {
      this.finish(openId, p, 'batch');
      return 'approved_batch';
    }
    if (decision === 'yes') {
      this.finish(openId, p, 'once');
      return 'approved';
    }
    this.finish(openId, p, false);
    return 'denied';
  }

  /** /stop 等场景一并取消挂起的确认（按拒绝处理）。返回是否确实有 pending 被取消。 */
  cancel(openId: string): boolean {
    const p = this.pendings.get(openId);
    if (!p) return false;
    this.finish(openId, p, false);
    return true;
  }

  private finish(openId: string, p: Pending, verdict: ConfirmVerdict): void {
    clearTimeout(p.timer);
    this.pendings.delete(openId);
    p.resolve(verdict);
    this.opts.onSettled?.(openId, p.req, verdict === false ? 'denied' : verdict, p.cardMessageId);
  }
}

/** Interactive card shown for a pending write operation (legacy card schema). */
export function buildConfirmCard(req: ConfirmRequest, id: string, timeoutMs = 120000): Record<string, unknown> {
  const kindLabel = req.kind === 'lark' ? '飞书' : '看板';
  const timeoutSec = Math.round(timeoutMs / 1000);
  const actions: Record<string, unknown>[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '确认执行（仅此次）' },
      type: 'primary',
      value: { hta_confirm: id, decision: 'yes' },
    },
  ];
  if (req.batchKey) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '同类免问 10 分钟' },
      value: { hta_confirm: id, decision: 'batch' },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '取消' },
    type: 'danger',
    value: { hta_confirm: id, decision: 'no' },
  });
  const replyHint = req.batchKey
    ? '点按钮，或回复「确认」（仅此次）/「都允许」（同类免问 10 分钟）/「取消」。'
    : '点按钮，或回复「确认」/「取消」。';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `⚠️ ${kindLabel}写操作确认` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${req.summary}**` } },
      { tag: 'div', text: { tag: 'plain_text', content: req.detail } },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `${replyHint}${timeoutSec} 秒未操作自动拒绝。` },
      },
      {
        tag: 'action',
        actions,
      },
    ],
  };
}

/** 决策/超时/作废后的终态卡片（原地替换确认卡片；无按钮，避免误点与"没反应"）。 */
export function buildResolvedCard(req: ConfirmRequest, settle: ConfirmSettle): Record<string, unknown> {
  const kindLabel = req.kind === 'lark' ? '飞书' : '看板';
  const meta: Record<ConfirmSettle, { template: string; title: string; note: string }> = {
    once: {
      template: 'green',
      title: `✅ ${kindLabel}写操作已批准（仅此次）`,
      note: '操作已放行，正在执行。',
    },
    batch: {
      template: 'green',
      title: `✅ ${kindLabel}写操作已批准（同类免问 10 分钟）`,
      note: '回复「恢复确认」可随时撤销免问。',
    },
    denied: {
      template: 'red',
      title: `🚫 ${kindLabel}写操作已取消`,
      note: '操作未执行。',
    },
    timeout: {
      template: 'grey',
      title: `⏰ ${kindLabel}写操作确认超时`,
      note: '超时未处理，已自动拒绝，操作未执行。',
    },
    superseded: {
      template: 'grey',
      title: `⚠️ ${kindLabel}写操作确认已作废`,
      note: '该确认已被新的写操作确认替代，请以最新卡片为准。',
    },
  };
  const m = meta[settle];
  return {
    config: { wide_screen_mode: true },
    header: {
      template: m.template,
      title: { tag: 'plain_text', content: m.title },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${req.summary}**` } },
      { tag: 'div', text: { tag: 'plain_text', content: req.detail } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: m.note } },
    ],
  };
}
