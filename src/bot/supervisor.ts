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
import { errMessage } from '../infra/err';

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
  /** ping 挂起防护（超时按失败处理），默认 30s。 */
  pingTimeoutMs?: number;
  /**
   * 可选：看板后端健康探测（抛错视为不健康）。mcp.ping 只证明 stdio 子进程活着，
   * 看板假死（端口不响应）时纯 stdio 探活会误判健康、不告警；该探测补上后端维度。
   */
  kanbanHealth?: () => Promise<void>;
  /** 看板健康探测的最小间隔（默认 5 分钟）：健康时不每 tick 打看板；上次失败时下轮立即复查。 */
  kanbanHealthIntervalMs?: number;
  /** stop() 等待在途重连的竞速超时（默认 5s）：超时后继续关闭流程，避免拖累整体退出。 */
  stopTimeoutMs?: number;
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
  /** 看板健康探测节流状态：上次探测时间与结果（失败后逐 tick 复查，见 probeKanban）。 */
  private lastKanbanProbeAt = 0;
  private lastKanbanProbeOk = true;

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

  /** 停止周期探测；等待在途重连结束（调用方随后会 close MCP，避免 connect 中途完成残留无人持有的子进程）。 */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.reconnecting) return;
    // 在途重连最坏 45s 级别（mcp.reconnect 内部多次超时叠加），裸 await 会拖垮调用方的
    // 退出超时兜底：竞速超时后照常返回继续关闭（重连 promise 不 reject，race 不会抛）
    const ms = this.opts.stopTimeoutMs ?? 5000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.reconnecting,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.opts.log?.(`stop 等待在途重连超时（${Math.round(ms / 1000)}s），继续关闭流程`);
            resolve();
          }, ms);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 轮次开始：若有重连进行中，等它结束（拿到的是重连后的新连接）。
   * 与 exitTurn 配对使用（finally）。
   * 无重连时检查-计数在同一同步路径完成（不让出事件循环）：
   * 否则 await 的微任务间隙 tick 可能启动重连，与「重连前确认无轮次」形成竞态。
   */
  async enterTurn(): Promise<void> {
    if (this.reconnecting) await this.reconnecting;
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
        await this.pingWithTimeout();
        // stdio 活着不代表看板后端健康：追加看板探测（内部按间隔节流，不每 tick 打看板）
        await this.probeKanban();
        this.failures = 0;
        if (!this.alive) {
          this.alive = true;
          this.notify('onRecovered');
        }
      } catch {
        this.failures++;
        if (this.alive && this.failures >= threshold) {
          this.alive = false;
          this.notify('onLost');
        }
        // 重连退避：前 3 次连续试，之后每 5 个周期试一次（~5 分钟）
        // （failures=4..7 不试，failures=8、13、18… 试；(failures-3)%5 才对齐注释意图，
        //   此前 failures%5===0 会让 failures=5 时仅隔 2 个周期就重试）
        if (!this.alive && (this.failures <= 3 || (this.failures - 3) % 5 === 0)) {
          await this.tryReconnect();
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * ping 挂起防护：mcp.ping 不接收 AbortSignal，用竞速超时兜底——
   * ping 永不 settle 时按失败处理，否则 busy 永真、健康监督静默停摆。
   */
  private async pingWithTimeout(): Promise<void> {
    const ms = this.opts.pingTimeoutMs ?? 30000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      // 不 unref：ping 挂死时这个定时器必须保证触发（它是 tick 的唯一出路）；
      // ping 正常 settle 时 finally 立刻 clear，不会拖延进程退出
      timer = setTimeout(() => reject(new Error(`MCP ping 超时（${Math.round(ms / 1000)}s）`)), ms);
    });
    try {
      await Promise.race([this.opts.mcp.ping(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 看板后端健康探测（可选）：上次成功时按 kanbanHealthIntervalMs 节流——
   * 不每 tick 打看板（60s 周期全量打后端没必要）；上次失败时逐 tick 复查，
   * 让连续失败尽快到达 failThreshold、走既有 onLost 降级/告警通道。
   */
  private async probeKanban(): Promise<void> {
    const probe = this.opts.kanbanHealth;
    if (!probe) return;
    const interval = this.opts.kanbanHealthIntervalMs ?? 300000;
    if (this.lastKanbanProbeOk && Date.now() - this.lastKanbanProbeAt < interval) return;
    this.lastKanbanProbeAt = Date.now();
    try {
      await probe();
      this.lastKanbanProbeOk = true;
    } catch (err) {
      this.lastKanbanProbeOk = false;
      this.opts.log?.(`看板健康探测失败: ${errMessage(err)}`);
      throw err;
    }
  }

  /** 掉线/恢复回调兜底：回调抛异常不得击穿 tick 成为 unhandledRejection。 */
  private notify(kind: 'onLost' | 'onRecovered'): void {
    try {
      this.opts[kind]?.();
    } catch (err) {
      this.opts.log?.(`${kind} 回调异常: ${errMessage(err)}`);
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
