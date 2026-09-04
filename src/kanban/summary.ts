/**
 * Work-summary data collection: pulls kanban tasks (per iteration / today / all)
 * plus per-task attempt summaries and diff stats for the work_summary report.
 * Read-only; individual fetch failures never abort the whole collection.
 */

import {
  apiGet,
  apiPost,
  taskPageUrl,
  attemptDiffUrl,
  sortTaskAttempts,
  validateKanbanProjectRows,
  validateSummaryTaskRows,
  type KanbanProjectRow,
  type SummaryTaskRow,
} from './http';
import { TASK_STATUS_KEYS } from './status';

export type WorkSummaryScope = 'iteration' | 'today' | 'all';

export interface WorkSummaryTask {
  id: string;
  title: string;
  status: string;
  iteration: string;
  projectName: string;
  updatedAt: string;
  /** 最近一次 attempt 失败标记（晨报「失败」分组用）。 */
  failed?: boolean;
  attemptSummary?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  /** Top 10 changed file paths. */
  changedFiles?: string[];
  /** 截断前的变更文件总数（changedFiles 仅保留前 10 条；报告层「等 +N 个」展示用）。 */
  changedFilesTotal?: number;
  diffUrl: string;
}

export interface WorkSummaryTotals {
  done: number;
  inreview: number;
  inprogress: number;
  todo: number;
  cancelled: number;
  /** 最近一次 attempt 失败的任务数（与状态计数正交：失败任务可停在任意状态）。 */
  failed: number;
  /** 本周完成数（done 且 updated_at ≥ 本周一 00:00，截断前全量口径；周报「本周完成」分组计数用）。 */
  doneThisWeek?: number;
  filesChanged: number;
  additions: number;
  deletions: number;
}

// statusLabel 已收口到 ./status（状态键与中文 label 的唯一来源）；re-export 兼容既有调用方
export { statusLabel, isKnownStatus } from './status';

export interface WorkSummaryData {
  scope: WorkSummaryScope;
  iteration?: string;
  generatedAt: string;
  /** e.g. 迭代 260717 / 2026-07-28 今天 */
  sinceLabel: string;
  tasks: WorkSummaryTask[];
  totals: WorkSummaryTotals;
}

export interface CollectWorkSummaryOptions {
  kanbanUrl: string;
  projectId?: string;
  iteration?: string;
  scope: WorkSummaryScope;
}

type TaskRow = SummaryTaskRow;

interface ProjectRef {
  id: string;
  name: string;
}

interface DiffStats {
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: string[];
}

/** 单报告最多展开的任务数（按更新时间倒序取最近）。 */
const MAX_TASKS = 50;
/** 任务详情并发上限。 */
const CONCURRENCY = 5;

/** 宽松提取任务详情里的可读摘要（看板版本间字段可能不同，取不到就静默兜底）。 */
function pickAttemptSummary(detail: unknown): string | undefined {
  if (!detail || typeof detail !== 'object') return undefined;
  const o = detail as Record<string, unknown>;
  const summary = o.last_attempt_summary ?? o.summary ?? o.result ?? o.last_attempt_output;
  if (typeof summary === 'string' && summary.trim()) {
    const t = summary.trim();
    return t.length > 500 ? `${t.slice(0, 500)}…` : t;
  }
  return undefined;
}

function toNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** 从单条 workspace summary 记录里宽松提取 diff 统计。 */
function pickDiffStats(row: Record<string, unknown>): DiffStats {
  const out: DiffStats = {};
  const rawFiles = row.changed_files ?? row.files ?? row.file_list;
  if (Array.isArray(rawFiles)) {
    const names = rawFiles
      .map((f) => {
        if (typeof f === 'string') return f;
        if (f && typeof f === 'object') {
          const o = f as Record<string, unknown>;
          return String(o.path ?? o.file ?? o.name ?? o.filename ?? '');
        }
        return '';
      })
      .filter(Boolean);
    if (names.length) out.changedFiles = names;
  }
  const filesChanged = toNumber(
    row.files_changed ?? row.file_count ?? row.filesChanged ?? row.changed_files_count,
  );
  if (filesChanged !== undefined) out.filesChanged = filesChanged;
  else if (out.changedFiles) out.filesChanged = out.changedFiles.length;
  const additions = toNumber(row.additions ?? row.added_lines ?? row.lines_added);
  if (additions !== undefined) out.additions = additions;
  const deletions = toNumber(row.deletions ?? row.deleted_lines ?? row.lines_removed);
  if (deletions !== undefined) out.deletions = deletions;
  return out;
}

/** POST /task-attempts/summary 返回结构不稳定：数组或按 id 键控的对象都兼容，产出 id → stats。 */
function buildStatsLookup(raw: unknown): Map<string, DiffStats> {
  const map = new Map<string, DiffStats>();
  const walk = (key: string | undefined, val: unknown) => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return;
    const row = val as Record<string, unknown>;
    const id = String(row.workspace_id ?? row.id ?? row.attempt_id ?? row.task_attempt_id ?? key ?? '');
    if (id) map.set(id, pickDiffStats(row));
  };
  if (Array.isArray(raw)) {
    for (const v of raw) walk(undefined, v);
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) walk(k, v);
  }
  return map;
}

async function resolveProjects(kanbanUrl: string, projectId?: string): Promise<ProjectRef[]> {
  if (projectId) {
    let name = projectId;
    try {
      const p = (await apiGet(kanbanUrl, `/projects/${projectId}`)) as Record<string, unknown> | null;
      if (p && typeof p.name === 'string' && p.name) name = p.name;
    } catch {
      /* 项目名取不到就用 id */
    }
    return [{ id: projectId, name }];
  }
  const raw = await apiGet(kanbanUrl, '/projects'); // 网络错误照常上抛
  let list: KanbanProjectRow[];
  try {
    list = validateKanbanProjectRows('/projects', raw);
  } catch {
    return []; // 返回形状不符按原 Array.isArray 兜底：视为无项目
  }
  return list
    .map((p) => ({ id: String(p.id || ''), name: String(p.name || p.id || '') }))
    .filter((p) => p.id);
}

/** 本地日期 YYYY-MM-DD（日报目标日期默认值与文件名共用，必须用本地时区而非 toISOString）。 */
export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本周周一 00:00（本地时间）：「本周完成」全量计数起点（与周报/复盘同一口径）。 */
function startOfWeek(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** 本地日期 YYYY-MM-DD 的日界 [当天 00:00, 次日 00:00)（逐字段构造，避免 new Date('YYYY-MM-DD') 按 UTC 解析）。 */
function dayRange(date: string): { start: number; end: number } {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y!, m! - 1, d!);
  const end = new Date(y!, m! - 1, d! + 1);
  return { start: start.getTime(), end: end.getTime() };
}

/** updated_at 是否落在目标日期（本地日界，左闭右开）；无法解析保守判否（宁缺毋假）。 */
export function isWithinDate(updatedAt: string, date: string): boolean {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  const { start, end } = dayRange(date);
  return t >= start && t < end;
}

interface CollectedRows {
  rows: Array<{ row: TaskRow; project: ProjectRef }>;
  statsLookup: Map<string, DiffStats>;
}

/** 拉取全部项目任务行 + 一次性 diff 统计表（collectWorkSummary 与 collectDailyData 共用）。 */
async function fetchTaskRows(kanbanUrl: string, projectId?: string): Promise<CollectedRows> {
  const projects = await resolveProjects(kanbanUrl, projectId);

  // workspace diff 统计只拉一次，按 attempt/workspace id 匹配；失败不阻断报告
  let statsLookup = new Map<string, DiffStats>();
  try {
    statsLookup = buildStatsLookup(await apiPost(kanbanUrl, '/task-attempts/summary', { archived: false }));
  } catch {
    /* diff 统计端点可选 */
  }

  const rows: Array<{ row: TaskRow; project: ProjectRef }> = [];
  for (const project of projects) {
    let list: TaskRow[];
    try {
      list = validateSummaryTaskRows(
        `/tasks?project_id=${project.id}`,
        await apiGet(kanbanUrl, `/tasks?project_id=${project.id}`),
      );
    } catch {
      continue; // 单项目失败（网络错误或返回形状不符）不阻断其它项目
    }
    for (const row of list) rows.push({ row, project });
  }
  return { rows, statsLookup };
}

/** 单任务 enrich：详情摘要 + 最新 attempt 的 diff 统计（原 collectWorkSummary 闭包提升，两处采集共用）。 */
async function enrichTask(
  kanbanUrl: string,
  statsLookup: Map<string, DiffStats>,
  { row, project }: { row: TaskRow; project: ProjectRef },
): Promise<WorkSummaryTask> {
  const taskId = String(row.id);
  const pageUrl = taskPageUrl(kanbanUrl, project.id, taskId);
  const task: WorkSummaryTask = {
    id: taskId,
    title: String(row.title || ''),
    status: String(row.status || ''),
    iteration: String(row.iteration ?? ''),
    projectName: project.name,
    updatedAt: String(row.updated_at || ''),
    diffUrl: pageUrl,
  };
  if (row.last_attempt_failed) task.failed = true;
  try {
    const summary = pickAttemptSummary(await apiGet(kanbanUrl, `/tasks/${taskId}`));
    if (summary) task.attemptSummary = summary;
  } catch {
    /* 详情拉取失败不阻断 */
  }
  try {
    const pool = sortTaskAttempts(await apiGet(kanbanUrl, `/task-attempts?task_id=${taskId}`));
    // 从新到旧找第一份有 diff 统计的 attempt
    for (let i = pool.length - 1; i >= 0; i--) {
      const stats = statsLookup.get(pool[i]!.id);
      if (i === pool.length - 1) {
        task.diffUrl = attemptDiffUrl(pageUrl, pool[i]!.id);
      }
      if (stats) {
        if (stats.filesChanged !== undefined) task.filesChanged = stats.filesChanged;
        if (stats.additions !== undefined) task.additions = stats.additions;
        if (stats.deletions !== undefined) task.deletions = stats.deletions;
        if (stats.changedFiles?.length) {
          task.changedFilesTotal = stats.changedFiles.length;
          task.changedFiles = stats.changedFiles.slice(0, 10);
        }
        break;
      }
    }
  } catch {
    /* attempts 拉取失败回退任务页链接 */
  }
  return task;
}

/** 分批并发 enrich（单报告 CONCURRENCY 上限）。 */
async function enrichBatch(
  kanbanUrl: string,
  statsLookup: Map<string, DiffStats>,
  targets: Array<{ row: TaskRow; project: ProjectRef }>,
): Promise<WorkSummaryTask[]> {
  const tasks: WorkSummaryTask[] = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    tasks.push(...(await Promise.all(batch.map((t) => enrichTask(kanbanUrl, statsLookup, t)))));
  }
  return tasks;
}

export async function collectWorkSummary(opts: CollectWorkSummaryOptions): Promise<WorkSummaryData> {
  const { kanbanUrl, scope } = opts;
  const iteration = (opts.iteration || '').trim();

  const { rows, statsLookup } = await fetchTaskRows(kanbanUrl, opts.projectId);

  const todayStart = startOfToday();
  const filtered = rows.filter(({ row }) => {
    if (!row.id) return false;
    if (scope === 'iteration' && iteration) return String(row.iteration ?? '') === iteration;
    if (scope === 'today') {
      const t = Date.parse(String(row.updated_at ?? ''));
      return Number.isFinite(t) && t >= todayStart;
    }
    return true;
  });
  filtered.sort((a, b) =>
    String(b.row.updated_at || '').localeCompare(String(a.row.updated_at || '')),
  );
  const targets = filtered.slice(0, MAX_TASKS);

  const tasks = await enrichBatch(kanbanUrl, statsLookup, targets);

  const totals: WorkSummaryTotals = {
    done: 0,
    inreview: 0,
    inprogress: 0,
    todo: 0,
    cancelled: 0,
    failed: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
  // 状态计数遍历截断前的 filtered（行自带 status，无需 enrich）：范围内任务超 MAX_TASKS 时
  // 只对截断后的 50 条统计会让「概览」计数系统性偏小；filesChanged 等需 enrich 的数值仍按
  // 截断后的样本口径统计
  const weekStart = startOfWeek();
  for (const { row } of filtered) {
    // totals 还含 filesChanged 等数值键，计数时必须用显式状态键集合判定，不能用 in
    const statusKey = TASK_STATUS_KEYS.find((s) => s === String(row.status || ''));
    if (statusKey) totals[statusKey]++;
    // 失败标记与状态正交，同循环一并按截断前全量计数
    if (row.last_attempt_failed) totals.failed++;
    // 本周完成同样按截断前全量计数（周报分组计数用，updated_at 无法解析保守不计入）
    if (statusKey === 'done') {
      const t = Date.parse(String(row.updated_at ?? ''));
      if (Number.isFinite(t) && t >= weekStart) totals.doneThisWeek = (totals.doneThisWeek ?? 0) + 1;
    }
  }
  for (const t of tasks) {
    if (t.filesChanged !== undefined) totals.filesChanged += t.filesChanged;
    if (t.additions !== undefined) totals.additions += t.additions;
    if (t.deletions !== undefined) totals.deletions += t.deletions;
  }

  // 未配置迭代/全量范围统一称「全部任务」（与报告标题、晨报引导语同一措辞）
  const sinceLabel =
    scope === 'iteration'
      ? iteration
        ? `迭代 ${iteration}`
        : '全部任务'
      : scope === 'today'
        ? `${localDate()} 今天`
        : '全部任务';

  return {
    scope,
    ...(iteration ? { iteration } : {}),
    generatedAt: new Date().toISOString(),
    sinceLabel,
    tasks,
    totals,
  };
}

// ---------------------------------------------------------------------------
// 个人工作日报采集：某日看板活动（当日完成 / 进行中 / 当日失败 / 当日新待审阅 / diff 统计）。
// 「当日完成」口径与周报「本周完成」一致：状态已完成且最后更新时间落在当日（看板无
// 「完成时间」字段，updated_at 为最接近口径，无法解析保守不计入）。进行中任务不受
// 日期限制（供「明日计划」推断）。
// ---------------------------------------------------------------------------

export interface CollectDailyOptions {
  kanbanUrl: string;
  projectId?: string;
  /** 限定迭代；缺省为全部任务。 */
  iteration?: string;
  /** 目标日期 YYYY-MM-DD（本地时区）；缺省今天。 */
  date?: string;
}

export interface DailyCounts {
  /** 状态已完成且最后更新时间在当日（全量口径，不受 enrich 截断影响）。 */
  doneToday: number;
  /** 当前进行中（不限更新日期，全量口径）。 */
  inProgress: number;
  /** 最近一次执行失败且最后更新时间在当日（与状态计数正交，全量口径）。 */
  failedToday: number;
  /** 状态待审阅且最后更新时间在当日（全量口径）。 */
  inReviewToday: number;
}

export interface DailyDiffTotals {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface DailyReportData {
  /** 目标日期 YYYY-MM-DD。 */
  date: string;
  isToday: boolean;
  generatedAt: string;
  iteration?: string;
  /** e.g. 2026-09-04 今天 · 迭代 260717 / 2026-09-03 · 全部任务 */
  sinceLabel: string;
  counts: DailyCounts;
  /** 当日更新任务的 diff 汇总（enrich 样本口径）；样本内任务全无 diff 数据时为 null（报告层如实说明，不补零）。 */
  diff: DailyDiffTotals | null;
  /** enrich 样本：当日有更新的任务 ∪ 进行中任务（按更新时间倒序，最多 MAX_TASKS 条）。 */
  tasks: WorkSummaryTask[];
  /** enrich 候选超出 MAX_TASKS 被截断（counts 仍为全量口径，清单与 diff 为样本口径）。 */
  truncated: boolean;
}

export async function collectDailyData(opts: CollectDailyOptions): Promise<DailyReportData> {
  const { kanbanUrl } = opts;
  const iteration = (opts.iteration || '').trim();
  const date = (opts.date || '').trim() || localDate();

  const { rows, statsLookup } = await fetchTaskRows(kanbanUrl, opts.projectId);

  const scoped = rows.filter(
    ({ row }) => row.id && (!iteration || String(row.iteration ?? '') === iteration),
  );

  // 计数遍历截断前全量行（status / last_attempt_failed / updated_at 行上自带，无需 enrich）
  const counts: DailyCounts = { doneToday: 0, inProgress: 0, failedToday: 0, inReviewToday: 0 };
  const candidates: Array<{ row: TaskRow; project: ProjectRef }> = [];
  for (const item of scoped) {
    const status = String(item.row.status || '');
    const inDate = isWithinDate(String(item.row.updated_at ?? ''), date);
    if (status === 'inprogress') counts.inProgress++;
    if (inDate) {
      if (status === 'done') counts.doneToday++;
      if (status === 'inreview') counts.inReviewToday++;
      if (item.row.last_attempt_failed) counts.failedToday++;
    }
    if (inDate || status === 'inprogress') candidates.push(item);
  }
  candidates.sort((a, b) =>
    String(b.row.updated_at || '').localeCompare(String(a.row.updated_at || '')),
  );
  const truncated = candidates.length > MAX_TASKS;
  const tasks = await enrichBatch(kanbanUrl, statsLookup, candidates.slice(0, MAX_TASKS));

  // diff 只汇总「当日有更新」的样本任务；全无数据时返回 null，不拿 0 冒充真实统计
  let diff: DailyDiffTotals | null = null;
  for (const t of tasks) {
    if (!isWithinDate(t.updatedAt, date)) continue;
    if (t.filesChanged === undefined && t.additions === undefined && t.deletions === undefined) continue;
    diff = diff ?? { filesChanged: 0, additions: 0, deletions: 0 };
    if (t.filesChanged !== undefined) diff.filesChanged += t.filesChanged;
    if (t.additions !== undefined) diff.additions += t.additions;
    if (t.deletions !== undefined) diff.deletions += t.deletions;
  }

  const isToday = date === localDate();
  const dateLabel = isToday ? `${date} 今天` : date;
  const sinceLabel = `${dateLabel} · ${iteration ? `迭代 ${iteration}` : '全部任务'}`;

  return {
    date,
    isToday,
    generatedAt: new Date().toISOString(),
    ...(iteration ? { iteration } : {}),
    sinceLabel,
    counts,
    diff,
    tasks,
    truncated,
  };
}
