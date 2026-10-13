/**
 * 迭代复盘报告：基于 work-summary 采集（collectWorkSummary）的派生模型、
 * 失败摘要的规则化归类（确定性关键词匹配，不调 LLM）、自包含 HTML 渲染与写盘、
 * 给 LLM 解读的文本摘要。口径存疑处一律在报告「口径说明」里注明，宁缺毋假。
 */

import path from 'path';
import { isLoopbackUrl } from '../infra/url-utils';
import { writeFilePrivate, ensurePrivateDirSync } from '../infra/private-file';
import { escapeHtml, renderReportPage } from './report-page';
import { formatGeneratedAt, htmlStatCard, REPORT_CARDS_CSS } from './report-cards';
import { newReportToken, pruneOldReports, safeHttpUrl, sanitizeName } from './report-utils';
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
  /** 本周完成数（done 且 updated_at ≥ 本周一 00:00，与周报同一口径：采集侧截断前全量优先，缺该字段回退样本计数）。 */
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
  /** 清单样本被截断（概览计数与「本周完成」为全量，失败归类/diff 为样本口径）。 */
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
  // 「本周完成」范围终点不越过生成当天：周中生成时展示「至 周日」是在预报未来（与周报同口径）
  const rangeEnd = weekEnd.getTime() > now.getTime() ? now : weekEnd;
  // 与周报同款口径（weekly-brief 的 buildWeeklyBriefText）：采集侧截断前全量优先，
  // 旧采集缺 totals.doneThisWeek 字段时回退样本计数（只少报不谎报）
  const sampleDoneThisWeek = data.tasks.filter((t) => {
    if (t.status !== 'done') return false;
    const ts = Date.parse(t.updatedAt);
    return Number.isFinite(ts) && ts >= weekStart.getTime();
  }).length;
  const doneThisWeek = totals.doneThisWeek ?? sampleDoneThisWeek;

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
    weekRange: `${localDateStr(weekStart)} 至 ${localDateStr(rangeEnd)}`,
    doneTotal: totals.done,
    failedTotal: totals.failed,
    failureGroups,
    diff: {
      filesChanged: totals.filesChanged,
      additions: totals.additions,
      deletions: totals.deletions,
    },
    // 截断判定用采集侧透传的截断前行数：totals 只计五个已知状态键，范围内有未知状态任务时
    // total ≤ tasks.length 会漏报截断；旧采集结果缺 scopedTotal 时回退五状态全量和
    truncated: (data.scopedTotal ?? total) > data.tasks.length,
    sampleSize: data.tasks.length,
  };
}

// ---------------------------------------------------------------------------
// HTML 渲染与写盘
// ---------------------------------------------------------------------------

/** 复盘页面差异样式（公共区块见 report-cards.ts 的 REPORT_CARDS_CSS，此处覆盖/补充）。 */
const RETRO_PAGE_CSS = `
  .hero {
    background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%);
  }
  .section-title { font-size: 18px; margin: 28px 0 12px; }
  .stat.warn .stat-num { color: #b45309; }
  .dist {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 12px;
    margin: 12px 0 8px;
  }
  .group { margin-top: 20px; }
  .group h3 { font-size: 16px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .card { padding: 14px 18px; margin-bottom: 10px; }
  .card h4 { font-size: 15px; }
  .badge { background: #fee2e2; color: #b91c1c; flex-shrink: 0; }
  .summary { font-size: 13px; margin-top: 6px; }
  .diff-link { margin-top: 8px; padding: 3px 12px; }
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
  const diffUrl = safeHttpUrl(t.diffUrl);
  if (diffUrl) {
    parts.push(`<a class="diff-link" href="${escapeHtml(diffUrl)}" target="_blank" rel="noopener">查看改动 →</a>`);
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
    `「本周完成」口径：状态已完成且最后更新时间在本周（${model.weekRange}，按部署机器时区），按截断前全量统计，与周报同一口径；看板无「完成时间」字段，按最后更新时间近似。`,
    '失败归因是对失败摘要的关键词规则归类（确定性规则，未经模型判读）；无失败摘要的任务归入「其他」。',
    model.truncated
      ? `范围内任务共 ${model.total} 个，清单样本为最近 ${model.sampleSize} 条：失败归类与改动统计按样本口径，概览计数与「本周完成」为全量口径。`
      : '失败归因与改动统计覆盖范围内全部任务。',
    '失败标记与任务状态正交：失败任务可能停在任意状态，与五状态分布不互斥。',
  ];
  return renderReportPage({
    title: `迭代复盘 · ${escapeHtml(model.sinceLabel)}`,
    css: REPORT_CARDS_CSS + RETRO_PAGE_CSS,
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

/** 写复盘 HTML（reports/，文件名带 128-bit token 作为访问凭证，与 work-summary 同一托管与清理策略；异步写盘不阻塞 bot 事件循环）。 */
export async function writeRetroReport(model: RetroModel, opts: { dir?: string } = {}): Promise<string> {
  const dir = opts.dir ?? reportsDir();
  ensurePrivateDirSync(dir);
  pruneOldReports(dir);
  const stamp = model.sinceLabel.replace(/^迭代\s*/, '');
  const file = path.join(dir, `iteration-retro-${sanitizeName(stamp, 'report')}.${newReportToken()}.html`);
  await writeFilePrivate(file, renderRetroHtml(model));
  return file;
}

/** 给 LLM 解读的文本摘要：概览指标 + 失败归类计数 + 报告链接（明细在 HTML 里，不整份贴进对话）。 */
export function buildRetroSummary(
  model: RetroModel,
  opts: { htmlPath?: string; linkBaseUrl?: string; channel?: 'cli' | 'bot' } = {},
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
    } else if (opts.channel !== 'bot') {
      lines.push(`- HTML：${opts.htmlPath}`);
    }
    // bot 场景报告服务不可用时无链接可给：本机路径对飞书用户是死链且泄露部署机目录，省略只给文本摘要
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
    lines.push(`（失败归类与改动统计按最近 ${model.sampleSize} 条样本口径，概览计数与本周完成为全量口径）`);
  }
  return lines.join('\n');
}
