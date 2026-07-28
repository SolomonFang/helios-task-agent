/**
 * Work-summary data collection: pulls kanban tasks (per iteration / today / all)
 * plus per-task attempt summaries and diff stats for the work_summary report.
 * Read-only; individual fetch failures never abort the whole collection.
 */

export type WorkSummaryScope = 'iteration' | 'today' | 'all';

export interface WorkSummaryTask {
  id: string;
  title: string;
  status: string;
  iteration: string;
  projectName: string;
  updatedAt: string;
  attemptSummary?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  /** Top 10 changed file paths. */
  changedFiles?: string[];
  diffUrl: string;
}

export interface WorkSummaryTotals {
  done: number;
  inreview: number;
  inprogress: number;
  todo: number;
  cancelled: number;
  filesChanged: number;
  additions: number;
  deletions: number;
}

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

interface TaskRow {
  id?: string;
  title?: string;
  status?: string;
  iteration?: string | number;
  updated_at?: string;
}

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

async function apiGet(kanbanUrl: string, p: string): Promise<unknown> {
  const base = kanbanUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api${p}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { success?: boolean; data?: unknown; message?: string };
  if (json && json.success === true) return json.data;
  throw new Error(json?.message || 'kanban api error');
}

async function apiPost(kanbanUrl: string, p: string, body: unknown): Promise<unknown> {
  const base = kanbanUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { success?: boolean; data?: unknown; message?: string };
  if (json && json.success === true) return json.data;
  throw new Error(json?.message || 'kanban api error');
}

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
  const list = (await apiGet(kanbanUrl, '/projects')) as Array<Record<string, unknown>>;
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => ({ id: String(p.id || ''), name: String(p.name || p.id || '') }))
    .filter((p) => p.id);
}

function localDate(d = new Date()): string {
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

export async function collectWorkSummary(opts: CollectWorkSummaryOptions): Promise<WorkSummaryData> {
  const { kanbanUrl, scope } = opts;
  const iteration = (opts.iteration || '').trim();
  const base = kanbanUrl.replace(/\/+$/, '');

  const projects = await resolveProjects(kanbanUrl, opts.projectId);

  // workspace diff 统计只拉一次，按 attempt/workspace id 匹配；失败不阻断报告
  let statsLookup = new Map<string, DiffStats>();
  try {
    statsLookup = buildStatsLookup(await apiPost(kanbanUrl, '/task-attempts/summary', { archived: false }));
  } catch {
    /* diff 统计端点可选 */
  }

  const todayStart = startOfToday();
  const rows: Array<{ row: TaskRow; project: ProjectRef }> = [];
  for (const project of projects) {
    let list: TaskRow[];
    try {
      list = (await apiGet(kanbanUrl, `/tasks?project_id=${project.id}`)) as TaskRow[];
    } catch {
      continue; // 单项目失败不阻断其它项目
    }
    if (!Array.isArray(list)) continue;
    for (const row of list) rows.push({ row, project });
  }

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

  const enrich = async ({ row, project }: { row: TaskRow; project: ProjectRef }): Promise<WorkSummaryTask> => {
    const taskId = String(row.id);
    const pageUrl = `${base}/local-projects/${project.id}/tasks/${taskId}`;
    const task: WorkSummaryTask = {
      id: taskId,
      title: String(row.title || ''),
      status: String(row.status || ''),
      iteration: String(row.iteration ?? ''),
      projectName: project.name,
      updatedAt: String(row.updated_at || ''),
      diffUrl: pageUrl,
    };
    try {
      const summary = pickAttemptSummary(await apiGet(kanbanUrl, `/tasks/${taskId}`));
      if (summary) task.attemptSummary = summary;
    } catch {
      /* 详情拉取失败不阻断 */
    }
    try {
      const attempts = (await apiGet(kanbanUrl, `/task-attempts?task_id=${taskId}`)) as Array<{
        id?: string;
        archived?: boolean;
        created_at?: string;
      } | null>;
      if (Array.isArray(attempts)) {
        const rows2 = attempts.filter((a): a is { id: string; archived?: boolean; created_at?: string } =>
          Boolean(a && a.id),
        );
        const live = rows2.filter((a) => !a.archived);
        const pool = live.length ? live : rows2;
        pool.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
        // 从新到旧找第一份有 diff 统计的 attempt
        for (let i = pool.length - 1; i >= 0; i--) {
          const stats = statsLookup.get(pool[i]!.id);
          if (i === pool.length - 1) {
            task.diffUrl = `${pageUrl}/attempts/${pool[i]!.id}?view=diffs`;
          }
          if (stats) {
            if (stats.filesChanged !== undefined) task.filesChanged = stats.filesChanged;
            if (stats.additions !== undefined) task.additions = stats.additions;
            if (stats.deletions !== undefined) task.deletions = stats.deletions;
            if (stats.changedFiles?.length) task.changedFiles = stats.changedFiles.slice(0, 10);
            break;
          }
        }
      }
    } catch {
      /* attempts 拉取失败回退任务页链接 */
    }
    return task;
  };

  const tasks: WorkSummaryTask[] = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    tasks.push(...(await Promise.all(batch.map(enrich))));
  }

  const totals: WorkSummaryTotals = {
    done: 0,
    inreview: 0,
    inprogress: 0,
    todo: 0,
    cancelled: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
  };
  for (const t of tasks) {
    if (t.status in totals) totals[t.status as 'done' | 'inreview' | 'inprogress' | 'todo' | 'cancelled']++;
    if (t.filesChanged !== undefined) totals.filesChanged += t.filesChanged;
    if (t.additions !== undefined) totals.additions += t.additions;
    if (t.deletions !== undefined) totals.deletions += t.deletions;
  }

  const sinceLabel =
    scope === 'iteration'
      ? iteration
        ? `迭代 ${iteration}`
        : '全部迭代'
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
