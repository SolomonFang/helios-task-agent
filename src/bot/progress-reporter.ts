/**
 * 进度占位消息与最终回复投递（自 handler.ts 抽出）：
 * 占位「⏳ 处理中…」随工具调用节流更新、静默期心跳刷新、完成时原地替换为最终回复
 * （超长自动拆分续发；轮次内插卡片等独立消息时改发新消息保持时间线顺序）。
 */

import { splitText, type FeishuChannel } from '../channels/feishu';
import { toolActionLabel } from '../commands';
import type { InboundMessage, ProgressInfo } from '../types';
import { errMessage } from '../infra/err';

/** 占位/投递实际用到的 channel 方法子集（fake channel 单测同样满足）。 */
export type ProgressChannel = Pick<FeishuChannel, 'sendText' | 'updateText' | 'reply'>;

export interface ProgressKitDeps {
  channel: ProgressChannel;
  /** 静默期心跳间隔（测试注入缩短；默认 PROGRESS_HEARTBEAT_MS 由 handler 传入）。 */
  heartbeatMs: number;
  /** 写操作确认挂起判断（心跳文案分支：挂起期间实际在等用户裁决，「仍在处理」是谎称）。 */
  hasPendingConfirm: (openId: string) => boolean;
}

export interface ProgressKit {
  /** 进度占位消息：发送失败仅记日志，最终回复回退 reply 直发。 */
  sendPlaceholder: (msg: InboundMessage) => Promise<string | undefined>;
  /** 进度反馈：占位消息随工具调用节流更新（飞书消息更新限流，2 秒内合并）；activity 供静默期心跳判断。 */
  createProgressReporter: (
    progressId: string | undefined,
    activity: { lastEventAt: number },
  ) => (info: ProgressInfo) => void;
  /**
   * 静默期心跳：LLM 长思考期间没有任何工具事件，占位消息原地不动，用户分不清「在想」还是「死了」。
   * 每 intervalMs 检查一次，静默超阈值则刷新占位并附已等待秒数；回复就绪即停（clearHeartbeat 在投递前调用）。
   */
  startProgressHeartbeat: (
    progressId: string | undefined,
    activity: { lastEventAt: number },
    openId: string,
  ) => () => void;
  /** 最终回复投递：有占位消息则替换之（超长自动拆分续发），占位缺失时回退 reply。 */
  deliverReply: (
    msg: InboundMessage,
    progressId: string | undefined,
    reply: string,
    interleaved?: boolean,
  ) => Promise<void>;
}

export function createProgressKit(deps: ProgressKitDeps): ProgressKit {
  const { channel, heartbeatMs, hasPendingConfirm } = deps;

  const sendPlaceholder = async (msg: InboundMessage): Promise<string | undefined> => {
    try {
      return await channel.sendText(msg.sessionId, '⏳ 处理中…');
    } catch (err) {
      const message = errMessage(err);
      console.error(`[feishu] 占位消息发送失败: ${message}`);
      return undefined;
    }
  };

  const createProgressReporter = (
    progressId: string | undefined,
    activity: { lastEventAt: number },
  ): ((info: ProgressInfo) => void) => {
    let lastPush = 0;
    return (info: ProgressInfo) => {
      activity.lastEventAt = Date.now();
      if (!progressId) return;
      const now = activity.lastEventAt;
      if (now - lastPush < 2000) return; // 飞书消息更新限流
      lastPush = now;
      const text = info.type === 'tool' ? `⏳ 处理中…（${toolActionLabel(info.name)}）` : '⏳ 思考中…';
      void channel.updateText(progressId, text).catch(() => {});
    };
  };

  const startProgressHeartbeat = (
    progressId: string | undefined,
    activity: { lastEventAt: number },
    openId: string,
  ): (() => void) => {
    if (!progressId) return () => {};
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - activity.lastEventAt < heartbeatMs) return;
      // 确认挂起期间实际在等用户裁决，「仍在处理」是谎称
      const text = hasPendingConfirm(openId)
        ? '⏳ 等待你处理上方的写操作确认…'
        : `⏳ 仍在处理…（已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒；/stop 可中断）`;
      void channel.updateText(progressId, text).catch(() => {});
    }, heartbeatMs);
    timer.unref();
    return () => clearInterval(timer);
  };

  const deliverReply = async (
    msg: InboundMessage,
    progressId: string | undefined,
    reply: string,
    interleaved = false,
  ): Promise<void> => {
    const chunks = splitText(reply || '（无回复）');
    if (progressId && interleaved) {
      // 轮次中插入了确认卡片等独立消息：占位停在它们上方，原地改文案会时序颠倒。
      // 占位收尾为短终态（中性措辞：正文可能是「已中止」等，不宜恒称「已完成」），正文另发新消息落在时间线末尾（分段各自兜底，同下方续发策略）。
      await channel
        .updateText(progressId, '处理结束，结果见下方 ⬇️')
        .catch((err) => console.error(`[feishu] 占位收尾更新失败: ${errMessage(err)}`));
      let chunkFailed = false;
      for (const chunk of chunks) {
        try {
          await channel.sendText(msg.sessionId, chunk);
        } catch (err) {
          chunkFailed = true;
          console.error(`[feishu] 回复分段失败（后续分段继续投递）: ${errMessage(err)}`);
        }
      }
      if (chunkFailed) {
        await channel
          .sendText(msg.sessionId, '⚠️ 上方回复有部分内容发送失败，可能不完整，可再问一次。')
          .catch((err) => console.error(`[feishu] 分段失败提示也未送达: ${errMessage(err)}`));
      }
      return;
    }
    if (progressId) {
      let firstDelivered = false;
      try {
        await channel.updateText(progressId, chunks[0]!);
        firstDelivered = true;
      } catch (err) {
        console.error(`[feishu] 首段更新占位消息失败，尝试直接发送: ${errMessage(err)}`);
        try {
          await channel.sendText(msg.sessionId, chunks[0]!);
          firstDelivered = true;
          // 直发兜底成功：占位还停在「⏳ 处理中…」（心跳已清不再刷新），best-effort 收尾为终态
          await channel.updateText(progressId, '✅ 已完成，结果见下方 ⬇️').catch(() => {});
        } catch (err2) {
          console.error(`[feishu] 首段直接发送也失败: ${errMessage(err2)}`);
        }
      }
      // 续发逐段独立兜底：一段失败记日志继续发后续段，不再让剩余段静默丢失；
      // 任一段失败后最后补发一条提示，否则用户拿到残文却不知情
      let chunkFailed = false;
      for (const chunk of chunks.slice(1)) {
        try {
          await channel.sendText(msg.sessionId, chunk);
        } catch (err) {
          chunkFailed = true;
          console.error(`[feishu] 回复续发分段失败（后续分段继续投递）: ${errMessage(err)}`);
        }
      }
      if (chunkFailed) {
        await channel
          .sendText(msg.sessionId, '⚠️ 上方回复有部分内容发送失败，可能不完整，可再问一次。')
          .catch((err) => console.error(`[feishu] 分段失败提示也未送达: ${errMessage(err)}`));
      }
      if (!firstDelivered) {
        // 首段彻底失败：占位消息还停在「处理中」，尽量更新为失败提示，别让用户干等
        await channel.updateText(progressId, '⚠️ 回复投递失败，请重试或稍后再问。').catch(() => {});
      }
    } else {
      await channel.reply(msg, reply || '（无回复）');
    }
  };

  return { sendPlaceholder, createProgressReporter, startProgressHeartbeat, deliverReply };
}
