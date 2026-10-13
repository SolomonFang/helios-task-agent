/**
 * 网络错误友好化（向导联网校验 / 看板层 failure-diagnosis 共用）：常见模式映射成中文
 * 短句；friendlyNetError 未命中时返回通用定性（永不返回 null），原始错误只进
 * HTA_DEBUG 日志（不落用户面）。
 */

import { errMessage } from '../infra/err';

interface ErrFragment {
  code?: unknown;
  message?: unknown;
  errors?: unknown;
}

/**
 * 收集错误匹配文本：Node fetch（undici）连接失败只抛 TypeError: fetch failed，真实
 * 原因挂在 err.cause（ECONNREFUSED / ENOTFOUND 等），需解包并入匹配串，否则下面的
 * 映射永不命中。多地址连接失败时 cause 或 err 本身是 AggregateError（errors 数组），
 * 子错误的 code/message 逐条并入（兼容不带 code 的旧版 Node）。
 */
function collectParts(err: unknown): unknown[] {
  const e = err as (ErrFragment & { cause?: ErrFragment | null }) | null;
  const cause = e?.cause;
  const parts: unknown[] = [errMessage(err), cause?.code, cause?.message];
  for (const errors of [cause?.errors, e?.errors]) {
    if (Array.isArray(errors)) {
      for (const sub of errors as Array<ErrFragment | null>) parts.push(sub?.code, sub?.message);
    }
  }
  return parts;
}

/** 命中映射返回中文短句；未命中返回 null（内部用，供 netErrorDetail 区分已映射/兜底）。 */
function matchNetError(err: unknown): string | null {
  const s = collectParts(err).filter(Boolean).join(' ').toLowerCase();
  if (/timed?\s*out|etimedout|aborted/.test(s)) return '连接超时';
  if (s.includes('econnrefused')) return '连接被拒（目标地址无服务在监听）';
  if (s.includes('enotfound') || s.includes('eai_again')) return '域名解析失败';
  if (s.includes('fetch failed')) return '网络请求失败（请检查网络/代理）';
  return null;
}

/** 网络错误友好化：命中映射返回中文短句，未命中返回通用定性（跨层复用方按 string 消费）。 */
export function friendlyNetError(err: unknown): string {
  return matchNetError(err) ?? '网络请求失败';
}

/** 错误细节片段：统一「：中文短句」；未命中映射时给通用定性，原文收 HTA_DEBUG 日志。 */
export function netErrorDetail(err: unknown): string {
  const mapped = matchNetError(err);
  if (mapped) return `：${mapped}`;
  if (process.env.HTA_DEBUG) console.error(`[config] 网络错误原文：${errMessage(err)}`);
  return '：网络请求失败';
}
