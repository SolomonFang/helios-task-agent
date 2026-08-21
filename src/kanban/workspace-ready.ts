/**
 * After start_workspace_session / hk start: detect silent setup failures
 * (e.g. base_branch fell back to "main" but the repo has no main → UI infinite loading).
 */

import { apiGet, KanbanHttpError } from './http';

export type RepoStartInput = {
  repo_id: string;
  base_branch?: string | null;
};

/** 运行时校验 RepoStartInput：对象、repo_id 为非空字符串、base_branch 存在则为 string/null。 */
export function isRepoStartInput(v: unknown): v is RepoStartInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.repo_id !== 'string' || !o.repo_id) return false;
  return o.base_branch === undefined || o.base_branch === null || typeof o.base_branch === 'string';
}

export type WorkspaceSetupState = 'ready' | 'pending' | 'failed' | 'unknown';

export interface WorkspaceSnapshot {
  container_ref: string | null;
  setup_completed_at?: string | null;
}

/** Fill missing base_branch from repo defaults; list unresolved repo_ids. */
export function applyRepoBaseBranches(
  repos: RepoStartInput[],
  defaults: Record<string, string | null | undefined>,
): { repos: RepoStartInput[]; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = repos.map((r) => {
    const explicit = typeof r.base_branch === 'string' ? r.base_branch.trim() : '';
    if (explicit) return { repo_id: r.repo_id, base_branch: explicit };
    const def = defaults[r.repo_id];
    const filled = typeof def === 'string' ? def.trim() : '';
    if (filled) return { repo_id: r.repo_id, base_branch: filled };
    unresolved.push(r.repo_id);
    return { repo_id: r.repo_id, base_branch: undefined };
  });
  return { repos: out, unresolved };
}

export function formatMissingBaseBranchError(repoIds: string[]): string {
  return (
    `无法启动工作区：以下仓库未在看板配置默认目标分支，且本次未指定分支：\n` +
    repoIds.map((id) => `- ${id}`).join('\n') +
    `\n请在看板的仓库设置里填写默认目标分支（如 develop），或在创建任务时显式指定分支（base_branch / --branch）。` +
    `\n（若不指定，看板会回退到 main 分支；仓库没有 main 时会创建出空工作区，看板详情页会一直转圈加载。）`
  );
}

/**
 * hk start 分支补全：缺分支的仓库回填看板配置的 default_target_branch，回填不了返回错误消息
 * （否则 hk / MCP 会静默回退 main，仓库没有 main 时 workspace 创建失败且 UI 一直 loading）。
 * 两种载体共用同一套回填语义：
 * - argv（string[]，hk_cli start）：扫描 `--repo <id>`，无 :branch 的原地改写为 `<id>:<branch>`；
 * - repos（RepoStartInput[]，MCP start_workspace_session）：缺 base_branch 的原地回填。
 * 没有任何待补全项时返回 noRepoError（未传则视为无需补全，返回 null）。
 */
export async function fillHkStartBranches(
  target: string[] | RepoStartInput[],
  kanbanUrl: string,
  { signal, noRepoError }: { signal?: AbortSignal; noRepoError?: string } = {},
): Promise<string | null> {
  const isArgv = target.length === 0 || typeof target[0] === 'string';
  let repos: RepoStartInput[];
  let repoArgs: number[] = [];
  if (isArgv) {
    const argv = target as string[];
    argv.forEach((a, i) => {
      if (a === '--repo' && typeof argv[i + 1] === 'string' && !argv[i + 1]!.includes(':')) repoArgs.push(i + 1);
    });
    repos = repoArgs.map((i) => ({ repo_id: argv[i]! }));
  } else {
    // 数据可能直接来自 MCP 入参：逐元素运行时校验，坏输入直接报错而不是静默错位回填
    const rows = target as unknown[];
    const bad = rows.findIndex((r) => !isRepoStartInput(r));
    if (bad >= 0) return `无法启动工作区：第 ${bad + 1} 个仓库参数格式不正确（需要提供仓库 ID）`;
    repos = rows as RepoStartInput[];
  }
  if (!repos.length) return noRepoError ?? null;
  const defaults = await fetchRepoDefaultBranches(
    kanbanUrl,
    repos.map((r) => r.repo_id),
    signal,
  );
  const { repos: filled, unresolved } = applyRepoBaseBranches(repos, defaults);
  if (unresolved.length) return formatMissingBaseBranchError(unresolved);
  if (isArgv) {
    const argv = target as string[];
    for (const i of repoArgs) argv[i] = `${argv[i]}:${defaults[argv[i]!]}`;
  } else {
    const out = target as unknown[];
    for (let i = 0; i < out.length; i++) out[i] = filled[i]!;
  }
  return null;
}

/** Prefer workspace_id field when present (start returns both task_id and workspace_id). */
export function extractWorkspaceId(startResult: string): string | null {
  try {
    const json = JSON.parse(startResult) as { workspace_id?: string };
    if (typeof json.workspace_id === 'string' && /^[0-9a-f-]{36}$/i.test(json.workspace_id)) {
      return json.workspace_id;
    }
  } catch {
    /* fall through */
  }
  const m = startResult.match(/"workspace_id"\s*:\s*"([0-9a-f-]{36})"/i);
  return m?.[1] || null;
}

/**
 * 分类工作区初始化状态。'unknown' 表示快照因瞬时错误（5xx/连接拒绝/网络抖动）
 * 拉取失败、状态不明——与 'failed'（已确认初始化失败，仅 404 判定）区分，
 * 调用方据此继续轮询而不是立即报「请检查分支设置」的误导文案。
 */
export function classifyWorkspaceSetup(ws: WorkspaceSnapshot | null | 'unknown'): WorkspaceSetupState {
  if (ws === 'unknown') return 'unknown';
  if (!ws) return 'failed';
  if (ws.container_ref) return 'ready';
  return 'pending';
}

export function formatWorkspaceSetupFailure(opts: {
  workspaceId: string;
  targetBranches: string[];
  elapsedMs: number;
}): string {
  const secs = Math.round(opts.elapsedMs / 1000);
  const branches = opts.targetBranches.length ? opts.targetBranches.join(', ') : '（未知）';
  const mainHint = opts.targetBranches.some((b) => b === 'main')
    ? `\n检测到目标分支为 main。若仓库实际没有 main 分支（例如主分支叫 develop），工作区会创建失败：任务状态不会变成「进行中」，看板详情页会一直转圈加载。`
    : '';
  return (
    `工作区 ${opts.workspaceId} 初始化超过 ${secs} 秒仍未就绪（看板分配的执行目录一直为空）。\n` +
    `当前目标分支：${branches}` +
    mainHint +
    `\n请检查：仓库在看板里的默认分支设置、以及创建任务时指定的分支是否存在；必要时归档该工作区后用正确分支重试。`
  );
}

/** Load default_target_branch for each repo_id (best-effort; missing → null). */
export async function fetchRepoDefaultBranches(
  kanbanUrl: string,
  repoIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  await Promise.all(
    repoIds.map(async (id) => {
      try {
        const json: unknown = await apiGet(kanbanUrl, `/repos/${id}`, { timeoutMs: 8000, signal });
        const branch =
          json && typeof json === 'object'
            ? (json as { default_target_branch?: unknown }).default_target_branch
            : null;
        out[id] = typeof branch === 'string' && branch.trim() ? branch.trim() : null;
      } catch {
        out[id] = null;
      }
    }),
  );
  return out;
}

export async function fetchWorkspaceSnapshot(
  kanbanUrl: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshot | null | 'unknown'> {
  try {
    const data: unknown = await apiGet(kanbanUrl, `/task-attempts/${workspaceId}`, { timeoutMs: 8000, signal });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const o = data as Record<string, unknown>;
    // 字段存在但类型不对（如 container_ref 非字符串）按缺失处理，不把脏数据当 ready
    return {
      container_ref: typeof o.container_ref === 'string' ? o.container_ref : null,
      setup_completed_at: typeof o.setup_completed_at === 'string' ? o.setup_completed_at : null,
    };
  } catch (err) {
    // 调用方中断（/stop）：向上抛，由 waitForWorkspaceReady 归入既有的「被中断」分支
    if (signal?.aborted) throw err;
    // 仅 404 判定工作区不存在/已清理 → failed（null）；其余瞬时错误（5xx/连接拒绝/网络抖动、
    // 含单次请求自身的超时）状态不明 → 'unknown'，让轮询继续而不是立即报误导性的「初始化失败」
    if (err instanceof KanbanHttpError && err.status === 404) return null;
    return 'unknown';
  }
}

export async function fetchWorkspaceTargetBranches(
  kanbanUrl: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const rows: unknown = await apiGet(kanbanUrl, `/task-attempts/${workspaceId}/repos`, { timeoutMs: 8000, signal });
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => (r && typeof r === 'object' ? (r as { target_branch?: unknown }).target_branch : undefined))
      .filter((b): b is string => typeof b === 'string' && Boolean(b));
  } catch {
    return [];
  }
}

export interface WaitReadyResult {
  ok: boolean;
  message?: string;
}

/** Poll until container_ref is set, or fail with a diagnostic message. */
export async function waitForWorkspaceReady(
  kanbanUrl: string,
  workspaceId: string,
  {
    timeoutMs = 45000,
    intervalMs = 1000,
    signal,
  }: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<WaitReadyResult> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return { ok: false, message: '（等待工作区初始化时被中断）' };
    let snap: Awaited<ReturnType<typeof fetchWorkspaceSnapshot>>;
    try {
      snap = await fetchWorkspaceSnapshot(kanbanUrl, workspaceId, signal);
    } catch (err) {
      // fetchWorkspaceSnapshot 仅在调用方 signal 中断时向上抛：归入「被中断」，不走误导性的失败文案
      if (signal?.aborted) return { ok: false, message: '（等待工作区初始化时被中断）' };
      throw err;
    }
    const state = classifyWorkspaceSetup(snap);
    if (state === 'ready') return { ok: true };
    if (state === 'failed') {
      const branches = await fetchWorkspaceTargetBranches(kanbanUrl, workspaceId, signal);
      return {
        ok: false,
        message: formatWorkspaceSetupFailure({
          workspaceId,
          targetBranches: branches,
          elapsedMs: Date.now() - started,
        }),
      };
    }
    // pending / unknown（瞬时错误、状态不明）都继续轮询，由整体 timeoutMs 兜底
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const branches = await fetchWorkspaceTargetBranches(kanbanUrl, workspaceId, signal);
  return {
    ok: false,
    message: formatWorkspaceSetupFailure({
      workspaceId,
      targetBranches: branches,
      elapsedMs: Date.now() - started,
    }),
  };
}
