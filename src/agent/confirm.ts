import crypto from 'crypto';
import type { ConfirmRequest, ConfirmSettle, ConfirmVerdict } from './guard';
import { markSuperseded, markTimedOut } from './guard';
import { errMessage } from '../infra/err';

/**
 * Bot-side write confirmation: one pending action per user.
 * The agent's tool handler awaits request(); the user's answer arrives either
 * as a plain text reply（「确认」/「同类免问」/「取消」）or as a card button callback
 * (card.action.trigger), resolving the promise — both bypass the per-user
 * message queue, so there is no deadlock.
 *
 * 裁决三态：'once' = 批准仅此次；'batch' = 批准且本会话内同类免问；false = 拒绝。
 * 超时分级：普通写操作 120s；破坏性操作（req.destructive）决策成本高，放宽到 300s。
 * 终态回调（onSettled）：携带确认卡片 message id，bot 层据此把卡片原地更新为
 * 终态（按钮消失），避免"点了没反应"与过期卡片误点。
 */

/** 'approved' = 仅此次；'approved_batch' = 同类免问；'denied'；'ignored' = 无 pending 或非应答。 */
export type ConfirmAnswer = 'approved' | 'approved_batch' | 'denied' | 'ignored';

interface Pending {
  id: string;
  req: ConfirmRequest;
  resolve: (ok: ConfirmVerdict) => void;
  timer: NodeJS.Timeout;
  /** 确认卡片的消息 id（文本降级时无），异步回填，用于终态时原地更新卡片。 */
  cardMessageId?: string;
  /**
   * 已终结但终结时卡片 id 尚未回填：记录终态，待 sendPrompt 回填卡片 id 时
   * 补发一次终态通知（否则已发出的确认卡片永远停在可点击状态）。
   */
  settledWithoutCard?: ConfirmSettle;
}

// 收窄的确认词：「好/可以/ok」这类随口应答不算批准，避免 pending 期间误放行写操作。
// 单字「都」/「b」不在词表：随口一个字就批准长期免问太危险；「以后都」「都允许」「batch」仍覆盖该意图。
// 词表为 CLI（readline 逐行）与飞书 bot（文本消息）共用：两端匹配方式可不同，词表必须一致。
export const CONFIRM_YES_WORDS = ['确认', '确认执行', '同意', '批准', '执行', 'y', 'yes'];
export const CONFIRM_BATCH_WORDS = ['都允许', '同类免问', '同对象免问', '批量允许', '以后都', '免问', 'batch', '一直允许', '始终允许', 'always'];
export const CONFIRM_NO_WORDS = ['取消', '算了', '不用', '否', '拒绝', 'n', 'no'];

const wordsToRe = (words: string[]): RegExp => new RegExp(`^(?:${words.join('|')})$`, 'i');
export const CONFIRM_YES_RE = wordsToRe(CONFIRM_YES_WORDS);
export const CONFIRM_BATCH_RE = wordsToRe(CONFIRM_BATCH_WORDS);
export const CONFIRM_NO_RE = wordsToRe(CONFIRM_NO_WORDS);

/**
 * 确认专属词：只在确认场景出现、日常对话几乎不会说的词。无 pending 时只有这些词
 * 仍被拦截并提示「没有待确认的写操作」；「确认/同意/执行/取消/算了/不用/yes/no」等
 * 日常应答词不再拦截，消息照常入队交给模型处理（避免谎称「可能已超时/被取消」）。
 * 注意：本词表只用于无 pending 的兜底提示；pending 期间的闸口内裁决（resolveFromText）
 * 仍用上面的完整词表，两条路径互不影响。
 */
const CONFIRM_EXCLUSIVE_RE = /^(?:确认执行|同类免问|同对象免问|批量允许|以后都|一直允许|始终允许)$/i;

/**
 * 是否「确认专属词」——用于无 pending 时的即时提示（bot：确认已超时/已处理后用户又回确认专属词）。
 * 日常应答词与单字母一律不拦截，避免吞掉正常对话。
 */
export function isConfirmWord(text: string): boolean {
  const t = text.trim();
  if (t.length <= 1) return false;
  return CONFIRM_EXCLUSIVE_RE.test(t);
}

/** 全部确认管理器实例：hasPendingConfirmation 跨实例查询用。 */
const managers = new Set<ConfirmationManager>();

/** 查询该用户当前是否有挂起的写操作确认（bot handler 用）。 */
export function hasPendingConfirmation(userKey: string): boolean {
  for (const m of managers) {
    if (m.hasPending(userKey)) return true;
  }
  return false;
}

export class ConfirmationManager {
  private pendings = new Map<string, Pending>();
  private chatIds = new Map<string, string>();
  /** 每个用户最近一次「同类免问」批准的粒度（bot 回执文案用；批准对象级时须如实说「同对象」）。 */
  private lastBatchScopes = new Map<string, 'kind' | 'object'>();

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
      /** 普通写操作的确认超时，默认 120s。 */
      timeoutMs?: number;
      /** 破坏性操作（req.destructive：删除/取消/停止/审批/启动/归档/合并/推送/执行及飞书写/记忆写/技能脚本）的确认超时，默认 300s。 */
      destructiveTimeoutMs?: number;
      onTimeout?: (openId: string, req: ConfirmRequest) => void;
      /** 新写操作顶掉未应答的 pending 时通知（否则用户会以为是自己拒绝的）。 */
      onSuperseded?: (openId: string, req: ConfirmRequest) => void;
      /** 请求进入终态时回调；带卡片 message id 时可原地更新为终态卡片。 */
      onSettled?: (openId: string, req: ConfirmRequest, settle: ConfirmSettle, cardMessageId?: string) => void;
      /** 确认卡片与文本降级都发送失败时回调（用户无法裁决）：bot 层借此走最后可达路径告知用户。 */
      onSendFailed?: (openId: string, req: ConfirmRequest, error: string) => void;
    } = {},
  ) {
    managers.add(this); // hasPendingConfirmation 跨实例查询
  }

  /** Remember the user's chat so the confirm card can be delivered later. */
  noteChat(openId: string, chatId: string): void {
    if (chatId) this.chatIds.set(openId, chatId);
  }

  hasPending(openId: string): boolean {
    return this.pendings.has(openId);
  }

  private timeoutFor(req: ConfirmRequest): number {
    const base = this.opts.timeoutMs ?? 120000;
    return req.destructive ? Math.max(base, this.opts.destructiveTimeoutMs ?? 300000) : base;
  }

  /**
   * Called from the write gate; resolves the user's verdict ('once' / 'batch' / false).
   * signal：轮次级中断（/stop 或墙钟看门狗）——abort 时走 cancel() 同一路径按拒绝收尾，
   * 否则工具会卡在确认等待上直到确认超时（最长 300s），轮次墙钟形同虚设。
   */
  request(openId: string, req: ConfirmRequest, signal?: AbortSignal): Promise<ConfirmVerdict> {
    const prev = this.pendings.get(openId);
    if (prev) {
      clearTimeout(prev.timer);
      // 先标记再 resolve：闸门（passGate）据此把「被新写操作替代」与「用户拒绝」区分开。
      // resolve 值保持 false（终态经 onSettled 的 'superseded' 区分），不改 ConfirmVerdict 口径
      markSuperseded(prev.req);
      this.logSettle(openId, prev.req, 'superseded');
      prev.resolve(false);
      this.pendings.delete(openId);
      try {
        this.opts.onSuperseded?.(openId, prev.req);
        this.opts.onSettled?.(openId, prev.req, 'superseded', prev.cardMessageId);
      } catch {
        /* 通知回调失败不阻断新请求 */
      }
      if (!prev.cardMessageId) prev.settledWithoutCard = 'superseded';
    }
    const timeoutMs = this.timeoutFor(req);
    return new Promise((resolve) => {
      const id = crypto.randomBytes(4).toString('hex');
      const timer = setTimeout(() => {
        const p = this.pendings.get(openId);
        if (p && p.id === id) {
          this.pendings.delete(openId);
          // 先标记再 resolve：闸门据此把「超时未处理」与「用户拒绝」区分开（审计 decision 可区分）
          markTimedOut(req);
          this.logSettle(openId, req, 'timeout');
          // 回调在 setTimeout 里同步执行：回调抛异常不得让 resolve 漏执行
          //（否则闸门 promise 永久挂起），resolve 放 finally 保证必达
          try {
            this.opts.onTimeout?.(openId, req);
            this.opts.onSettled?.(openId, req, 'timeout', p.cardMessageId);
          } catch {
            /* 通知回调失败不阻断收尾 */
          } finally {
            p.resolve(false);
          }
          if (!p.cardMessageId) p.settledWithoutCard = 'timeout';
        }
      }, timeoutMs);
      // unref：确认超时（最长 300s）不应成为保活理由——进程若只剩这一个定时器
      //（如 shutdown 途中）应能直接退出，超时自动拒绝只是用户体验优化而非存活义务
      timer.unref();
      // 轮次中断监听：所有收尾路径（答复/超时/被替代/发送失败/abort）都经 pending.resolve，
      // 在包装里统一摘除监听器，避免在 turn 级 signal 上滞留
      let onAbort: (() => void) | undefined;
      const pending: Pending = {
        id,
        req,
        resolve: (v) => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        timer,
      };
      this.pendings.set(openId, pending);
      if (signal) {
        if (signal.aborted) {
          // 轮次已中断：不发送确认请求，直接按拒绝收尾
          clearTimeout(timer);
          this.pendings.delete(openId);
          resolve(false);
          return;
        }
        onAbort = () => {
          this.cancel(openId); // 与 /stop 一并取消同路径：按拒绝收尾并留痕
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      void this.sendPrompt(openId, this.chatIds.get(openId), req, id, timeoutMs)
        .then((messageId) => {
          // 回填卡片 message id 前确认 pending 仍是这一条（可能已被答复/替代）
          const p = this.pendings.get(openId);
          if (p && p.id === id) {
            if (messageId) p.cardMessageId = messageId;
            return;
          }
          // 竞态：pending 已终结（如确认超时先于卡片发送完成），当时拿不到卡片 id、
          // 终态通知落空。用回填的卡片 id 补发一次终态通知，让卡片原地更新为终态。
          if (messageId && pending.settledWithoutCard) {
            const settle = pending.settledWithoutCard;
            pending.settledWithoutCard = undefined;
            try {
              this.opts.onSettled?.(openId, req, settle, messageId);
            } catch {
              /* 补发终态通知失败不影响已完成的裁决 */
            }
          }
        })
        .catch((err) => {
          // 卡片与文本降级都发送失败：用户无法裁决。 pending 仍属本条时才收尾——
          // 尽快以「拒绝」返回（工具不再干等超时），并回调 bot 层走最后可达路径告知用户。
          const message = errMessage(err);
          console.error(`[confirm] 确认请求发送失败，按拒绝处理: ${message}`);
          const p = this.pendings.get(openId);
          if (p && p.id === id) {
            clearTimeout(p.timer);
            this.pendings.delete(openId);
            p.resolve(false);
            try {
              this.opts.onSendFailed?.(openId, req, message);
            } catch {
              /* 通知回调失败不阻断收尾 */
            }
          }
        });
    });
  }

  /** 最近一次「同类免问」批准的粒度（回执文案用）；无记录时按 'kind'（与既有文案一致）。 */
  lastBatchScope(openId: string): 'kind' | 'object' {
    return this.lastBatchScopes.get(openId) ?? 'kind';
  }

  /** Plain-text answer. 'ignored' = no pending or text is not an answer. */
  resolveFromText(openId: string, text: string): ConfirmAnswer {
    const p = this.pendings.get(openId);
    if (!p) return 'ignored';
    const t = text.trim();
    if (CONFIRM_BATCH_RE.test(t) && p.req.batchKey) {
      this.finish(openId, p, 'batch');
      return 'approved_batch';
    }
    if (CONFIRM_YES_RE.test(t)) {
      this.finish(openId, p, 'once');
      return 'approved';
    }
    if (CONFIRM_NO_RE.test(t)) {
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

  /**
   * 裁决留痕（批准/拒绝/超时/被替代同型日志）：open_id 只记头尾摘要，不完整落日志；
   * memory 写操作的 summary 含 value 摘要（memory_set 的 value 前 100 字符，
   * 见 tools/memory-tools.ts）——裁决日志只记 key 部分（「：」前），不落 value
   */
  private logSettle(openId: string, req: ConfirmRequest, settle: ConfirmSettle): void {
    const maskedUser = openId.length > 8 ? `${openId.slice(0, 4)}…${openId.slice(-2)}` : '***';
    const loggedSummary = req.kind === 'memory' ? req.summary.split('：')[0]! : req.summary.slice(0, 80);
    console.log(`[confirm] user=${maskedUser} verdict=${settle} summary="${loggedSummary}"`);
  }

  private finish(openId: string, p: Pending, verdict: ConfirmVerdict): void {
    clearTimeout(p.timer);
    this.pendings.delete(openId);
    const settle: ConfirmSettle = verdict === false ? 'denied' : verdict;
    if (verdict === 'batch') this.lastBatchScopes.set(openId, p.req.batchScope ?? 'kind');
    this.logSettle(openId, p.req, settle);
    p.resolve(verdict);
    try {
      this.opts.onSettled?.(openId, p.req, settle, p.cardMessageId);
    } catch {
      /* 终态通知回调失败不影响已完成的裁决 */
    }
    if (!p.cardMessageId) p.settledWithoutCard = settle;
  }
}
