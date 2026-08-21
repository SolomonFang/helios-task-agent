/**
 * 向导联网校验的网络错误友好化：常见模式映射成中文短句；
 * 未命中返回 null，由调用方把原始错误弱化到括号内展示。
 */

import { errMessage } from '../infra/err';

export function friendlyNetError(err: unknown): string | null {
  const s = errMessage(err).toLowerCase();
  if (/timed?\s*out|etimedout|aborted/.test(s)) return '连接超时';
  if (s.includes('econnrefused')) return '连接被拒（目标地址无服务在监听）';
  if (s.includes('enotfound') || s.includes('eai_again')) return '域名解析失败';
  return null;
}

/** 错误细节片段：命中映射用「：中文短句」，未命中用「（原始错误）」。 */
export function netErrorDetail(err: unknown): string {
  const mapped = friendlyNetError(err);
  return mapped ? `：${mapped}` : `（${errMessage(err)}）`;
}
