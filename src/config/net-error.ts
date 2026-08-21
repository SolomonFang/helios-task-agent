/**
 * 向导联网校验的网络错误友好化：常见模式映射成中文短句；
 * 未命中返回 null，由调用方把原始错误弱化到括号内展示。
 */

import { errMessage } from '../infra/err';

export function friendlyNetError(err: unknown): string | null {
  // Node fetch（undici）连接失败只抛 TypeError: fetch failed，真实原因挂在 err.cause
  // （ECONNREFUSED / ENOTFOUND 等），需解包并入匹配串，否则下面的映射永不命中。
  // 多地址连接失败时 cause 是 AggregateError，子错误的 code 一并并入（兼容不带 code 的旧版 Node）。
  const cause = (err as { cause?: { code?: unknown; message?: unknown; errors?: { code?: unknown; message?: unknown }[] } } | null)?.cause;
  const parts: unknown[] = [errMessage(err), cause?.code, cause?.message];
  if (Array.isArray(cause?.errors)) for (const sub of cause.errors) parts.push(sub?.code, sub?.message);
  const s = parts.filter(Boolean).join(' ').toLowerCase();
  if (/timed?\s*out|etimedout|aborted/.test(s)) return '连接超时';
  if (s.includes('econnrefused')) return '连接被拒（目标地址无服务在监听）';
  if (s.includes('enotfound') || s.includes('eai_again')) return '域名解析失败';
  if (s.includes('fetch failed')) return '网络请求失败（请检查网络 / 代理）';
  return null;
}

/** 错误细节片段：命中映射用「：中文短句」，未命中用「（原始错误）」。 */
export function netErrorDetail(err: unknown): string {
  const mapped = friendlyNetError(err);
  return mapped ? `：${mapped}` : `（${errMessage(err)}）`;
}
