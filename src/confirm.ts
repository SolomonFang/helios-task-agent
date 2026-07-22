import crypto from 'crypto';
import type { ConfirmRequest } from './guard';

/**
 * Bot-side write confirmation: one pending action per user.
 * The agent's tool handler awaits request(); the user's answer arrives either
 * as a plain text reply（「确认」/「取消」）or as a card button callback
 * (card.action.trigger), resolving the promise — both bypass the per-user
 * message queue, so there is no deadlock.
 */

export type ConfirmAnswer = 'approved' | 'denied' | 'ignored';

interface Pending {
  id: string;
  req: ConfirmRequest;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

// 收窄的确认词：「好/可以/ok」这类随口应答不算批准，避免 pending 期间误放行写操作
const YES_RE = /^(确认|确认执行|同意|批准|执行|y|yes)$/i;
const NO_RE = /^(取消|算了|不用|否|拒绝|n|no)$/i;

export class ConfirmationManager {
  private pendings = new Map<string, Pending>();
  private chatIds = new Map<string, string>();

  constructor(
    private sendPrompt: (openId: string, chatId: string | undefined, req: ConfirmRequest, id: string) => Promise<void>,
    private opts: {
      timeoutMs?: number;
      onTimeout?: (openId: string, req: ConfirmRequest) => void;
      /** 新写操作顶掉未应答的 pending 时通知（否则用户会以为是自己拒绝的）。 */
      onSuperseded?: (openId: string, req: ConfirmRequest) => void;
      /** 用户批准时回调（bot 用于批量放行窗口提示）。 */
      onApprove?: (openId: string, req: ConfirmRequest) => void;
    } = {},
  ) {}

  /** Remember the user's chat so the confirm card can be delivered later. */
  noteChat(openId: string, chatId: string): void {
    if (chatId) this.chatIds.set(openId, chatId);
  }

  hasPending(openId: string): boolean {
    return this.pendings.has(openId);
  }

  /** Called from the write gate; resolves true only when the user approves in time. */
  request(openId: string, req: ConfirmRequest): Promise<boolean> {
    const prev = this.pendings.get(openId);
    if (prev) {
      clearTimeout(prev.timer);
      prev.resolve(false);
      this.pendings.delete(openId);
      this.opts.onSuperseded?.(openId, prev.req);
    }
    return new Promise((resolve) => {
      const id = crypto.randomBytes(4).toString('hex');
      const timer = setTimeout(() => {
        const p = this.pendings.get(openId);
        if (p && p.id === id) {
          this.pendings.delete(openId);
          this.opts.onTimeout?.(openId, req);
          resolve(false);
        }
      }, this.opts.timeoutMs ?? 120000);
      this.pendings.set(openId, { id, req, resolve, timer });
      void this.sendPrompt(openId, this.chatIds.get(openId), req, id).catch(() => {});
    });
  }

  /** Plain-text answer. 'ignored' = no pending or text is not an answer. */
  resolveFromText(openId: string, text: string): ConfirmAnswer {
    const p = this.pendings.get(openId);
    if (!p) return 'ignored';
    const t = text.trim();
    if (YES_RE.test(t)) {
      this.finish(openId, p, true);
      return 'approved';
    }
    if (NO_RE.test(t)) {
      this.finish(openId, p, false);
      return 'denied';
    }
    return 'ignored';
  }

  /** Card button callback. */
  resolveFromCard(openId: string, confirmId: string, decision: boolean): ConfirmAnswer {
    const p = this.pendings.get(openId);
    if (!p || p.id !== confirmId) return 'ignored';
    this.finish(openId, p, decision);
    return decision ? 'approved' : 'denied';
  }

  private finish(openId: string, p: Pending, ok: boolean): void {
    clearTimeout(p.timer);
    this.pendings.delete(openId);
    p.resolve(ok);
    if (ok) this.opts.onApprove?.(openId, p.req);
  }
}

/** Interactive card shown for a pending write operation (legacy card schema). */
export function buildConfirmCard(req: ConfirmRequest, id: string): Record<string, unknown> {
  const kindLabel = req.kind === 'lark' ? '飞书' : '看板';
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
        text: { tag: 'lark_md', content: '点按钮，或直接回复「确认」/「取消」。120 秒未操作自动拒绝。' },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '确认执行' },
            type: 'primary',
            value: { hta_confirm: id, decision: 'yes' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '取消' },
            type: 'danger',
            value: { hta_confirm: id, decision: 'no' },
          },
        ],
      },
    ],
  };
}
