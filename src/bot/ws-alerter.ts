/**
 * 飞书长连接断线告警策略：短时抖动静默，持续断线低频提醒，failed 立即告警。
 *
 * SDK 负责自动重连，断线期间的消息由飞书侧补投——电脑待机/唤醒的短时断连
 * 用户本无需感知，逐对推送只是刷屏。但 SDK 对网络类错误无限重试，挂机过夜/
 * 断网数小时时 owner 完全无感知（僵尸态），而告警通道（飞书 HTTPS API）与
 * WS 长连接独立，断线期间仍可送达。因此：
 * - reconnecting：首次进入断线起计时，持续超过 remindAfterMs（默认 15 分钟）
 *   才推一条提醒；之后仍处于断开状态时每小时（repeatMs）至多重复一条；
 * - reconnected：取消计时；本轮断线提醒过则补一条「已恢复」；短时抖动（从未
 *   提醒）完全静默；
 * - failed（SDK 放弃重试，机器人收不到消息，需人工重启）：立即告警，只报一次；
 *   若此后 SDK 又自行连上，补一条「已自行恢复」并解锁（新一轮失败可再告警）。
 */

export type WsAlertState = 'reconnecting' | 'reconnected' | 'failed';

export interface WsAlerterOptions {
  notify: (text: string) => void;
  /** 断开持续超过该时长才首次提醒（默认 15 分钟）；测试可注入小值。 */
  remindAfterMs?: number;
  /** 持续断开期间的重复提醒间隔（默认 1 小时）；测试可注入小值。 */
  repeatMs?: number;
}

export class WsAlerter {
  /** 「重连失败」只报一次，避免 SDK 重复触发 onError 刷屏。 */
  private failedNotified = false;
  /** 本轮断线的起始时间（无计时器时为 null）。 */
  private disconnectedAt: number | null = null;
  /** 断线提醒计时器（首提/重复提醒共用，同一时刻至多一个）。 */
  private remindTimer: NodeJS.Timeout | null = null;
  /** 本轮断线是否已提醒过（恢复时据此决定是否补「已恢复」）。 */
  private reminded = false;
  private readonly remindAfterMs: number;
  private readonly repeatMs: number;

  constructor(private readonly opts: WsAlerterOptions) {
    this.remindAfterMs = opts.remindAfterMs ?? 15 * 60_000;
    this.repeatMs = opts.repeatMs ?? 60 * 60_000;
  }

  onState(state: WsAlertState): void {
    if (state === 'reconnecting') {
      // failed 锁存期间的抖动不再打扰（已告警过「需人工重启」）；计时中重复触发忽略
      if (this.failedNotified || this.remindTimer) return;
      this.disconnectedAt = Date.now();
      this.remindTimer = setTimeout(() => this.remind(), this.remindAfterMs);
      this.remindTimer.unref();
    } else if (state === 'reconnected') {
      this.clearTimer();
      if (this.failedNotified) {
        // 「重连失败」锁存后 SDK 又自行连上：补恢复通知并解锁，避免 owner 以为仍需重启
        this.failedNotified = false;
        this.opts.notify('✅ 飞书长连接已自行恢复（此前重连失败，无需重启）');
      } else if (this.reminded) {
        this.opts.notify('✅ 飞书长连接已恢复');
      }
      // 短时抖动从未提醒过：完全静默
      this.reminded = false;
      this.disconnectedAt = null;
    } else {
      // failed：取消断线计时，维持「只报一次」；恢复文案交由 failed 锁存路径
      this.clearTimer();
      this.reminded = false;
      this.disconnectedAt = null;
      if (this.failedNotified) return;
      this.failedNotified = true;
      this.opts.notify('❌ 飞书长连接重连失败，机器人已收不到消息，请在部署机器上重新运行 helios-task-agent bot。');
    }
  }

  /** 到点提醒：首提后按 repeatMs 节奏重复，直到恢复/失败/stop 取消计时。 */
  private remind(): void {
    this.remindTimer = null;
    if (!this.reminded) {
      this.reminded = true;
      const mins = Math.max(1, Math.round(this.remindAfterMs / 60_000));
      this.opts.notify(
        `⚠️ 飞书长连接已断开超过 ${mins} 分钟，仍在自动重连；期间发给我的消息会在恢复后补投处理。` +
          '若长时间未恢复，请在部署机器上重新运行 helios-task-agent bot。',
      );
    } else {
      const elapsed = Date.now() - (this.disconnectedAt ?? Date.now());
      // floor 只少报不多报（round 会把 1.6 小时报成「超过 2 小时」）；重启出路与首提保持一致
      const hours = Math.max(1, Math.floor(elapsed / 3_600_000));
      this.opts.notify(
        `⚠️ 飞书长连接仍未恢复（已断开超过 ${hours} 小时），仍在自动重连；期间消息会在恢复后补投处理。` +
          '如需立即恢复，请在部署机器上重新运行 helios-task-agent bot。',
      );
    }
    this.remindTimer = setTimeout(() => this.remind(), this.repeatMs);
    this.remindTimer.unref();
  }

  private clearTimer(): void {
    if (this.remindTimer) {
      clearTimeout(this.remindTimer);
      this.remindTimer = null;
    }
  }

  /** 关机钩子（cleanup 统一调用）：清理断线提醒计时器。 */
  stop(): void {
    this.clearTimer();
  }
}
