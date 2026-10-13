/**
 * 看板 REST 返回体的宽松字段提取（看板版本间字段可能不同，取不到就静默兜底）：
 * summary / watcher / failure-diagnosis 共用的单源实现——摘要字段链、数字转换、
 * diff 统计映射此前三处各自内联且已分叉，新增字段别名只需改这里。
 */

/** 宽松转数字：字符串数字一并接受，非有限数返回 undefined。 */
export function toNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** 任务详情里的可读摘要原文（trim 后；截断长度由调用方按场景决定，取不到返回空串）。 */
export function pickAttemptSummaryText(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  const o = detail as Record<string, unknown>;
  const summary = o.last_attempt_summary ?? o.summary ?? o.result ?? o.last_attempt_output;
  return typeof summary === 'string' ? summary.trim() : '';
}

/** attempt/workspace 的 diff 统计（宽松字段映射，取不到的字段缺省）。 */
export interface DiffStats {
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  /** 变更文件路径清单（看板提供时）。 */
  changedFiles?: string[];
}

/** 从单条 workspace summary 记录里宽松提取 diff 统计。 */
export function pickDiffStats(row: Record<string, unknown>): DiffStats {
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
export function buildStatsLookup(raw: unknown): Map<string, DiffStats> {
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
