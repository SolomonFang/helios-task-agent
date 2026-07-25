/**
 * After start_workspace_session / hk start: detect silent setup failures
 * (e.g. base_branch fell back to "main" but the repo has no main → UI infinite loading).
 */

export type RepoStartInput = {
  repo_id: string;
  base_branch?: string | null;
};

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

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Load default_target_branch for each repo_id (best-effort; missing → null). */
export async function fetchRepoDefaultBranches(
  kanbanUrl: string,
  repoIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  const base = kanbanUrl.replace(/\/+$/, '');
  const out: Record<string, string | null> = {};
  await Promise.all(
    repoIds.map(async (id) => {
      try {
        const json = (await fetchJson(`${base}/api/repos/${id}`, signal)) as {
          data?: { default_target_branch?: string | null };
          default_target_branch?: string | null;
        };
        const branch = json?.data?.default_target_branch ?? json?.default_target_branch ?? null;
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
  const base = kanbanUrl.replace(/\/+$/, '');
  try {
    const json = (await fetchJson(`${base}/api/task-attempts/${workspaceId}`, signal)) as {
      data?: WorkspaceSnapshot;
      container_ref?: string | null;
      setup_completed_at?: string | null;
    };
    const data = json?.data ?? json;
    if (!data || typeof data !== 'object') return null;
    return {
      container_ref: (data as WorkspaceSnapshot).container_ref ?? null,
      setup_completed_at: (data as WorkspaceSnapshot).setup_completed_at ?? null,
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
  const base = kanbanUrl.replace(/\/+$/, '');
  try {
    const json = (await fetchJson(`${base}/api/task-attempts/${workspaceId}/repos`, signal)) as {
      data?: Array<{ target_branch?: string }>;
    };
    const rows = json?.data || [];
    return rows.map((r) => r.target_branch).filter((b): b is string => Boolean(b));
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
