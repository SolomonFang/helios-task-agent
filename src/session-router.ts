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
  private readonly sessions = new Map<string, AgentSession>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly cfg: AgentConfig;
  private readonly mcp: KanbanMcp | null;
  private mcpOk: boolean;
  private readonly memory: MemoryStore;
  private readonly confirmFactory?: (openId: string) => ConfirmFn;

  constructor(
    cfg: AgentConfig,
    mcp: KanbanMcp | null,
    mcpOk: boolean,
    memory?: MemoryStore,
    confirmFactory?: (openId: string) => ConfirmFn,
  ) {
    this.cfg = cfg;
    this.mcp = mcp;
    this.mcpOk = mcpOk;
    this.memory = memory || new MemoryStore();
    this.confirmFactory = confirmFactory;
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
          break;
        }
      }
    }
    const session = new AgentSession(this.cfg, this.mcp, this.mcpOk, {
      userId: openId,
      memory: this.memory,
      confirm: this.confirmFactory?.(openId),
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

  /** Run work for a user strictly in order (prevents overlapping tool rounds). */
  enqueue(openId: string, work: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(openId) || Promise.resolve();
    const next = prev
      .catch(() => {
        /* keep chain alive */
      })
      .then(work);
    this.queues.set(
      openId,
      next.finally(() => {
        if (this.queues.get(openId) === next) this.queues.delete(openId);
      }),
    );
    return next;
  }
}
