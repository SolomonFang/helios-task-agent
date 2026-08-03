/**
 * helios-kanban REST API 的共享 HTTP 层：
 * - 信封解析统一收口（{success, data, message}），API 变更只需改这一处；
 * - 校验策略统一：success 字段存在则必须为 true 否则抛错；无信封的宽松回退
 *   （旧版本/个别端点直接返回数据）取 data ?? 原始 JSON；
 * - 任务页 / 最新 attempt / diff 视图 URL 的拼接与挑选逻辑也在这里。
 */

export interface KanbanApiOptions {
  /** 默认 15000ms；传入 signal 时以调用方 signal 为准（不再套超时）。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface KanbanEnvelope {
  success?: boolean;
  data?: unknown;
  message?: string;
}

function envelopeData(json: unknown): unknown {
  const env = json as KanbanEnvelope | null;
  if (env && typeof env === 'object' && 'success' in env) {
    if (env.success === true) return env.data;
    throw new Error(env.message || 'kanban api error');
  }
  // 无信封宽松回退：直接返回 data 字段或原始 JSON
  if (env && typeof env === 'object' && 'data' in env) return env.data;
  return json;
}

async function request(
  kanbanUrl: string,
  p: string,
  init: RequestInit,
  opts: KanbanApiOptions = {},
): Promise<unknown> {
  const base = kanbanUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/api${p}`, {
    ...init,
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return envelopeData(await res.json());
}

/** GET /api&lt;p&gt;，返回信封 data。 */
export function apiGet(kanbanUrl: string, p: string, opts: KanbanApiOptions = {}): Promise<unknown> {
  return request(kanbanUrl, p, {}, opts);
}

/** POST /api&lt;p&gt;（JSON body），返回信封 data。 */
export function apiPost(kanbanUrl: string, p: string, body: unknown, opts: KanbanApiOptions = {}): Promise<unknown> {
  return request(
    kanbanUrl,
    p,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    opts,
  );
}

/** 看板 Web 任务详情页地址。 */
export function taskPageUrl(kanbanUrl: string, projectId: string, taskId: string): string {
  const base = kanbanUrl.replace(/\/+$/, '');
  return `${base}/local-projects/${projectId}/tasks/${taskId}`;
}

/** attempt 的 diff 视图地址（任务页 + attempts/<id>?view=diffs）。 */
export function attemptDiffUrl(pageUrl: string, attemptId: string): string {
  return `${pageUrl}/attempts/${attemptId}?view=diffs`;
}

/** /task-attempts 列表行（宽松解析，看板版本间字段可能不同）。 */
export interface TaskAttemptRow {
  id: string;
  archived?: boolean;
  created_at?: string;
}

/**
 * 过滤出有效 attempt 并排序：优先未归档（有未归档时丢弃归档行），按 created_at 升序。
 * 输入非数组返回空数组。
 */
export function sortTaskAttempts(list: unknown): TaskAttemptRow[] {
  if (!Array.isArray(list)) return [];
  const rows = list.filter((a): a is TaskAttemptRow => Boolean(a && typeof a === 'object' && (a as TaskAttemptRow).id));
  const live = rows.filter((a) => !a.archived);
  const pool = live.length ? live : rows;
  pool.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return pool;
}

/** 取最新 attempt（sortTaskAttempts 的队尾）；无有效行返回 null。 */
export function pickLatestAttempt(list: unknown): TaskAttemptRow | null {
  const pool = sortTaskAttempts(list);
  return pool.length ? pool[pool.length - 1]! : null;
}
