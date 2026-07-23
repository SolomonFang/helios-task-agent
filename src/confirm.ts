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
 */

/** 'approved' = 仅此次；'approved_batch' = 同类免问；'denied'；'ignored' = 无 pending 或非应答。 */
export type ConfirmAnswer = 'approved' | 'approved_batch' | 'denied' | 'ignored';

interface Pending {
  id: string;
  req: ConfirmRequest;
  resolve: (ok: ConfirmVerdict) => void;
  timer: NodeJS.Timeout;
}

// 收窄的确认词：「好/可以/ok」这类随口应答不算批准，避免 pending 期间误放行写操作
const YES_RE = /^(确认|确认执行|同意|批准|执行|y|yes)$/i;
const BATCH_RE = /^(都允许|同类免问|批量允许|以后都|batch|b)$/i;
const NO_RE = /^(取消|算了|不用|否|拒绝|n|no)$/i;

export class ConfirmationManager {
  private pendings = new Map<string, Pending>();
  private chatIds = new Map<string, string>();

  constructor(
    private sendPrompt: (
      openId: string,
      chatId: string | undefined,
      req: ConfirmRequest,
      id: string,
      timeoutMs: number,
    ) => Promise<void>,
    private opts: {
      /** 非破坏性操作（可批量）的确认超时，默认 120s。 */
      timeoutMs?: number;
      /** 破坏性操作（无 batchKey：删除/取消/停止/deny 及飞书写）的确认超时，默认 300s。 */
      destructiveTimeoutMs?: number;
      onTimeout?: (openId: string, req: ConfirmRequest) => void;
      /** 新写操作顶掉未应答的 pending 时通知（否则用户会以为是自己拒绝的）。 */
      onSuperseded?: (openId: string, req: ConfirmRequest) => void;
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
    }
    const timeoutMs = this.timeoutFor(req);
    return new Promise((resolve) => {
      const id = crypto.randomBytes(4).toString('hex');
      const timer = setTimeout(() => {
        const p = this.pendings.get(openId);
        if (p && p.id === id) {
          this.pendings.delete(openId);
          this.opts.onTimeout?.(openId, req);
          resolve(false);
        }
      }, timeoutMs);
      this.pendings.set(openId, { id, req, resolve, timer });
      void this.sendPrompt(openId, this.chatIds.get(openId), req, id, timeoutMs).catch(() => {});
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

  private finish(openId: string, p: Pending, verdict: ConfirmVerdict): void {
    clearTimeout(p.timer);
    this.pendings.delete(openId);
    p.resolve(verdict);
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
