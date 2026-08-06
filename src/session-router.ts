import type { AgentConfig } from './types';
import type { KanbanMcp } from './kanban/mcp';
import type { ConfirmFn } from './guard';
import { MemoryStore } from './memory';
import { AgentSession } from './session';

/**
 * One AgentSession per Feishu open_id; serializes messages per user.
 * 会话数设上限（LRU 淘汰最旧的空闲会话），防止长驻 bot 无界累积。
 */
export class SessionRouter {
  private static MAX_SESSIONS = 50;
  /** 每用户排队消息上限：超出拒收（handler 层据此回复「排队已满」），防止队列无界堆积。 */
  private static MAX_QUEUED = 20;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly queues = new Map<string, Promise<void>>();
  /** 每用户排队代际：/stop 时 +1，未开始的排队项据此自我丢弃。 */
  private readonly epochs = new Map<string, number>();
  /** 每用户「已入队但未开始」的消息数（/stop 丢弃计数与回执用）。 */
  private readonly queuedCounts = new Map<string, number>();
  private readonly cfg: AgentConfig;
  private readonly mcp: KanbanMcp | null;
  private mcpOk: boolean;
  private readonly memory: MemoryStore;
  private readonly confirmFactory?: (openId: string) => ConfirmFn;
  private readonly reportLinkBaseUrl?: string;

  constructor(
    cfg: AgentConfig,
    mcp: KanbanMcp | null,
    mcpOk: boolean,
    memory?: MemoryStore,
    confirmFactory?: (openId: string) => ConfirmFn,
    /** bot 场景的报告静态服务基地址：work_summary 报告改推 HTTP 链接。 */
    reportLinkBaseUrl?: string,
  ) {
    this.cfg = cfg;
    this.mcp = mcp;
    this.mcpOk = mcpOk;
    this.memory = memory || new MemoryStore();
    this.confirmFactory = confirmFactory;
    this.reportLinkBaseUrl = reportLinkBaseUrl;
  }

  getOrCreate(openId: string): AgentSession {
    const existing = this.sessions.get(openId);
    if (existing) {
      // LRU touch：移到最新位置
      this.sessions.delete(openId);
      this.sessions.set(openId, existing);
      return existing;
    }
    if (this.sessions.size >= SessionRouter.MAX_SESSIONS) {
      // 淘汰最旧的空闲会话；都在忙则暂时超额（极端情况，下轮再淘汰）
      for (const key of this.sessions.keys()) {
        if (!this.busy(key)) {
          this.sessions.delete(key);
          // 代际/排队计数随会话一并清理，否则两个 Map 不随 LRU 收敛
          this.epochs.delete(key);
          this.queuedCounts.delete(key);
          break;
        }
      }
    }
    const session = new AgentSession(this.cfg, this.mcp, this.mcpOk, {
      userId: openId,
      memory: this.memory,
      confirm: this.confirmFactory?.(openId),
      reportLinkBaseUrl: this.reportLinkBaseUrl,
    });
    this.sessions.set(openId, session);
    return session;
  }

  /** Flip MCP availability across all live sessions (supervisor reconnect/degrade). */
  setMcpOk(ok: boolean): void {
    if (this.mcpOk === ok) return;
    this.mcpOk = ok;
    for (const session of this.sessions.values()) session.setMcpOk(ok);
  }

  /** 该用户是否有排队中/进行中的任务（新消息排队回执用）。 */
  busy(openId: string): boolean {
    return this.queues.has(openId);
  }

  /** 尚未开始处理的排队消息数（不含正在执行的那条）。 */
  queuedCount(openId: string): number {
    return this.queuedCounts.get(openId) || 0;
  }

  /** 排队是否已达上限（handler 据此拒收并提示「排队已满」，不再入队）。 */
  queueFull(openId: string): boolean {
    return this.queuedCount(openId) >= SessionRouter.MAX_QUEUED;
  }

  /**
   * 丢弃该用户所有未开始的排队消息（/stop）：递增代际，轮到它们时自行跳过。
   * 正在执行的那条不受影响（由调用方用 AbortController 中断）。返回丢弃条数。
   */
  cancelQueued(openId: string): number {
    const n = this.queuedCount(openId);
    if (n > 0) this.epochs.set(openId, (this.epochs.get(openId) || 0) + 1);
    return n;
  }

  /** Run work for a user strictly in order (prevents overlapping tool rounds). */
  enqueue(openId: string, work: () => Promise<void>, onDropped?: () => void): Promise<void> {
    const epoch = this.epochs.get(openId) || 0;
    const prev = this.queues.get(openId) || Promise.resolve();
    this.queuedCounts.set(openId, this.queuedCount(openId) + 1);
    const next = prev
      .catch(() => {
        /* keep chain alive */
      })
      .then(() => {
        this.queuedCounts.set(openId, Math.max(0, this.queuedCount(openId) - 1));
        if ((this.epochs.get(openId) || 0) !== epoch) {
          // 已被 /stop 丢弃：回调给调用方兜底清理（如移除敲键盘表情，不等下一次 /stop）
          onDropped?.();
          return;
        }
        return work();
      });
    // 注意：必须引用同一个 promise 做比较——之前把 finally 的新 promise 存入 map、
    // 却与 next 比较，导致清理永不生效（busy() 永真、LRU 找不到空闲会话）。
    const tracked = next.finally(() => {
      if (this.queues.get(openId) === tracked) this.queues.delete(openId);
    });
    // 链尾 rejection 由调用方（enqueue 返回值）处理；tracked 仅作占位，兜底避免未处理 rejection。
    tracked.catch(() => {});
    this.queues.set(openId, tracked);
    return next;
  }
}
