/**
 * 飞书长连接断线告警的静默策略：
 * SDK 在网络抖动时会频繁触发 reconnecting/reconnected（断线期间的消息由飞书侧
 * 补投，用户无感），若每次都通知 owner 会刷屏。因此：
 * - 短暂抖动（宽限期内恢复）完全静默；
 * - 断线持续超过 graceMs（默认 3 分钟）才告警一次，恢复时补一条「已恢复」；
 * - 重连彻底失败（SDK 放弃重试，需人工重启）立即告警，但只报一次；
 *   若此后 SDK 又自行连上，补一条「已恢复」并解锁（新一轮失败可再告警）。
 *
 * 宽限期默认 3 分钟的理由：SDK 重连节奏为断开后 0~30s（随机 nonce）内首试，
 * 失败后每次间隔 120s——「首试失败、第二次成功」的普通抖动总时长约 2~2.5 分钟，
 * 宽限期必须覆盖一个完整重连周期，否则这类抖动仍会成对通知。
 */

export type WsAlertState = 'reconnecting' | 'reconnected' | 'failed';

export interface WsAlerterOptions {
  /** 断线持续多久未恢复才告警，默认 180_000ms。 */
  graceMs?: number;
  notify: (text: string) => void;
}

export class WsAlerter {
  private readonly graceMs: number;
  /** 宽限期定时器：断开起算，期间恢复则取消、不告警。 */
  private pending: NodeJS.Timeout | null = null;
  /** 本轮断线是否已告警（决定恢复时是否补「已恢复」）。 */
  private alerted = false;
  /** 「重连失败」只报一次，避免 SDK 重复触发 onError 刷屏。 */
  private failedNotified = false;

  constructor(private readonly opts: WsAlerterOptions) {
    this.graceMs = Math.max(1, opts.graceMs ?? 180_000);
  }

  onState(state: WsAlertState): void {
    if (state === 'reconnecting') {
      // 已在宽限期计时 / 已告警 / 已判失败：不重复动作
      if (this.pending || this.alerted || this.failedNotified) return;
      this.pending = setTimeout(() => {
        this.pending = null;
        this.alerted = true;
        const minutes = Math.max(1, Math.round(this.graceMs / 60000));
        this.opts.notify(
          `⚠️ 飞书长连接已断开超过 ${minutes} 分钟，仍在自动重连…（若长时间未恢复，请在部署机器上重新运行 helios-task-agent bot）`,
        );
      }, this.graceMs);
      this.pending.unref();
    } else if (state === 'reconnected') {
      this.cancelPending();
      const hadAlerted = this.alerted;
      const hadFailed = this.failedNotified;
      this.alerted = false;
      this.failedNotified = false;
      if (hadFailed) {
        // 「重连失败」锁存后 SDK 又自行连上：补恢复通知并解锁，避免 owner 以为仍需重启
        this.opts.notify('✅ 飞书长连接已恢复（此前重连失败，现已自行恢复，无需重启）');
      } else if (hadAlerted) {
        this.opts.notify('✅ 飞书长连接已恢复');
      }
      // 未告警过的快速抖动：静默
    } else {
      // failed：SDK 已放弃重试，机器人收不到消息，必须告知 owner（只报一次）
      this.cancelPending();
      if (this.failedNotified) return;
      this.failedNotified = true;
      this.opts.notify('❌ 飞书长连接重连失败，机器人已收不到消息，请在部署机器上重新运行 helios-task-agent bot。');
    }
  }

  stop(): void {
    this.cancelPending();
  }

  private cancelPending(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }
}
