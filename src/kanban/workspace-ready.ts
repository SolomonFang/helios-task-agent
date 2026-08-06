/**
 * After start_workspace_session / hk start: detect silent setup failures
 * (e.g. base_branch fell back to "main" but the repo has no main → UI infinite loading).
 */

import { apiGet } from './http';

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

export type WorkspaceSetupState = 'ready' | 'pending' | 'failed';

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
    `无法启动 workspace：以下仓库未配置 default_target_branch，且调用未传 base_branch：\n` +
    repoIds.map((id) => `- ${id}`).join('\n') +
    `\n请在看板仓库设置里填写默认目标分支（如 hly-dev），或在 start 时显式传入 base_branch / --branch。` +
    `\n（若省略后回退到 main 而仓库没有 main，会创建空 workspace 并在 UI 一直 loading。）`
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
    if (bad >= 0) return `无法启动 workspace：repos[${bad}] 不是有效的 { repo_id: string } 输入`;
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

export function classifyWorkspaceSetup(ws: WorkspaceSnapshot | null): WorkspaceSetupState {
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
  const branches = opts.targetBranches.length ? opts.targetBranches.join(', ') : '(unknown)';
  const mainHint = opts.targetBranches.some((b) => b === 'main')
    ? `\n检测到 target_branch=main。若仓库没有 main（例如实际是 hly-dev），worktree 会创建失败，看板任务状态不会变成进行中，详情页会一直 loading。`
    : '';
  return (
    `workspace ${opts.workspaceId} 在 ${secs}s 内未完成 setup（container_ref 仍为空）。\n` +
    `当前 target_branch：${branches}` +
    mainHint +
    `\n请检查：仓库 default_target_branch、start 的 base_branch/--branch 是否存在；必要时归档该空 workspace 后用正确分支重试。`
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
): Promise<WorkspaceSnapshot | null> {
  try {
    const data: unknown = await apiGet(kanbanUrl, `/task-attempts/${workspaceId}`, { timeoutMs: 8000, signal });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const o = data as Record<string, unknown>;
    // 字段存在但类型不对（如 container_ref 非字符串）按缺失处理，不把脏数据当 ready
    return {
      container_ref: typeof o.container_ref === 'string' ? o.container_ref : null,
      setup_completed_at: typeof o.setup_completed_at === 'string' ? o.setup_completed_at : null,
    };
  } catch {
    return null;
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
    if (signal?.aborted) return { ok: false, message: '（等待 workspace setup 时被中断）' };
    const snap = await fetchWorkspaceSnapshot(kanbanUrl, workspaceId, signal);
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
