/**
 * 飞书长连接断线告警策略：让用户无感。
 *
 * SDK 负责自动重连，断线期间的消息由飞书侧补投，用户本无需感知「断开/恢复」
 * ——电脑待机/唤醒会反复断连重连，逐对推送只是刷屏。因此：
 * - reconnecting / reconnected：完全静默（日志由 channel 层输出，/status 可查
 *   连接状态）；
 * - failed（SDK 放弃重试，机器人收不到消息，需人工重启——这是唯一需要用户
 *   处置的情况）：立即告警，但只报一次；若此后 SDK 又自行连上，补一条
 *   「已恢复」并解锁（新一轮失败可再告警）。
 */

export type WsAlertState = 'reconnecting' | 'reconnected' | 'failed';

export interface WsAlerterOptions {
  notify: (text: string) => void;
}

export class WsAlerter {
  /** 「重连失败」只报一次，避免 SDK 重复触发 onError 刷屏。 */
  private failedNotified = false;

  constructor(private readonly opts: WsAlerterOptions) {}

  onState(state: WsAlertState): void {
    if (state === 'failed') {
      if (this.failedNotified) return;
      this.failedNotified = true;
      this.opts.notify('❌ 飞书长连接重连失败，机器人已收不到消息，请在部署机器上重新运行 helios-task-agent bot。');
    } else if (state === 'reconnected') {
      if (!this.failedNotified) return;
      // 「重连失败」锁存后 SDK 又自行连上：补恢复通知并解锁，避免 owner 以为仍需重启
      this.failedNotified = false;
      this.opts.notify('✅ 飞书长连接已恢复（此前重连失败，现已自行恢复，无需重启）');
    }
    // reconnecting：静默
  }

  /** 关机钩子（cleanup 统一调用）；当前无定时器，留作接口占位。 */
  stop(): void {}
}
