import { errMessage } from '../infra/err';

/** notifyOpenId 的最小类型面：handler 的 FeishuChannel 与各 fake channel 都满足。 */
export interface NotifyChannel {
  notifyOpenId(openId: string, text: string): Promise<void>;
}

/**
 * 通知投递兜底：失败记日志不抛出（替代散落的 `.catch(() => {})` 静默模板，
 * 静默吞掉丢排查线索；open_id 只记头尾摘要，与 confirm 裁决日志同口径）。
 */
export async function safeNotify(channel: NotifyChannel, openId: string, text: string): Promise<void> {
  try {
    await channel.notifyOpenId(openId, text);
  } catch (err) {
    console.error(`[bot] 通知投递失败(${openId.slice(0, 4)}…): ${errMessage(err)}`);
  }
}
