/**
 * AI 审查结果 → 自包含 HTML 报告（无外部资源、无 JS），写入数据目录 reviews/，
 * 由 report-server 提供 HTTP 访问，飞书只推链接，避免长文本被截断。
 */

import fs from 'fs';
import path from 'path';
import { defaultDataHome } from './memory';
import { escapeHtml } from './report';

export interface ReviewReportData {
  /** 任务标题。 */
  title: string;
  attemptId: string;
  /** diff 范围（merge-base(target)..attempt 分支），可选。 */
  fromRef?: string;
  toRef?: string;
  generatedAt: string;
  /** ocr 完整文本输出（markdown 风格）。 */
  text: string;
}

/** 行内格式：**bold**、`code`（输入须已 HTML 转义）。 */
function renderInline(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** 轻量 markdown → HTML：代码围栏、标题、无序/有序列表、段落。 */
export function renderReviewMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceBuf: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inFence) {
        out.push(`<pre><code>${fenceBuf.map(escapeHtml).join('\n')}</code></pre>`);
        fenceBuf = [];
        inFence = false;
      } else {
        closeList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(heading[1]!.length + 1, 6); // # → h2（h1 留给页头），依次下沉
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (listTag !== 'ul') {
        closeList();
        out.push('<ul>');
        listTag = 'ul';
      }
      out.push(`<li>${renderInline(escapeHtml(bullet[1]!))}</li>`);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (listTag !== 'ol') {
        closeList();
        out.push('<ol>');
        listTag = 'ol';
      }
      out.push(`<li>${renderInline(escapeHtml(numbered[1]!))}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    out.push(`<p>${renderInline(escapeHtml(line))}</p>`);
  }
  if (inFence) out.push(`<pre><code>${fenceBuf.map(escapeHtml).join('\n')}</code></pre>`);
  closeList();
  return out.join('\n');
}

export function renderReviewHtml(data: ReviewReportData): string {
  const range =
    data.fromRef && data.toRef ? `${escapeHtml(data.fromRef)} → ${escapeHtml(data.toRef)}` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI 审查 · ${escapeHtml(data.title || '(无标题)')}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #f3f4f8;
    color: #1f2937;
    line-height: 1.7;
    padding: 32px 16px 64px;
  }
  .page { max-width: 880px; margin: 0 auto; }
  .hero {
    background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%);
    color: #fff;
    border-radius: 16px;
    padding: 28px 36px;
    box-shadow: 0 8px 24px rgba(99, 102, 241, 0.25);
  }
  .hero h1 { font-size: 24px; letter-spacing: 1px; }
  .hero .subtitle { font-size: 15px; margin-top: 6px; opacity: 0.95; word-break: break-all; }
  .hero .gen { font-size: 12px; margin-top: 8px; opacity: 0.75; }
  .report {
    background: #fff;
    border-radius: 12px;
    padding: 24px 28px;
    margin-top: 20px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
    font-size: 14px;
    overflow-wrap: break-word;
  }
  .report h2 { font-size: 20px; margin: 20px 0 10px; }
  .report h3 { font-size: 18px; margin: 18px 0 8px; }
  .report h4 { font-size: 16px; margin: 16px 0 6px; }
  .report h5, .report h6 { font-size: 14px; margin: 14px 0 6px; }
  .report p { margin: 6px 0; }
  .report ul, .report ol { margin: 6px 0 10px 22px; }
  .report li { margin: 3px 0; }
  .report code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    padding: 1px 5px;
    color: #374151;
  }
  .report pre {
    background: #0f172a;
    color: #e2e8f0;
    border-radius: 8px;
    padding: 12px 16px;
    margin: 10px 0;
    overflow-x: auto;
  }
  .report pre code {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font-size: 12.5px;
  }
</style>
</head>
<body>
<div class="page">
  <header class="hero">
    <h1>🤖 AI 代码审查</h1>
    <p class="subtitle">${escapeHtml(data.title || '(无标题)')}</p>
    <p class="gen">${range ? `范围 ${range} · ` : ''}生成时间 ${escapeHtml(data.generatedAt)}</p>
  </header>
  <article class="report">
${renderReviewMarkdown(data.text)}
  </article>
</div>
</body>
</html>
`;
}

function sanitizeName(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'review';
}

export function reviewsDir(): string {
  return path.join(defaultDataHome(), 'reviews');
}

/** 清理 30 天前的历史报告，避免目录无界增长。 */
function pruneOldReports(dir: string, keepDays = 30): void {
  try {
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.html')) continue;
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

/** 渲染并写入 HTML 报告，返回文件名（不含目录）。 */
export function writeReviewReport(data: ReviewReportData, dir = reviewsDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  pruneOldReports(dir);
  const name = `review-${sanitizeName(data.title).slice(0, 40)}-${sanitizeName(data.attemptId).slice(0, 24)}-${Date.now()}.html`;
  fs.writeFileSync(path.join(dir, name), renderReviewHtml(data), 'utf8');
  return name;
}
