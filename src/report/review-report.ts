/**
 * AI 审查结果 → 自包含 HTML 报告（无外部资源、无 JS），写入数据目录 reviews/，
 * 由 report-server 提供 HTTP 访问，飞书只推链接，避免长文本被截断。
 *
 * ocr --format text 的输出有固定结构：
 *   [ocr] Summary: N file(s) reviewed, M comment(s), ... elapsed
 *   ─── path/to/file.js:357-360 ───
 *   [bug · high] 问题描述……
 *   - 旧代码
 *   + 新代码
 * 解析为「概览 + 分级卡片 + diff 高亮」；识别不到该结构时回退为扁平 markdown 渲染。
 */

import path from 'path';
import { defaultDataHome } from '../infra/paths';
import { escapeHtml } from './report';
import { renderReportPage } from './report-page';
import { ensurePrivateDirSync, writeFilePrivateSync } from '../infra/private-file';
import { newReportToken } from './report-server';
import { pruneOldReports, sanitizeName } from './report-utils';

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

// ---------- ocr 文本结构解析 ----------

export interface ReviewFinding {
  /** 文件路径。 */
  file: string;
  /** 行范围（如 "357-360"），可能为空。 */
  lines: string;
  /** 类别原文（bug / performance / …），可能为空。 */
  category: string;
  /** 严重度原文（high / medium / …），可能为空。 */
  severity: string;
  /** 该条意见的详细说明（含代码片段、修改建议）。 */
  body: string;
}

export interface ParsedReview {
  /** [ocr] Summary: 后的统计原文。 */
  summary?: string;
  /** 首个分隔符之前的补充文本（summary 行已剔除）。 */
  intro: string;
  findings: ReviewFinding[];
}

/** 意见分隔符：─── path/to/file:10-20 ───（兼容 ─/—/- 混用，要求含 :行号，避免误匹配分隔线）。 */
const SEP_RE = /^[─—-]{3,}\s*(.+?:\d+(?:\s*-\s*\d+)?)\s*[─—-]{3,}\s*$/;
/** 意见首行的类别与严重度标签：[bug · high] … */
const TAG_RE = /^\[([^\]·•・|]+)\s*[·•・|]\s*([^\]]+)\]\s*(.*)$/;

/** 解析 ocr --format text 输出；无分隔符结构时返回 null（调用方回退扁平渲染）。 */
export function parseOcrReview(text: string): ParsedReview | null {
  const lines = text.split('\n');
  const sepIdx: number[] = [];
  lines.forEach((l, i) => {
    if (SEP_RE.test(l)) sepIdx.push(i);
  });
  if (!sepIdx.length) return null;

  let summary: string | undefined;
  const intro = lines
    .slice(0, sepIdx[0]!)
    .filter((l) => {
      const m = /^\s*\[ocr\]\s*Summary:\s*(.+)$/i.exec(l);
      if (m) {
        summary = m[1]!.trim();
        return false;
      }
      return true;
    })
    .join('\n')
    .trim();

  const findings: ReviewFinding[] = [];
  for (let k = 0; k < sepIdx.length; k++) {
    const head = SEP_RE.exec(lines[sepIdx[k]!]!)![1]!.trim();
    const lm = /^(.*):(\d+(?:\s*-\s*\d+)?)$/.exec(head);
    const file = (lm ? lm[1]! : head).trim();
    const lineRange = lm ? lm[2]!.replace(/\s+/g, '') : '';
    const bodyLines = lines.slice(sepIdx[k]! + 1, k + 1 < sepIdx.length ? sepIdx[k + 1]! : lines.length);
    let category = '';
    let severity = '';
    while (bodyLines.length && !bodyLines[0]!.trim()) bodyLines.shift();
    const tag = TAG_RE.exec(bodyLines[0] ?? '');
    if (tag) {
      category = tag[1]!.trim();
      severity = tag[2]!.trim();
      bodyLines[0] = tag[3]!;
    }
    findings.push({ file, lines: lineRange, category, severity, body: bodyLines.join('\n').trim() });
  }
  return { summary, intro, findings };
}

// ---------- 结构化渲染 ----------

interface SevMeta {
  cls: 'critical' | 'high' | 'medium' | 'low' | 'info';
  label: string;
}

const SEV_MAP: Record<string, SevMeta> = {
  critical: { cls: 'critical', label: '严重' },
  blocker: { cls: 'critical', label: '严重' },
  high: { cls: 'high', label: '高' },
  major: { cls: 'high', label: '高' },
  medium: { cls: 'medium', label: '中' },
  low: { cls: 'low', label: '低' },
  minor: { cls: 'low', label: '低' },
  info: { cls: 'info', label: '提示' },
  严重: { cls: 'critical', label: '严重' },
  高: { cls: 'high', label: '高' },
  中: { cls: 'medium', label: '中' },
  低: { cls: 'low', label: '低' },
};

function sevMeta(raw: string): SevMeta {
  return SEV_MAP[raw.trim().toLowerCase()] ?? { cls: 'info', label: raw.trim() || '提示' };
}

/**
 * 是否「全部通过」：结构化解析无任何意见，或 ocr Summary 明确 0 comment(s)。
 * 无分隔符且也无 0 comment 线索的自由文本不算（无法区分「无意见」与「解析失败」）。
 */
export function isAllPass(text: string, parsed?: ParsedReview | null): boolean {
  const p = parsed === undefined ? parseOcrReview(text) : parsed;
  if (p) return p.findings.length === 0;
  return /(?<!\d)0\s*comment\(s\)/i.test(text);
}

const CAT_LABELS: Record<string, string> = {
  bug: '缺陷',
  security: '安全',
  performance: '性能',
  maintainability: '可维护性',
  readability: '可读性',
  style: '风格',
  docs: '文档',
  test: '测试',
};

function catLabel(raw: string): string {
  return CAT_LABELS[raw.trim().toLowerCase()] ?? raw.trim();
}

/** diff 候选行：带 +/- 前缀，或缩进 ≥2 的代码上下文行。 */
function isCodeCandidate(line: string): boolean {
  return /^\s*[+-]\s*\S/.test(line) || /^[ \t]{2,}\S/.test(line);
}

/** 符号行去掉 +/- 后是否像代码（避免把 markdown 列表误当 diff）。 */
function looksLikeCode(s: string): boolean {
  return (
    /[()[\]{};=]|=>/.test(s) ||
    /^\s*(const|let|var|function|return|if|for|while|import|export|await|new|this\.)\b/.test(s)
  );
}

/** 一段 diff/代码行 → 逐行着色的 <pre>。 */
function renderDiffBlock(run: string[]): string {
  const rows = run.map((line) => {
    const m = /^\s*([+-])/.exec(line);
    const cls = m ? (m[1] === '+' ? 'add' : 'del') : 'ctx';
    return `<span class="dl ${cls}">${escapeHtml(line)}</span>`;
  });
  return `<pre class="diff">${rows.join('\n')}</pre>`;
}

/** 意见正文：把连续的 +/- / 缩进代码行识别为 diff 块，其余按 markdown 渲染。 */
function renderFindingBody(body: string): string {
  if (!body.trim()) return '<p class="empty">（无详细说明）</p>';
  const lines = body.split('\n');
  const out: string[] = [];
  let prose: string[] = [];
  let inFence = false;
  const flush = () => {
    const chunk = prose.join('\n');
    prose = [];
    if (chunk.trim()) out.push(renderReviewMarkdown(chunk));
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      prose.push(line);
      i++;
      continue;
    }
    if (!inFence && isCodeCandidate(line)) {
      const run: string[] = [];
      while (i < lines.length && isCodeCandidate(lines[i]!) && !/^\s*```/.test(lines[i]!)) {
        run.push(lines[i]!);
        i++;
      }
      const isDiff = run.some((l) => {
        const m = /^\s*[+-]\s*(.*)$/.exec(l);
        return m ? looksLikeCode(m[1]!) : false;
      });
      if (isDiff) {
        flush();
        out.push(renderDiffBlock(run));
      } else {
        prose.push(...run);
      }
      continue;
    }
    prose.push(line);
    i++;
  }
  flush();
  return out.join('\n');
}

function renderFinding(f: ReviewFinding, idx: number): string {
  const sev = sevMeta(f.severity);
  const cat = catLabel(f.category);
  const loc = f.lines
    ? `${escapeHtml(f.file)}<span class="lines">:${escapeHtml(f.lines)}</span>`
    : escapeHtml(f.file);
  return `<section class="finding sev-${sev.cls}">
  <header class="finding-head">
    <span class="fno">#${idx + 1}</span>
    <span class="sev sev-${sev.cls}">${escapeHtml(sev.label)}</span>
    ${cat ? `<span class="cat">${escapeHtml(cat)}</span>` : ''}
    <code class="loc">${loc}</code>
  </header>
  <div class="finding-body md">
${renderFindingBody(f.body)}
  </div>
</section>`;
}

function fmtNum(v: string): string {
  return v.replace(/\d+/g, (d) => d.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
}

/** [ocr] Summary 原文 → 统计 chips；解析不到时原样展示。 */
function summaryChips(summary: string | undefined): string {
  if (!summary) return '';
  const defs: Array<[RegExp, string]> = [
    [/(\d+)\s*file\(s\)\s*reviewed/i, '审查文件'],
    [/(\d+)\s*comment\(s\)/i, '意见数'],
    [/(~?[\d,]+)\s*token\(s\)/i, 'Token 消耗'],
    [/([\d.hms]+)\s*elapsed/i, '耗时'],
  ];
  const chips = defs
    .map(([re, label]) => {
      const m = re.exec(summary);
      return m ? `<span class="chip"><b>${escapeHtml(fmtNum(m[1]!))}</b> ${label}</span>` : '';
    })
    .filter(Boolean);
  return chips.length ? chips.join('') : `<span class="chip">${escapeHtml(summary)}</span>`;
}

/** 结构化渲染：概览卡（严重度分布 + ocr 统计）+ 逐条意见卡片。 */
function renderStructured(parsed: ParsedReview): string {
  const counts = new Map<string, { meta: SevMeta; n: number }>();
  for (const f of parsed.findings) {
    const meta = sevMeta(f.severity);
    const cur = counts.get(meta.cls);
    if (cur) cur.n++;
    else counts.set(meta.cls, { meta, n: 1 });
  }
  const order: SevMeta['cls'][] = ['critical', 'high', 'medium', 'low', 'info'];
  const sevBadges = order
    .map((cls) => counts.get(cls))
    .filter((c): c is { meta: SevMeta; n: number } => Boolean(c))
    .map((c) => `<span class="sev sev-${c.meta.cls}">${escapeHtml(c.meta.label)} × ${c.n}</span>`)
    .join('');
  const chips = summaryChips(parsed.summary);
  const parts: string[] = [];
  parts.push(`<section class="summary">
    <span class="total">共 ${parsed.findings.length} 条审查意见</span>
    ${sevBadges}
    ${chips ? `<span class="chip-group">${chips}</span>` : ''}
  </section>`);
  if (parsed.intro) {
    parts.push(`<article class="report md">\n${renderReviewMarkdown(parsed.intro)}\n  </article>`);
  }
  parts.push(`<div class="findings">\n${parsed.findings.map(renderFinding).join('\n')}\n  </div>`);
  return parts.join('\n  ');
}

/** 全通过时的夸赞语，随机选一句，避免每次都是同一句。 */
const PASS_PRAISES = [
  '真棒！代码干净得像刚擦过的玻璃。',
  '漂亮！AI 都没挑出毛病。',
  '稳！这次变更一条意见都没有。',
  '优秀！审查全绿，放心合并。',
];

/** 从原文中提取 [ocr] Summary 行（parseOcrReview 无分隔符返回 null 时兜底）。 */
function extractSummary(text: string): string | undefined {
  const m = /^\s*\[ocr\]\s*Summary:\s*(.+)$/im.exec(text);
  return m ? m[1]!.trim() : undefined;
}

/** 全通过渲染：庆祝横幅 + ocr 统计（若有）。 */
function renderPass(parsed: ParsedReview | null, text: string): string {
  const praise = PASS_PRAISES[Math.floor(Math.random() * PASS_PRAISES.length)]!;
  const chips = summaryChips(parsed?.summary ?? extractSummary(text));
  const parts: string[] = [];
  parts.push(`<section class="pass-banner">
    <div class="pass-emoji">🎉</div>
    <h2>审查全部通过</h2>
    <p class="pass-praise">${escapeHtml(praise)}</p>
    ${chips ? `<div class="chip-group pass-chips">${chips}</div>` : ''}
  </section>`);
  if (parsed?.intro) {
    parts.push(`<article class="report md">\n${renderReviewMarkdown(parsed.intro)}\n  </article>`);
  }
  return parts.join('\n  ');
}

/** AI 审查页面专属区块样式（公共基底与页框见 report-page.ts）。 */
const REVIEW_PAGE_CSS = `
  body { background: #f1f5f9; line-height: 1.7; }
  .page { max-width: 920px; }
  .hero {
    background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%);
    padding: 28px 36px;
  }
  .hero h1 { font-size: 24px; }
  .hero .subtitle { font-size: 15px; word-break: break-all; }
  .hero .gen { margin-top: 8px; }
  .hero.pass {
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    box-shadow: 0 8px 24px rgba(16, 185, 129, 0.25);
  }

  /* 全通过庆祝横幅 */
  .pass-banner {
    background: linear-gradient(180deg, #ecfdf5 0%, #ffffff 70%);
    border: 1px solid #a7f3d0;
    border-radius: 16px;
    margin-top: 20px;
    padding: 44px 32px;
    text-align: center;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }
  .pass-banner .pass-emoji { font-size: 56px; line-height: 1.2; }
  .pass-banner h2 { font-size: 22px; color: #047857; margin-top: 14px; letter-spacing: 1px; }
  .pass-banner .pass-praise { font-size: 15px; color: #059669; margin-top: 8px; }
  .pass-banner .pass-chips { display: inline-flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; justify-content: center; }

  /* 概览卡 */
  .summary {
    background: #fff;
    border-radius: 12px;
    padding: 14px 22px;
    margin-top: 20px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .summary .total { font-size: 14px; font-weight: 600; color: #334155; margin-right: 4px; }
  .summary .chip-group { display: inline-flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
  .chip {
    font-size: 12.5px;
    color: #475569;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 999px;
    padding: 3px 12px;
    white-space: nowrap;
  }
  .chip b { color: #0f172a; font-weight: 600; }

  /* 严重度徽章（药丸基底在 report-page.BASE_CSS，这里只补布局差量） */
  .sev {
    display: inline-block;
    line-height: 1.5;
  }
  .sev-critical { background: #fee2e2; color: #b91c1c; }
  .sev-high { background: #ffedd5; color: #c2410c; }
  .sev-medium { background: #fef9c3; color: #a16207; }
  .sev-low { background: #dbeafe; color: #1d4ed8; }
  .sev-info { background: #e2e8f0; color: #475569; }

  /* 意见卡片 */
  .finding {
    background: #fff;
    border-radius: 12px;
    padding: 18px 24px;
    margin-top: 16px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
    border-left: 4px solid #cbd5e1;
  }
  .finding.sev-critical { border-left-color: #dc2626; }
  .finding.sev-high { border-left-color: #ea580c; }
  .finding.sev-medium { border-left-color: #d97706; }
  .finding.sev-low { border-left-color: #3b82f6; }
  .finding.sev-info { border-left-color: #94a3b8; }
  .finding-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding-bottom: 10px;
    margin-bottom: 12px;
    border-bottom: 1px solid #f1f5f9;
  }
  .fno { font-size: 12px; font-weight: 700; color: #94a3b8; }
  .cat {
    font-size: 12px;
    color: #475569;
    border: 1px solid #cbd5e1;
    border-radius: 999px;
    padding: 2px 10px;
    white-space: nowrap;
  }
  .loc {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    color: #334155;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 2px 8px;
    word-break: break-all;
  }
  .loc .lines { color: #94a3b8; }

  /* 回退 / 引言的整段报告卡 */
  .report {
    background: #fff;
    border-radius: 12px;
    padding: 24px 28px;
    margin-top: 20px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }

  /* markdown 正文（报告卡与意见正文共用） */
  .md { font-size: 14px; overflow-wrap: break-word; }
  .md > :first-child { margin-top: 0; }
  .md h2 {
    font-size: 19px;
    margin: 24px 0 12px;
    padding-left: 10px;
    border-left: 4px solid #6366f1;
    line-height: 1.4;
    color: #111827;
  }
  .md h3 { font-size: 16.5px; margin: 20px 0 8px; color: #111827; }
  .md h4 { font-size: 15px; margin: 16px 0 6px; }
  .md h5, .md h6 { font-size: 14px; margin: 14px 0 6px; color: #374151; }
  .md p { margin: 6px 0; }
  .md ul, .md ol { margin: 6px 0 10px 22px; }
  .md li { margin: 3px 0; }
  .md .empty { color: #94a3b8; }
  /* 等宽基底在 report-page.BASE_CSS，这里只补尺寸差量 */
  .md code {
    font-size: 12.5px;
    border-radius: 4px;
    padding: 1px 5px;
  }
  .md pre {
    background: #0f172a;
    color: #e2e8f0;
    border-radius: 8px;
    padding: 12px 16px;
    margin: 10px 0;
    overflow-x: auto;
  }
  .md pre code {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font-size: 12.5px;
  }

  /* diff 块：逐行红/绿高亮 */
  .md pre.diff {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    padding: 8px 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.65;
  }
  .diff .dl { display: block; padding: 0 12px; white-space: pre; }
  .diff .del { background: #fef2f2; color: #b91c1c; }
  .diff .add { background: #f0fdf4; color: #15803d; }
  .diff .ctx { color: #64748b; }
`;

export function renderReviewHtml(data: ReviewReportData): string {
  const range =
    data.fromRef && data.toRef ? `${escapeHtml(data.fromRef)} → ${escapeHtml(data.toRef)}` : '';
  const parsed = parseOcrReview(data.text);
  const pass = isAllPass(data.text, parsed);
  const content = pass
    ? renderPass(parsed, data.text)
    : parsed
      ? renderStructured(parsed)
      : `<article class="report md">\n${renderReviewMarkdown(data.text)}\n  </article>`;
  return renderReportPage({
    title: `AI 审查 · ${escapeHtml(data.title || '(无标题)')}`,
    css: REVIEW_PAGE_CSS,
    body: `  <header class="hero${pass ? ' pass' : ''}">
    <h1>${pass ? '✅' : '🤖'} AI 代码审查${pass ? ' · 全部通过' : ''}</h1>
    <p class="subtitle">${escapeHtml(data.title || '(无标题)')}</p>
    <p class="gen">${range ? `范围 ${range} · ` : ''}生成时间 ${escapeHtml(data.generatedAt)}</p>
  </header>
  ${content}`,
  });
}

export function reviewsDir(): string {
  return path.join(defaultDataHome(), 'reviews');
}

/** 渲染并写入 HTML 报告（0600），返回文件名（不含目录）；文件名带随机 token 作为访问凭证。 */
export function writeReviewReport(data: ReviewReportData, dir = reviewsDir()): string {
  ensurePrivateDirSync(dir);
  pruneOldReports(dir);
  const name = `review-${sanitizeName(data.title, 'review').slice(0, 40)}-${newReportToken()}-${sanitizeName(data.attemptId, 'review').slice(0, 24)}-${Date.now()}.html`;
  writeFilePrivateSync(path.join(dir, name), renderReviewHtml(data));
  return name;
}
