/**
 * Work-summary report rendering (Markdown + self-contained HTML) and writing.
 * HTML is fully inline-styled: no external resources, no JS.
 */

import path from 'path';
import { defaultDataHome } from '../infra/paths';
import { isLoopbackUrl } from '../infra/url-utils';
import { escapeHtml, renderReportPage } from './report-page';
import { writeFilePrivateSync, ensurePrivateDirSync } from '../infra/private-file';
import { newReportToken } from './report-server';
import { pruneOldReports, sanitizeName } from './report-utils';
import { TASK_STATUS_KEYS, statusLabel } from '../kanban/status';
import type { WorkSummaryData, WorkSummaryTask } from '../kanban/summary';

// escapeHtml 已移到 report-page.ts（两个报告渲染器共用）；re-export 兼容既有调用方
export { escapeHtml } from './report-page';

interface StatusMeta {
  emoji: string;
  label: string;
  badge: string; // css class
}

const STATUS_ORDER = TASK_STATUS_KEYS;

/** 状态展示层扩展（emoji/badge）；状态键与中文 label 的唯一来源见 kanban/status.ts。 */
const STATUS_META: Record<string, { emoji: string; badge: string }> = {
  done: { emoji: '✅', badge: 'done' },
  inreview: { emoji: '🔍', badge: 'inreview' },
  inprogress: { emoji: '🚧', badge: 'inprogress' },
  todo: { emoji: '📋', badge: 'todo' },
  cancelled: { emoji: '🚫', badge: 'cancelled' },
};

function statusMeta(status: string): StatusMeta {
  const meta = STATUS_META[status];
  if (meta) return { ...meta, label: statusLabel(status) };
  return { emoji: '🗂', label: statusLabel(status) || '其他', badge: 'todo' };
}

/** 分组：已知状态按固定顺序，未知状态排在最后。 */
function groupByStatus(tasks: WorkSummaryTask[]): Array<{ status: string; meta: StatusMeta; tasks: WorkSummaryTask[] }> {
  const groups = new Map<string, WorkSummaryTask[]>();
  for (const t of tasks) {
    const list = groups.get(t.status) ?? [];
    list.push(t);
    groups.set(t.status, list);
  }
  const ordered = [...STATUS_ORDER.filter((s) => groups.has(s)), ...[...groups.keys()].filter((s) => !(STATUS_ORDER as readonly string[]).includes(s))];
  return ordered.map((status) => ({ status, meta: statusMeta(status), tasks: groups.get(status)! }));
}

function diffStatsLine(t: WorkSummaryTask): string {
  const parts: string[] = [];
  if (t.filesChanged !== undefined) parts.push(`${t.filesChanged} 个文件`);
  if (t.additions !== undefined) parts.push(`+${t.additions} 行`);
  if (t.deletions !== undefined) parts.push(`-${t.deletions} 行`);
  return parts.join('，');
}

/** 数据层 generatedAt 保持 ISO（文件名反解依赖它）；仅渲染层转本地可读时间。 */
function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** MD 侧最小转义：换行会破坏行结构（行首 # 会被当成标题），压成空格并转义行首 #。 */
function mdText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/^#+/, (m) => m.replace(/#/g, '\\#'));
}

/**
 * 清单截断提示：概览状态计数遍历截断前的全量任务（见 kanban/summary.ts），
 * 而清单只展开最近若干条；全量总数比清单条数多时补一句说明。
 */
function truncationNote(data: WorkSummaryData): string | null {
  const { totals } = data;
  const full = totals.done + totals.inreview + totals.inprogress + totals.todo + totals.cancelled;
  return full > data.tasks.length ? `仅展示最近 ${data.tasks.length} 条，共 ${full} 条` : null;
}

/**
 * 概览统计口径标注：状态计数覆盖全量任务，而改动文件/增删行只统计了清单样本
 * （见 kanban/summary.ts 截断逻辑）；截断发生时口径不一，必须在概览注明。
 */
function sampleStatsNote(data: WorkSummaryData): string | null {
  return truncationNote(data) ? `改动文件与增删行仅统计最近 ${data.tasks.length} 条` : null;
}

export function renderMarkdown(data: WorkSummaryData): string {
  const { totals } = data;
  const lines: string[] = [
    `# 工作总结 · ${data.sinceLabel}`,
    '',
    `> 生成时间：${formatGeneratedAt(data.generatedAt)}`,
    '',
    '## 概览',
    '',
    '| 完成 | 待审阅 | 进行中 | 待办 | 已取消 | 改动文件 | 新增行 | 删除行 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    `| ${totals.done} | ${totals.inreview} | ${totals.inprogress} | ${totals.todo} | ${totals.cancelled} | ${totals.filesChanged} | +${totals.additions} | -${totals.deletions} |`,
  ];
  const sampleNote = sampleStatsNote(data);
  if (sampleNote) lines.push('', `> ${sampleNote}`);
  lines.push('');
  for (const group of groupByStatus(data.tasks)) {
    lines.push(`## ${group.meta.emoji} ${group.meta.label}（${group.tasks.length}）`, '');
    for (const t of group.tasks) {
      lines.push(`### ${mdText(t.title) || '（无标题）'}`);
      lines.push(`- 项目：${t.projectName}${t.iteration ? `（迭代 ${t.iteration}）` : ''}`);
      if (t.attemptSummary) lines.push(`- 摘要：${mdText(t.attemptSummary)}`);
      const stats = diffStatsLine(t);
      if (stats) lines.push(`- 改动：${stats}`);
      if (t.changedFiles?.length) {
        const files = t.changedFiles.slice(0, 10).map((f) => `\`${f}\``).join('、');
        const more = t.changedFiles.length > 10 ? ` 等 +${t.changedFiles.length - 10} 个` : '';
        lines.push(`- 变更文件：${files}${more}`);
      }
      lines.push(`- [查看 diff](<${t.diffUrl}>)`, '');
    }
  }
  if (!data.tasks.length) lines.push('（该范围内没有匹配的任务）', '');
  const note = truncationNote(data);
  if (note) lines.push(`> ${note}`, '');
  return lines.join('\n');
}

function htmlStatCard(num: string, label: string, cls = ''): string {
  return `<div class="stat${cls ? ` ${cls}` : ''}"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
}

function htmlTaskCard(t: WorkSummaryTask): string {
  const meta = statusMeta(t.status);
  const parts: string[] = ['<div class="card">'];
  parts.push(
    `<div class="card-head"><h3>${escapeHtml(t.title || '（无标题）')}</h3>` +
      `<span class="badge ${meta.badge}">${meta.emoji} ${escapeHtml(meta.label)}</span></div>`,
  );
  const metaLine = [t.projectName, t.iteration ? `迭代 ${t.iteration}` : ''].filter(Boolean).join(' · ');
  if (metaLine) parts.push(`<p class="meta-line">${escapeHtml(metaLine)}</p>`);
  if (t.attemptSummary) {
    parts.push(`<p class="summary">${escapeHtml(t.attemptSummary).replace(/\n/g, '<br>')}</p>`);
  }
  const stats: string[] = [];
  if (t.filesChanged !== undefined) stats.push(`改动 ${t.filesChanged} 个文件`);
  if (t.additions !== undefined) stats.push(`<span class="plus">+${t.additions} 行</span>`);
  if (t.deletions !== undefined) stats.push(`<span class="minus">-${t.deletions} 行</span>`);
  if (stats.length) parts.push(`<p class="changes">${stats.join(' · ')}</p>`);
  if (t.changedFiles?.length) {
    const chips = t.changedFiles
      .slice(0, 10)
      .map((f) => `<code>${escapeHtml(f)}</code>`)
      .join('');
    const more = t.changedFiles.length > 10 ? `<code>+${t.changedFiles.length - 10} 个</code>` : '';
    parts.push(`<div class="chips">${chips}${more}</div>`);
  }
  if (t.diffUrl) {
    parts.push(`<a class="diff-link" href="${escapeHtml(t.diffUrl)}" target="_blank" rel="noopener">查看 diff →</a>`);
  }
  parts.push('</div>');
  return parts.join('\n');
}

/** work-summary 页面专属区块样式（公共基底与页框见 report-page.ts）。 */
const SUMMARY_PAGE_CSS = `
  body { background: #f3f4f8; line-height: 1.6; }
  .page { max-width: 880px; }
  .hero {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    padding: 36px 40px;
  }
  .hero h1 { font-size: 28px; }
  .hero .subtitle { font-size: 17px; }
  .hero .gen { margin-top: 10px; }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 12px;
    margin: 20px 0 8px;
  }
  .stat {
    background: #fff;
    border-radius: 12px;
    padding: 16px;
    text-align: center;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }
  .stat-num { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .stat.add .stat-num { color: #16a34a; }
  .stat.del .stat-num { color: #dc2626; }
  .group { margin-top: 28px; }
  .group h2 { font-size: 18px; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
  .count {
    font-size: 12px;
    font-weight: 600;
    background: #e5e7eb;
    color: #4b5563;
    border-radius: 999px;
    padding: 1px 9px;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 18px 20px;
    margin-bottom: 12px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }
  .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  .card-head h3 { font-size: 16px; flex: 1; }
  .badge { flex-shrink: 0; }
  .badge.done { background: #dcfce7; color: #15803d; }
  .badge.inreview { background: #fef3c7; color: #b45309; }
  .badge.inprogress { background: #dbeafe; color: #1d4ed8; }
  .badge.todo { background: #e5e7eb; color: #4b5563; }
  .badge.cancelled { background: #fee2e2; color: #b91c1c; }
  .meta-line { font-size: 12px; color: #9ca3af; margin-top: 2px; }
  .summary { font-size: 14px; color: #4b5563; margin-top: 8px; white-space: normal; }
  .changes { font-size: 13px; margin-top: 8px; color: #6b7280; }
  .plus { color: #16a34a; font-weight: 600; }
  .minus { color: #dc2626; font-weight: 600; }
  .chips { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
  .chips code { font-size: 12px; border-radius: 6px; padding: 2px 8px; }
  .diff-link {
    display: inline-block;
    margin-top: 12px;
    font-size: 13px;
    font-weight: 600;
    color: #6366f1;
    text-decoration: none;
    border: 1px solid #c7d2fe;
    border-radius: 8px;
    padding: 4px 14px;
    transition: background 0.15s;
  }
  .diff-link:hover { background: #eef2ff; }
  .empty { text-align: center; color: #9ca3af; margin-top: 40px; }
  .trunc-note { text-align: center; font-size: 13px; color: #6b7280; margin-top: 20px; }
`;

export function renderHtml(data: WorkSummaryData): string {
  const { totals } = data;
  const sections: string[] = [];
  for (const group of groupByStatus(data.tasks)) {
    sections.push(
      `<section class="group">\n<h2>${group.meta.emoji} ${escapeHtml(group.meta.label)}<span class="count">${group.tasks.length}</span></h2>\n` +
        group.tasks.map(htmlTaskCard).join('\n') +
        '\n</section>',
    );
  }
  const body = sections.length
    ? sections.join('\n')
    : '<p class="empty">该范围内没有匹配的任务。</p>';
  const note = truncationNote(data);
  const sampleNote = sampleStatsNote(data);
  return renderReportPage({
    title: `工作总结 · ${escapeHtml(data.sinceLabel)}`,
    css: SUMMARY_PAGE_CSS,
    body: `  <header class="hero">
    <h1>工作总结</h1>
    <p class="subtitle">${escapeHtml(data.sinceLabel)}</p>
    <p class="gen">生成时间：${escapeHtml(formatGeneratedAt(data.generatedAt))}</p>
  </header>
  <section class="stats">
    ${htmlStatCard(String(totals.done), '完成')}
    ${htmlStatCard(String(totals.inreview), '待审阅')}
    ${htmlStatCard(String(totals.inprogress), '进行中')}
    ${htmlStatCard(String(totals.todo), '待办')}
    ${htmlStatCard(String(totals.cancelled), '已取消')}
    ${htmlStatCard(String(totals.filesChanged), '改动文件')}
    ${htmlStatCard(`+${totals.additions}`, '新增行', 'add')}
    ${htmlStatCard(`-${totals.deletions}`, '删除行', 'del')}
  </section>${sampleNote ? `\n  <p class="trunc-note">${escapeHtml(sampleNote)}</p>` : ''}
  ${body}${note ? `\n  <p class="trunc-note">${escapeHtml(note)}</p>` : ''}`,
  });
}

export interface WriteSummaryReportsOptions {
  dir?: string;
  format?: 'both' | 'html' | 'md';
}

export interface SummaryReportPaths {
  htmlPath?: string;
  mdPath?: string;
}

/** 工作总结报告输出目录（数据目录 reports/；report-server 会把它纳入静态服务）。 */
export function reportsDir(): string {
  return path.join(defaultDataHome(), 'reports');
}

export function writeSummaryReports(
  data: WorkSummaryData,
  opts: WriteSummaryReportsOptions = {},
): SummaryReportPaths {
  const format = opts.format ?? 'both';
  const dir = opts.dir ?? reportsDir();
  ensurePrivateDirSync(dir);
  // 与 AI 审查报告同一清理策略：30 天前的历史报告自动删除，避免目录无界增长
  pruneOldReports(dir);
  const stamp = data.iteration?.trim()
    ? data.iteration.trim()
    : (() => {
        const d = new Date(data.generatedAt);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      })();
  const base = path.join(dir, `work-summary-${sanitizeName(stamp, 'report')}`);
  const out: SummaryReportPaths = {};
  if (format === 'both' || format === 'html') {
    // HTML 走 report-server HTTP 访问：文件名带随机 token 作为访问凭证（含任务 diff 数据，0600 写入）
    out.htmlPath = `${base}.${newReportToken()}.html`;
    writeFilePrivateSync(out.htmlPath, renderHtml(data));
  }
  if (format === 'both' || format === 'md') {
    out.mdPath = `${base}.md`;
    writeFilePrivateSync(out.mdPath, renderMarkdown(data));
  }
  return out;
}

/** 工具结果用的紧凑文本：文件路径（或 HTTP 链接）+ 总量概览 + 最多 5 条任务标题。 */
export function summarizeForChat(
  data: WorkSummaryData,
  paths: SummaryReportPaths,
  opts: { linkBaseUrl?: string } = {},
): string {
  const { totals } = data;
  const lines: string[] = [`📊 工作总结报告已生成（${data.sinceLabel}）`];
  if (paths.htmlPath) {
    // bot 场景给 HTTP 链接（本机路径手机飞书打不开）；CLI 保留本机路径
    if (opts.linkBaseUrl) {
      const url = `${opts.linkBaseUrl}/${path.basename(paths.htmlPath)}`;
      lines.push(`- HTML：${url}`);
      // 可达性与飞书卡片同一口径：仅 loopback 才是「仅本机可达」，否则按所在网络可达表述
      lines.push(
        isLoopbackUrl(url)
          ? '（链接仅本机可达，手机/局域网打不开；报告保留 30 天，机器人重启后链接失效）'
          : '（链接仅本机所在网络可达；报告保留 30 天，机器人重启后链接失效）',
      );
    } else {
      lines.push(`- HTML：${paths.htmlPath}`);
    }
  }
  // bot 场景用户够不到部署机文件系统，md 本机路径不推给飞书用户；CLI 场景保留
  if (paths.mdPath && !opts.linkBaseUrl) lines.push(`- Markdown：${paths.mdPath}`);
  const sampleNote = sampleStatsNote(data);
  lines.push(
    '',
    `概览：完成 ${totals.done} · 待审阅 ${totals.inreview} · 进行中 ${totals.inprogress} · 待办 ${totals.todo} · 已取消 ${totals.cancelled}` +
      ` · 改动文件 ${totals.filesChanged} · +${totals.additions} 行 / -${totals.deletions} 行` +
      (sampleNote ? `（${sampleNote}）` : ''),
  );
  for (const t of data.tasks.slice(0, 5)) {
    lines.push(`· ${statusMeta(t.status).emoji} ${t.title || '（无标题）'}`);
  }
  if (data.tasks.length > 5) lines.push(`· … 其余 ${data.tasks.length - 5} 条见报告文件`);
  const note = truncationNote(data);
  if (note) lines.push(`（${note}）`);
  return lines.join('\n');
}
