/**
 * 个人工作日报：日期解析、素材分组、自包含 HTML 渲染与写盘、给 LLM 的结构化素材文本。
 * 数据采集见 kanban/summary.ts 的 collectDailyData；口径标注原则与 work-summary 一致——
 * 看板没有的维度（如「完成时间」字段）一律注明近似口径或如实留空，不编造。
 */

import path from 'path';
import { isLoopbackUrl } from '../infra/url-utils';
import { writeFilePrivate, ensurePrivateDirSync } from '../infra/private-file';
import { escapeHtml, renderReportPage } from './report-page';
import { formatGeneratedAt, htmlStatCard, REPORT_CARDS_CSS } from './report-cards';
import { newReportToken, pruneOldReports, safeHttpUrl, sanitizeName } from './report-utils';
import { reportsDir } from './report';
import { isKnownStatus, statusLabel } from '../kanban/status';
import {
  isWithinDate,
  localDate,
  taskCollectionIncompleteNote,
  type DailyReportData,
  type WorkSummaryTask,
} from '../kanban/summary';

/**
 * 解析日报目标日期：缺省 / 「今天」/「昨天」/ YYYY-MM-DD；无法识别或未来日期返回 null
 * （工具层转成中文提示；未来日期没有看板活动可统计，生成「未来日报」只会误导）。
 * now 可注入便于单测。
 */
export function resolveReportDate(raw: unknown, now = new Date()): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v || v === '今天' || v.toLowerCase() === 'today') return localDate(now);
  if (v === '昨天' || v.toLowerCase() === 'yesterday') {
    return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 真实日期校验（2026-02-31 之类非法值拒绝，不静默滚动到下月）
  const probe = new Date(y!, mo! - 1, d!);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo! - 1 || probe.getDate() !== d) return null;
  // 未来日期拒绝（YYYY-MM-DD 定长格式按字典序比较即时间序，与 localDate 同为本地时区口径）
  if (v > localDate(now)) return null;
  return v;
}

/** 输入是「格式合法但尚未到来」的日期（区别于格式错误，供调用方给出针对性提示）。 */
export function isFutureReportDate(raw: unknown, now = new Date()): boolean {
  const v = typeof raw === 'string' ? raw.trim() : '';
  // 以远端未来为基准做合法性校验（绕过未来拒绝），再与今天比较
  return resolveReportDate(v, new Date(9999, 11, 31)) !== null && v > localDate(now);
}

export interface DailyPartition {
  /** 状态已完成且最后更新时间在当日。 */
  doneToday: WorkSummaryTask[];
  /** 当前进行中（不限更新日期）。 */
  inProgress: WorkSummaryTask[];
  /** 最近一次执行失败且最后更新时间在当日（与状态分组正交，同一任务可同时出现在其它组）。 */
  failedToday: WorkSummaryTask[];
  /** 状态待审阅且最后更新时间在当日。 */
  inReviewToday: WorkSummaryTask[];
}

/** 把 enrich 样本切成日报四个分组（计数全量口径见 data.counts；清单为样本）。 */
export function partitionDaily(data: DailyReportData): DailyPartition {
  const inDate = (t: WorkSummaryTask) => isWithinDate(t.updatedAt, data.date);
  return {
    doneToday: data.tasks.filter((t) => t.status === 'done' && inDate(t)),
    inProgress: data.tasks.filter((t) => t.status === 'inprogress'),
    failedToday: data.tasks.filter((t) => t.failed && inDate(t)),
    inReviewToday: data.tasks.filter((t) => t.status === 'inreview' && inDate(t)),
  };
}

function taskDiffLine(t: WorkSummaryTask): string {
  const parts: string[] = [];
  if (t.filesChanged !== undefined) parts.push(`改动 ${t.filesChanged} 个文件`);
  if (t.additions !== undefined) parts.push(`+${t.additions} 行`);
  if (t.deletions !== undefined) parts.push(`-${t.deletions} 行`);
  return parts.join(' ');
}

function htmlTaskItem(t: WorkSummaryTask, opts?: { showStatus?: boolean }): string {
  const parts: string[] = ['<div class="card">'];
  const status = isKnownStatus(t.status) ? statusLabel(t.status) : '其他';
  parts.push(
    `<div class="card-head"><h3>${escapeHtml(t.title || '（无标题）')}</h3>` +
      (opts?.showStatus ? `<span class="badge">${escapeHtml(status)}</span>` : '') +
      '</div>',
  );
  const metaLine = [t.projectName, t.iteration ? `迭代 ${t.iteration}` : ''].filter(Boolean).join(' · ');
  if (metaLine) parts.push(`<p class="meta-line">${escapeHtml(metaLine)}</p>`);
  if (t.attemptSummary) {
    parts.push(`<p class="summary">${escapeHtml(t.attemptSummary).replace(/\n/g, '<br>')}</p>`);
  }
  const diff = taskDiffLine(t);
  if (diff) parts.push(`<p class="changes">${escapeHtml(diff)}</p>`);
  const diffUrl = safeHttpUrl(t.diffUrl);
  if (diffUrl) {
    parts.push(`<a class="diff-link" href="${escapeHtml(diffUrl)}" target="_blank" rel="noopener">查看改动 →</a>`);
  }
  parts.push('</div>');
  return parts.join('\n');
}

/** 日报页面差异样式（与 work-summary/复盘雷同的公共区块见 report-cards.ts 的 REPORT_CARDS_CSS）。 */
const DAILY_PAGE_CSS = `
  .hero {
    background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%);
  }
  .badge { background: #e5e7eb; color: #4b5563; flex-shrink: 0; }
  .note { font-size: 13px; color: #6b7280; margin-top: 20px; }
`;

function htmlSection(title: string, tasks: WorkSummaryTask[], total: number, opts?: { showStatus?: boolean }): string {
  if (!total) return '';
  const listed = tasks.map((t) => htmlTaskItem(t, opts)).join('\n');
  const more = total > tasks.length ? `<p class="note">仅列出最近 ${tasks.length} 条，共 ${total} 条。</p>` : '';
  return `<section class="group">\n<h2>${title}<span class="count">${total}</span></h2>\n${listed || '<p class="empty">（清单样本未覆盖，见上方计数）</p>'}\n${more}\n</section>`;
}

export function renderDailyHtml(data: DailyReportData): string {
  const part = partitionDaily(data);
  const { counts } = data;
  const diffCards = data.diff
    ? `${htmlStatCard(String(data.diff.filesChanged), '改动文件')}${htmlStatCard(`+${data.diff.additions}`, '新增行', 'add')}${htmlStatCard(`-${data.diff.deletions}`, '删除行', 'del')}`
    : '';
  const sections = [
    htmlSection('✅ 今日完成', part.doneToday, counts.doneToday),
    htmlSection('🚧 进行中', part.inProgress, counts.inProgress),
    htmlSection('⚠️ 今日失败', part.failedToday, counts.failedToday, { showStatus: true }),
    htmlSection('🔍 今日新待审阅', part.inReviewToday, counts.inReviewToday),
  ]
    .filter(Boolean)
    .join('\n');
  const body = sections ||
    `<p class="empty">（${data.incomplete ? '成功采集的项目中，' : ''}当日没有看板活动记录，也没有进行中的任务）</p>`;
  const incompleteNote = taskCollectionIncompleteNote(data.incomplete);
  const notes = [
    ...(incompleteNote ? [incompleteNote] : []),
    '「当日」按部署机器本地时区日界统计。',
    '「今日完成」口径：状态已完成且最后更新时间在当日（看板无「完成时间」字段，与周报「本周完成」同一口径）。',
    '「今日失败」按最近一次执行失败标记统计，与状态分组正交（同一任务可同时属于其他分组）。',
    data.diff
      ? `改动统计仅覆盖当日有更新的任务${data.truncated ? `，且只统计最近 ${data.tasks.length} 条样本` : ''}。`
      : '看板未提供当日任务的改动统计数据。',
  ];
  return renderReportPage({
    title: `工作日报 · ${escapeHtml(data.date)}`,
    css: REPORT_CARDS_CSS + DAILY_PAGE_CSS,
    body: `  <header class="hero">
    <h1>工作日报</h1>
    <p class="subtitle">${escapeHtml(data.sinceLabel)}</p>
    <p class="gen">生成时间：${escapeHtml(formatGeneratedAt(data.generatedAt))}</p>
  </header>
  <section class="stats">
    ${htmlStatCard(String(counts.doneToday), '今日完成')}
    ${htmlStatCard(String(counts.inProgress), '进行中')}
    ${htmlStatCard(String(counts.failedToday), '今日失败')}
    ${htmlStatCard(String(counts.inReviewToday), '新待审阅')}
    ${diffCards}
  </section>
  ${body}
  <ul class="notes">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`,
  });
}

/** 写日报 HTML（reports/，文件名带 128-bit token 作为访问凭证，与 work-summary 同一托管与清理策略；异步写盘不阻塞 bot 事件循环）。 */
export async function writeDailyReport(data: DailyReportData, opts: { dir?: string } = {}): Promise<string> {
  const dir = opts.dir ?? reportsDir();
  ensurePrivateDirSync(dir);
  pruneOldReports(dir);
  const file = path.join(dir, `daily-report-${sanitizeName(data.date, 'report')}.${newReportToken()}.html`);
  await writeFilePrivate(file, renderDailyHtml(data));
  return file;
}

/**
 * 给 LLM 的结构化日报素材：四个分组的计数（全量口径）+ 清单标题 + diff 汇总 + 报告链接。
 * 文案即数据，没有的维度明说「无数据」，由 LLM 据此组织日报（组织契约写在工具描述里）。
 */
export function buildDailyMaterial(
  data: DailyReportData,
  opts: { htmlPath?: string; linkBaseUrl?: string; channel?: 'cli' | 'bot' } = {},
): string {
  const part = partitionDaily(data);
  const { counts } = data;
  const lines: string[] = [`📋 日报素材已生成（${data.sinceLabel}）`];
  if (opts.htmlPath) {
    if (opts.linkBaseUrl) {
      const url = `${opts.linkBaseUrl}/${path.basename(opts.htmlPath)}`;
      lines.push(`- HTML 日报：${url}`);
      lines.push(
        isLoopbackUrl(url)
          ? '（链接仅本机可达，手机/局域网打不开；报告保留 30 天，机器人重启后链接失效）'
          : '（链接仅本机所在网络可达；报告保留 30 天，机器人重启后链接失效）',
      );
    } else if (opts.channel !== 'bot') {
      lines.push(`- HTML 日报：${opts.htmlPath}`);
    }
    // bot 场景报告服务不可用时无链接可给：本机路径对飞书用户是死链且泄露部署机目录，省略只给文本摘要
  }
  lines.push(
    '',
    `计数：今日完成 ${counts.doneToday} · 进行中 ${counts.inProgress} · 今日失败 ${counts.failedToday} · 今日新待审阅 ${counts.inReviewToday}`,
    '（「今日完成」口径：状态已完成且最后更新时间在当日，与周报「本周完成」同一口径；看板无「完成时间」字段）',
  );
  const incompleteNote = taskCollectionIncompleteNote(data.incomplete);
  if (incompleteNote) lines.push(incompleteNote);
  const listGroup = (label: string, tasks: WorkSummaryTask[], total: number, extra?: (t: WorkSummaryTask) => string) => {
    if (!total) return;
    lines.push('', `【${label}】${total} 个`);
    for (const t of tasks.slice(0, 10)) {
      const diff = taskDiffLine(t);
      lines.push(`· 《${t.title || '（无标题）'}》${extra ? extra(t) : ''}${diff ? `（${diff}）` : ''}`);
    }
    if (total > Math.min(tasks.length, 10)) {
      const rest = total - Math.min(tasks.length, 10);
      // 指引必须与上方实际给出的入口一致：有链接说链接，有文件说文件（bot 拿不到部署机文件），
      // 未生成报告（html:false）或 bot 报告服务不可用时只报数量
      const guide =
        opts.htmlPath && opts.linkBaseUrl
          ? '见上方报告链接'
          : opts.htmlPath && opts.channel !== 'bot'
            ? '见报告文件'
            : '完整清单可直接问我';
      lines.push(`· …还有 ${rest} 个，${guide}`);
    }
  };
  listGroup('今日完成', part.doneToday, counts.doneToday);
  listGroup('进行中', part.inProgress, counts.inProgress, (t) => (t.attemptSummary ? ` — 摘要：${t.attemptSummary}` : ''));
  listGroup('今日失败（与上方分组正交，可能重复出现）', part.failedToday, counts.failedToday, (t) =>
    t.attemptSummary ? ` — 失败摘要：${t.attemptSummary}` : '',
  );
  listGroup('今日新待审阅', part.inReviewToday, counts.inReviewToday);
  lines.push('');
  if (data.diff) {
    lines.push(
      `改动统计：当日有更新的任务共改动 ${data.diff.filesChanged} 个文件，+${data.diff.additions} 行 / -${data.diff.deletions} 行` +
        (data.truncated ? `（仅统计最近 ${data.tasks.length} 条样本）` : ''),
    );
  } else {
    lines.push('改动统计：看板未提供当日任务的改动数据，日报中不要编造代码量。');
  }
  if (!data.tasks.length) {
    lines.push(
      '',
      data.incomplete
        ? '成功采集的项目中，当日没有任何看板活动记录，也没有进行中的任务。请如实说明，不要编造工作内容。'
        : '当日没有任何看板活动记录，也没有进行中的任务。请如实说明当天无看板数据，不要编造工作内容。',
    );
  }
  return lines.join('\n');
}
