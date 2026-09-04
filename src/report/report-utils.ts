/**
 * 报告文件公共工具：文件名清洗与历史报告清理。
 * work-summary（report.ts）与 AI 审查（review-report.ts）两类报告共用，
 * 避免清理策略漂移导致某一类报告目录无界增长。
 */

import fs from 'fs';
import path from 'path';

/** 报告文件名片段清洗：非 \w.- 字符折叠为 -；全被洗掉时回退 fallback。 */
export function sanitizeName(s: string, fallback: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

/**
 * 外部可控链接（看板任务 diffUrl 等）渲染前校验：仅放行 http:/https:，
 * 其余（javascript: 等伪协议、畸形串）按无链接处理，返回 undefined。
 */
export function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** 清理 keepDays 天前的历史报告（.html / .md），避免目录无界增长。 */
export function pruneOldReports(dir: string, keepDays = 30): void {
  try {
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.html') && !name.endsWith('.md')) continue;
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* 单个文件失败不阻断 */
      }
    }
  } catch {
    /* 目录不可读时跳过清理 */
  }
}
