/**
 * MCP 健康监督：周期探测；连续失败才降级 hk_cli（避免瞬时抖动误报），
 * 自动重连（退避至 ~5 分钟），恢复后切回。
 *
 * 重连竞态防护：reconnect 的 close() 会杀掉 in-flight 的工具调用，因此
 * - 有轮次进行中（activeTurns > 0）时跳过本轮重连，下个周期再试；
 * - 决定重连后同步占位 reconnecting，此后 enterTurn 一律等重连结束——
 *   「检查无轮次」与「close()」之间的窗口被彻底关闭。
 */

import type { KanbanMcp } from '../kanban/mcp';

export interface McpSupervisorOptions {
  mcp: KanbanMcp;
  /** 启动时 MCP 是否已连接。 */
  initiallyAlive: boolean;
  /** 探测周期，默认 60s。 */
  intervalMs?: number;
  /** 连续失败多少次判定掉线，默认 2。 */
  failThreshold?: number;
  /** 掉线时回调（降级 hk_cli、通知 owner 等）。 */
  onLost?: () => void;
  /** 恢复时回调。 */
  onRecovered?: () => void;
  log?: (msg: string) => void;
}

export class McpSupervisor {
  private readonly opts: McpSupervisorOptions;
  private alive: boolean;
  private failures = 0;
  /** tick 重入防护（上一轮 ping/重连未结束时跳过）。 */
  private busy = false;
  /** 进行中的 agent 轮次数（重连期间不得有 in-flight 工具调用）。 */
  private activeTurns = 0;
  /** 进行中的重连；enterTurn 等待它结束后再开始，杜绝 close() 杀 in-flight 调用。 */
  private reconnecting: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: McpSupervisorOptions) {
    this.opts = opts;
    this.alive = opts.initiallyAlive;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** 当前是否有进行中的轮次（/status 或测试用）。 */
  get turnCount(): number {
    return this.activeTurns;
  }

  start(): void {
    const interval = Math.max(5000, this.opts.intervalMs ?? 60000);
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 轮次开始：若有重连进行中，等它结束（拿到的是重连后的新连接）。
   * 与 exitTurn 配对使用（finally）。
   */
  async enterTurn(): Promise<void> {
    await this.reconnecting;
    this.activeTurns++;
  }

  exitTurn(): void {
    this.activeTurns = Math.max(0, this.activeTurns - 1);
  }

  /** 单次健康检查（start 的周期回调；public 便于直接测试退避/竞态逻辑）。 */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const threshold = this.opts.failThreshold ?? 2;
      try {
        await this.opts.mcp.ping();
        this.failures = 0;
        if (!this.alive) {
          this.alive = true;
          this.opts.onRecovered?.();
        }
      } catch {
        this.failures++;
        if (this.alive && this.failures >= threshold) {
          this.alive = false;
          this.opts.onLost?.();
        }
        // 重连退避：前 3 次连续试，之后每 5 个周期试一次（~5 分钟）
        if (!this.alive && (this.failures <= 3 || this.failures % 5 === 0)) {
          await this.tryReconnect();
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async tryReconnect(): Promise<void> {
    if (this.reconnecting) return; // 已有重连在进行
    if (this.activeTurns > 0) return; // 有轮次在跑：close() 会杀掉 in-flight 工具调用，下轮再试
    let release!: () => void;
    // 同步占位：从这一刻起 enterTurn 都会等本次重连结束，
    // 「activeTurns === 0 检查」与「reconnect()」之间不再可能插入新轮次。
    this.reconnecting = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await this.opts.mcp.reconnect();
    } catch {
      /* 下一轮再试 */
    } finally {
      this.reconnecting = null;
      release();
    }
  }
}
