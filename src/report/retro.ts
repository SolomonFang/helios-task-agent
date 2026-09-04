/**
 * 迭代复盘报告：基于 work-summary 采集（collectWorkSummary）的派生模型、
 * 失败摘要的规则化归类（确定性关键词匹配，不调 LLM）、自包含 HTML 渲染与写盘、
 * 给 LLM 解读的文本摘要。口径存疑处一律在报告「口径说明」里注明，宁缺毋假。
 */

import path from 'path';
import { isLoopbackUrl } from '../infra/url-utils';
import { writeFilePrivateSync, ensurePrivateDirSync } from '../infra/private-file';
import { escapeHtml, renderReportPage } from './report-page';
import { newReportToken } from './report-server';
import { pruneOldReports, sanitizeName } from './report-utils';
import { reportsDir } from './report';
import { isKnownStatus, statusLabel } from '../kanban/status';
import type { WorkSummaryData, WorkSummaryTask } from '../kanban/summary';

// ---------------------------------------------------------------------------
// 失败归因：规则化归类（参考 kanban/failure-diagnosis.ts 的类目，但用确定性关键词，
// 不调 LLM）。规则按序首个命中生效；全部未命中（含无失败摘要）归「其他」。
// ---------------------------------------------------------------------------

export interface FailureRule {
  label: string;
  pattern: RegExp;
}

/** 规则顺序即优先级：冲突信息里常顺带提到测试/构建，先判冲突；超时不误判依赖报错。 */
export const FAILURE_RULES: FailureRule[] = [
  { label: '合并冲突', pattern: /merge\s+conflict|conflict(?:s)?\b|rebase|冲突/i },
  { label: '测试失败', pattern: /tests?\s+(failed|failure)|failing\s+tests?|测试(失败|未通过|不通过)|断言失败|assertion|jest|vitest|mocha|pytest/i },
  { label: '构建错误', pattern: /build\s+failed|构建失败|编译(失败|错误)|compile|tsc\b|type\s*error|syntax\s*error|webpack|vite\b/i },
  { label: '执行超时', pattern: /timed?\s*out|timeout|超时|deadline\s+exceeded/i },
  { label: '环境或依赖', pattern: /econnrefused|enotfound|network\s+error|npm\s+err|install\s+failed|依赖|permission\s+denied|eacces|enoent|cannot\s+find\s+module|module\s+not\s+found|环境/i },
];

export const FAILURE_CATEGORY_OTHER = '其他';

/** 单条失败摘要归类：首个命中的规则生效；空摘要/未命中归「其他」。 */
export function classifyFailure(attemptSummary: string | undefined): string {
  const text = (attemptSummary || '').trim();
  if (text) {
    for (const rule of FAILURE_RULES) {
      if (rule.pattern.test(text)) return rule.label;
    }
  }
  return FAILURE_CATEGORY_OTHER;
}

// ---------------------------------------------------------------------------
// 复盘模型
// ---------------------------------------------------------------------------

export interface RetroFailureGroup {
  category: string;
  tasks: WorkSummaryTask[];
}

export interface RetroModel {
  /** e.g. 迭代 260717 / 全部任务 */
  sinceLabel: string;
  generatedAt: string;
  /** 任务总数（五状态全量和，截断前口径）。 */
  total: number;
  counts: { done: number; inreview: number; inprogress: number; todo: number; cancelled: number };
  /** 完成率 = 已完成 ÷ 任务总数（含已取消）；total=0 时为 null（不显示 0% 冒充）。 */
  completionRate: number | null;
  /** 本周完成数（done 且 updated_at ≥ 本周一 00:00，enrich 样本口径，与周报「本周完成」一致）。 */
  doneThisWeek: number;
  /** 本周范围标签（YYYY-MM-DD 至 YYYY-MM-DD），口径标注用。 */
  weekRange: string;
  /** 累计完成数（全量口径）。 */
  doneTotal: number;
  /** 失败任务数（全量口径，与状态计数正交）。 */
  failedTotal: number;
  /** 失败归类（enrich 样本口径）；样本内失败任务数为各组任务数之和。 */
  failureGroups: RetroFailureGroup[];
  diff: { filesChanged: number; additions: number; deletions: number };
  /** 清单样本被截断（概览计数为全量，失败归类/本周完成/diff 为样本口径）。 */
  truncated: boolean;
  /** enrich 样本条数。 */
  sampleSize: number;
}

/** 本地星期几，1=周一…7=周日（与 weekly-brief 同口径；Date.getDay 是 0=周日）。 */
function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** 本周周一 00:00（本地时间）：「本周完成」统计起点（口径与 weekly-brief 完全一致）。 */
function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - (isoWeekday(d) - 1));
  return d;
}

function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 由 work-summary 采集结果派生复盘模型（纯函数便于单测；now 可注入钉住「本周」边界）。 */
export function buildRetroModel(data: WorkSummaryData, now = new Date()): RetroModel {
  const { totals } = data;
  const total = totals.done + totals.inreview + totals.inprogress + totals.todo + totals.cancelled;

  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const doneThisWeek = data.tasks.filter((t) => {
    if (t.status !== 'done') return false;
    const ts = Date.parse(t.updatedAt);
    return Number.isFinite(ts) && ts >= weekStart.getTime();
  }).length;

  // 失败归类只认 attempt 摘要（标题不是失败证据）；无摘要任务归「其他」
  const groups = new Map<string, WorkSummaryTask[]>();
  for (const t of data.tasks.filter((x) => x.failed)) {
    const category = classifyFailure(t.attemptSummary);
    const list = groups.get(category) ?? [];
    list.push(t);
    groups.set(category, list);
  }
  const order = [...FAILURE_RULES.map((r) => r.label), FAILURE_CATEGORY_OTHER];
  const failureGroups = order.filter((c) => groups.has(c)).map((c) => ({ category: c, tasks: groups.get(c)! }));

  return {
    sinceLabel: data.sinceLabel,
    generatedAt: data.generatedAt,
    total,
    counts: {
      done: totals.done,
      inreview: totals.inreview,
      inprogress: totals.inprogress,
      todo: totals.todo,
      cancelled: totals.cancelled,
    },
    completionRate: total > 0 ? totals.done / total : null,
    doneThisWeek,
    weekRange: `${localDateStr(weekStart)} 至 ${localDateStr(weekEnd)}`,
    doneTotal: totals.done,
    failedTotal: totals.failed,
    failureGroups,
    diff: {
      filesChanged: totals.filesChanged,
      additions: totals.additions,
      deletions: totals.deletions,
    },
    truncated: total > data.tasks.length,
    sampleSize: data.tasks.length,
  };
}

// ---------------------------------------------------------------------------
// HTML 渲染与写盘
// ---------------------------------------------------------------------------

function formatGeneratedAt(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function htmlStatCard(num: string, label: string, cls = ''): string {
  return `<div class="stat${cls ? ` ${cls}` : ''}"><div class="stat-num">${num}</div><div class="stat-label">${label}</div></div>`;
}

const RETRO_PAGE_CSS = `
  body { background: #f3f4f8; line-height: 1.6; }
  .page { max-width: 880px; }
  .hero {
    background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
    padding: 36px 40px;
  }
  .hero h1 { font-size: 28px; }
  .hero .subtitle { font-size: 17px; }
  .hero .gen { margin-top: 10px; }
  .section-title { font-size: 18px; margin: 28px 0 12px; }
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
  .stat.warn .stat-num { color: #b45309; }
  .dist {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 12px;
    margin: 12px 0 8px;
  }
  .group { margin-top: 20px; }
  .group h3 { font-size: 16px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
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
    padding: 14px 18px;
    margin-bottom: 10px;
    box-shadow: 0 2px 8px rgba(15, 23, 42, 0.06);
  }
  .card h4 { font-size: 15px; }
  .badge { background: #fee2e2; color: #b91c1c; flex-shrink: 0; }
  .meta-line { font-size: 12px; color: #9ca3af; margin-top: 2px; }
  .summary { font-size: 13px; color: #4b5563; margin-top: 6px; }
  .diff-link {
    display: inline-block;
    margin-top: 8px;
    font-size: 13px;
    font-weight: 600;
    color: #6366f1;
    text-decoration: none;
    border: 1px solid #c7d2fe;
    border-radius: 8px;
    padding: 3px 12px;
  }
  .diff-link:hover { background: #eef2ff; }
  .empty { text-align: center; color: #9ca3af; margin-top: 40px; }
  .notes { margin-top: 32px; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 12px; }
  .notes li { margin-left: 18px; }
`;

/** 每类失败最多展开的代表任务数（概览性质，全量见看板）。 */
const MAX_FAILURE_REPS = 5;

function htmlFailureTask(t: WorkSummaryTask): string {
  const status = isKnownStatus(t.status) ? statusLabel(t.status) : '其他';
  const parts: string[] = ['<div class="card">'];
  parts.push(`<h4>${escapeHtml(t.title || '（无标题）')} <span class="badge">${escapeHtml(status)}</span></h4>`);
  const metaLine = [t.projectName, t.iteration ? `迭代 ${t.iteration}` : ''].filter(Boolean).join(' · ');
  if (metaLine) parts.push(`<p class="meta-line">${escapeHtml(metaLine)}</p>`);
  parts.push(`<p class="summary">${escapeHtml(t.attemptSummary || '（看板未提供失败摘要）')}</p>`);
  if (t.diffUrl) {
    parts.push(`<a class="diff-link" href="${escapeHtml(t.diffUrl)}" target="_blank" rel="noopener">查看改动 →</a>`);
  }
  parts.push('</div>');
  return parts.join('\n');
}

export function renderRetroHtml(model: RetroModel): string {
  const { counts } = model;
  const rate = model.completionRate === null ? '—' : `${Math.round(model.completionRate * 100)}%`;
  const failureSections = model.failureGroups
    .map((g) => {
      const reps = g.tasks.slice(0, MAX_FAILURE_REPS).map(htmlFailureTask).join('\n');
      const more =
        g.tasks.length > MAX_FAILURE_REPS ? `<p class="meta-line">仅列 ${MAX_FAILURE_REPS} 个代表任务，共 ${g.tasks.length} 个。</p>` : '';
      return `<div class="group">\n<h3>${escapeHtml(g.category)}<span class="count">${g.tasks.length}</span></h3>\n${reps}\n${more}\n</div>`;
    })
    .join('\n');
  const classified = model.failureGroups.reduce((n, g) => n + g.tasks.length, 0);
  const failureBody = model.failedTotal
    ? failureSections || '<p class="empty">（清单样本未覆盖失败任务，见上方计数）</p>'
    : '<p class="empty">本范围内没有执行失败的任务。</p>';
  const notes = [
    '完成率 = 已完成 ÷ 任务总数（含已取消）。',
    `「本周完成」口径：状态已完成且最后更新时间在本周（${model.weekRange}，本地时区），与周报同一口径；看板无「完成时间」字段，按最后更新时间近似。`,
    '失败归因是对失败摘要的关键词规则归类（确定性规则，未经模型判读）；无失败摘要的任务归入「其他」。',
    model.truncated
      ? `范围内任务共 ${model.total} 个，清单样本为最近 ${model.sampleSize} 条：失败归类、本周完成与改动统计按样本口径，概览计数为全量口径。`
      : '失败归因与改动统计覆盖范围内全部任务。',
    '失败标记与任务状态正交：失败任务可能停在任意状态，与五状态分布不互斥。',
  ];
  return renderReportPage({
    title: `迭代复盘 · ${escapeHtml(model.sinceLabel)}`,
    css: RETRO_PAGE_CSS,
    body: `  <header class="hero">
    <h1>迭代复盘</h1>
    <p class="subtitle">${escapeHtml(model.sinceLabel)}</p>
    <p class="gen">生成时间：${escapeHtml(formatGeneratedAt(model.generatedAt))}</p>
  </header>
  <h2 class="section-title">迭代概览</h2>
  <section class="stats">
    ${htmlStatCard(String(model.total), '任务总数')}
    ${htmlStatCard(rate, '完成率')}
    ${htmlStatCard(String(model.doneThisWeek), '本周完成')}
    ${htmlStatCard(String(model.doneTotal), '累计完成')}
    ${htmlStatCard(String(model.failedTotal), '失败', model.failedTotal ? 'warn' : '')}
  </section>
  <section class="dist">
    ${htmlStatCard(String(counts.done), '已完成')}
    ${htmlStatCard(String(counts.inreview), '待审阅')}
    ${htmlStatCard(String(counts.inprogress), '进行中')}
    ${htmlStatCard(String(counts.todo), '待办')}
    ${htmlStatCard(String(counts.cancelled), '已取消')}
  </section>
  <h2 class="section-title">改动统计</h2>
  <section class="stats">
    ${htmlStatCard(String(model.diff.filesChanged), '改动文件')}
    ${htmlStatCard(`+${model.diff.additions}`, '新增行', 'add')}
    ${htmlStatCard(`-${model.diff.deletions}`, '删除行', 'del')}
  </section>
  <h2 class="section-title">失败归因（${model.failedTotal} 个失败任务${model.failedTotal > classified ? `，样本内归类 ${classified} 个` : ''}）</h2>
  ${failureBody}
  <ul class="notes">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`,
  });
}

/** 写复盘 HTML（reports/，文件名带 128-bit token 作为访问凭证，与 work-summary 同一托管与清理策略）。 */
export function writeRetroReport(model: RetroModel, opts: { dir?: string } = {}): string {
  const dir = opts.dir ?? reportsDir();
  ensurePrivateDirSync(dir);
  pruneOldReports(dir);
  const stamp = model.sinceLabel.replace(/^迭代\s*/, '');
  const file = path.join(dir, `iteration-retro-${sanitizeName(stamp, 'report')}.${newReportToken()}.html`);
  writeFilePrivateSync(file, renderRetroHtml(model));
  return file;
}

/** 给 LLM 解读的文本摘要：概览指标 + 失败归类计数 + 报告链接（明细在 HTML 里，不整份贴进对话）。 */
export function buildRetroSummary(
  model: RetroModel,
  opts: { htmlPath?: string; linkBaseUrl?: string } = {},
): string {
  const { counts } = model;
  const rate = model.completionRate === null ? '—' : `${Math.round(model.completionRate * 100)}%`;
  const lines: string[] = [`📊 迭代复盘报告已生成（${model.sinceLabel}）`];
  if (opts.htmlPath) {
    if (opts.linkBaseUrl) {
      const url = `${opts.linkBaseUrl}/${path.basename(opts.htmlPath)}`;
      lines.push(`- HTML：${url}`);
      lines.push(
        isLoopbackUrl(url)
          ? '（链接仅本机可达，手机/局域网打不开；报告保留 30 天，机器人重启后链接失效）'
          : '（链接仅本机所在网络可达；报告保留 30 天，机器人重启后链接失效）',
      );
    } else {
      lines.push(`- HTML：${opts.htmlPath}`);
    }
  }
  lines.push(
    '',
    `概览：任务总数 ${model.total} · 完成率 ${rate} · 五状态分布 已完成 ${counts.done} / 待审阅 ${counts.inreview} / 进行中 ${counts.inprogress} / 待办 ${counts.todo} / 已取消 ${counts.cancelled}`,
    `吞吐：本周完成 ${model.doneThisWeek}（${model.weekRange}，按最后更新时间口径） · 累计完成 ${model.doneTotal}`,
    `改动统计：改动文件 ${model.diff.filesChanged} · +${model.diff.additions} 行 / -${model.diff.deletions} 行`,
  );
  if (model.failedTotal) {
    const classified = model.failureGroups.reduce((n, g) => n + g.tasks.length, 0);
    lines.push(
      `失败归因（规则归类，非模型判读）：共 ${model.failedTotal} 个失败任务` +
        (model.failedTotal > classified ? `，样本内 ${classified} 个归类如下` : ''),
    );
    for (const g of model.failureGroups) {
      const reps = g.tasks
        .slice(0, 3)
        .map((t) => `《${t.title || '（无标题）'}》`)
        .join('、');
      lines.push(`· ${g.category} ${g.tasks.length} 个：${reps}${g.tasks.length > 3 ? ' 等' : ''}`);
    }
  } else {
    lines.push('失败归因：本范围内没有执行失败的任务。');
  }
  if (!model.total) {
    lines.push('', '该范围内没有任务，以上指标均为空口径，解读时请如实说明，不要编造。');
  }
  if (model.truncated) {
    lines.push(`（失败归类、本周完成与改动统计按最近 ${model.sampleSize} 条样本口径，概览计数为全量口径）`);
  }
  return lines.join('\n');
}
