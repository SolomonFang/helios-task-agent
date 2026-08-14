/**
 * helios-kanban REST API 的共享 HTTP 层：
 * - 信封解析统一收口（{success, data, message}），API 变更只需改这一处；
 * - 校验策略统一：success 字段存在则必须为 true 否则抛错；无信封的宽松回退
 *   （旧版本/个别端点直接返回数据）取 data ?? 原始 JSON；
 * - 返回体的运行时校验也收口在这里（validateXxxRows）：JSON.parse 后不再裸 `as`
 *   强转领域类型，形状不符时抛出带端点 + 行号 + 字段上下文的错误，调用方按原有
 *   容错路径（跳过该项目 / 回退空列表）消化，不让进程崩；
 * - 任务页 / 最新 attempt / diff 视图 URL 的拼接与挑选逻辑也在这里。
 */

export interface KanbanApiOptions {
  /** 默认 15000ms；传入 signal 时与超时组合，任一触发即中断（signal 不再绕过超时兜底）。 */
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

/**
 * 组合调用方 signal 与超时兜底：任一触发即中断。
 * AbortSignal.any 需 Node 20.3+（engines 要求 >=20），这里手写等价组合：
 * 挂在调用方 signal 上的监听器随 ctl 触发（任一分支到点）即摘除，不会在
 * 调用方 signal 上累积滞留（waitForWorkspaceReady 以同一 turn 级 signal 高频轮询）。
 */
function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (signal.aborted) return signal;
  const ctl = new AbortController();
  const onCallerAbort = (): void => ctl.abort();
  signal.addEventListener('abort', onCallerAbort, { once: true });
  timeout.addEventListener('abort', () => ctl.abort(), { once: true });
  // ctl 只会被上述两个分支之一触发：无论哪个先到，都在此摘掉调用方 signal 上的监听器
  ctl.signal.addEventListener('abort', () => signal.removeEventListener('abort', onCallerAbort), { once: true });
  return ctl.signal;
}

/** HTTP 非 2xx 错误：状态码随实例传递，调用方按 instanceof + status 分类，不从 message 反解析。
 * message 保持 `HTTP <status>` 文本格式（既有日志与断言按此匹配）。 */
export class KanbanHttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'KanbanHttpError';
  }
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
    signal: combinedSignal(opts.signal, opts.timeoutMs ?? 15000),
  });
  if (!res.ok) throw new KanbanHttpError(res.status);
  return envelopeData(await res.json());
}

/** 中断错误（调用方 signal / 超时兜底触发）：重试无意义，直接抛。 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** GET /api&lt;p&gt;，返回信封 data。瞬时失败间隔 500ms 轻量重试 1 次（GET 幂等）；中断与 HTTP 4xx 不重试；写操作不重试。 */
export async function apiGet(kanbanUrl: string, p: string, opts: KanbanApiOptions = {}): Promise<unknown> {
  try {
    return await request(kanbanUrl, p, {}, opts);
  } catch (err) {
    if (isAbortError(err) || (err instanceof KanbanHttpError && err.status >= 400 && err.status < 500)) throw err;
    await new Promise((r) => setTimeout(r, 500));
    return request(kanbanUrl, p, {}, opts);
  }
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

/** kanban 健康探测（/api/health，5s 超时）：'ok' / 'HTTP <code>' / '不可达'。 */
export async function fetchKanbanHealth(kanbanUrl: string): Promise<string> {
  try {
    const res = await fetch(`${kanbanUrl.replace(/\/+$/, '')}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? 'ok' : `HTTP ${res.status}`;
  } catch {
    return '不可达';
  }
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

/**
 * 返回体行数组的运行时校验：字段缺失/空值容忍（看板版本间字段有增删），
 * 但字段存在则类型必须正确；非数组或行不符时抛出带端点 + 行号 + 字段上下文的错误。
 */
type FieldType = 'string' | 'number' | 'boolean' | 'string|number';

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkFields(row: Record<string, unknown>, spec: Record<string, FieldType>): string | null {
  for (const [field, type] of Object.entries(spec)) {
    const v = row[field];
    if (v === undefined || v === null) continue; // 缺省/空值容忍
    const ok = type === 'string|number' ? typeof v === 'string' || typeof v === 'number' : typeof v === type;
    if (!ok) return `字段 ${field} 期望 ${type}，实际 ${describe(v)}`;
  }
  return null;
}

export function validateRows<T>(endpoint: string, data: unknown, spec: Record<string, FieldType>): T[] {
  if (!Array.isArray(data)) {
    throw new Error(`kanban api ${endpoint} 返回校验失败：期望数组，实际 ${describe(data)}`);
  }
  for (let i = 0; i < data.length; i++) {
    const row: unknown = data[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`kanban api ${endpoint} 返回校验失败：第 ${i + 1} 行不是对象（${describe(row)}）`);
    }
    const bad = checkFields(row as Record<string, unknown>, spec);
    if (bad) throw new Error(`kanban api ${endpoint} 返回校验失败：第 ${i + 1} 行${bad}`);
  }
  return data as T[];
}

/** /tasks 列表行（watcher 用）。 */
export interface KanbanTaskRow {
  id?: string;
  title?: string;
  status?: string;
  has_in_progress_attempt?: boolean;
  last_attempt_failed?: boolean;
}

export function validateKanbanTaskRows(endpoint: string, data: unknown): KanbanTaskRow[] {
  return validateRows(endpoint, data, {
    id: 'string',
    title: 'string',
    status: 'string',
    has_in_progress_attempt: 'boolean',
    last_attempt_failed: 'boolean',
  });
}

/** /tasks 列表行（work summary 用）：iteration 兼容 string/number 两种写法。 */
export interface SummaryTaskRow {
  id?: string;
  title?: string;
  status?: string;
  iteration?: string | number;
  updated_at?: string;
  last_attempt_failed?: boolean;
}

export function validateSummaryTaskRows(endpoint: string, data: unknown): SummaryTaskRow[] {
  return validateRows(endpoint, data, {
    id: 'string',
    title: 'string',
    status: 'string',
    iteration: 'string|number',
    updated_at: 'string',
    last_attempt_failed: 'boolean',
  });
}

/** /projects 列表行。 */
export interface KanbanProjectRow {
  id?: string;
  name?: string;
}

export function validateKanbanProjectRows(endpoint: string, data: unknown): KanbanProjectRow[] {
  return validateRows(endpoint, data, { id: 'string', name: 'string' });
}
