import type { AgentConfig } from './types';
import type { KanbanMcp } from './mcp';
import { MemoryStore } from './memory';
import { AgentSession } from './session';

/**
 * One AgentSession per Feishu open_id; serializes messages per user.
 */
export class SessionRouter {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly cfg: AgentConfig;
  private readonly mcp: KanbanMcp | null;
  private readonly mcpOk: boolean;
  private readonly memory: MemoryStore;

  constructor(cfg: AgentConfig, mcp: KanbanMcp | null, mcpOk: boolean, memory?: MemoryStore) {
    this.cfg = cfg;
    this.mcp = mcp;
    this.mcpOk = mcpOk;
    this.memory = memory || new MemoryStore();
  }

  getOrCreate(openId: string): AgentSession {
    let session = this.sessions.get(openId);
    if (!session) {
      session = new AgentSession(this.cfg, this.mcp, this.mcpOk, {
        userId: openId,
        memory: this.memory,
      });
      this.sessions.set(openId, session);
    }
    return session;
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
