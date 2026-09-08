#!/usr/bin/env node
// Helios Kanban remote API CLI — zero-dependency Node port of hk.sh (Node >= 20)

const BASE_URL = (process.env.HELIOS_KANBAN_URL || 'http://localhost:7964').replace(/\/$/, '');

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

class ApiError extends Error {}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function extractMessage(json) {
  if (json && typeof json === 'object' && json.message != null) {
    return typeof json.message === 'string' ? json.message : JSON.stringify(json.message);
  }
  return '';
}

// jq `a // b`: b when a is null/undefined/false
const jqAlt = (a, b) => (a === null || a === undefined || a === false ? b : a);

// jq '.data' — pretty JSON, 2-space indent, `null` for missing data
function print(data) {
  process.stdout.write(JSON.stringify(data === undefined ? null : data, null, 2) + '\n');
}

async function api(method, path, body, opts = {}) {
  const url = `${BASE_URL}/api${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (opts.soft) throw new ApiError(err.message);
    fail(err.message);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  if (res.status >= 400) {
    const msg = extractMessage(json) || 'request failed';
    if (opts.soft) throw new ApiError(`HTTP ${res.status}: ${msg}`);
    fail(`HTTP ${res.status}: ${msg}`);
  }

  if (!json || json.success !== true) {
    const msg = extractMessage(json) || 'unknown error';
    if (opts.soft) throw new ApiError(`API error: ${msg}`);
    fail(`API error: ${msg}`);
  }

  return json.data === undefined ? null : json.data;
}

// api(...) 2>/dev/null || echo '<fallback>' — swallow errors, use fallback
async function apiOr(fallback, method, path, body) {
  try {
    return await api(method, path, body, { soft: true });
  } catch {
    return fallback;
  }
}

function taskUrl(projectId, taskId) {
  return `${BASE_URL}/local-projects/${projectId}/tasks/${taskId}`;
}

// If first arg looks like a UUID use it; else fall back to HELIOS_KANBAN_PROJECT_ID.
function resolveProjectId(maybe) {
  if (UUID_RE.test(maybe || '')) return maybe;
  if (process.env.HELIOS_KANBAN_PROJECT_ID) return process.env.HELIOS_KANBAN_PROJECT_ID;
  return '';
}

function normalizeExecutor(raw) {
  const upper = String(raw).toUpperCase().replace(/-/g, '_');
  switch (upper) {
    case 'CLAUDE':
    case 'CLAUDE_CODE':
      return 'CLAUDE_CODE';
    case 'CODEX':
      return 'CODEX';
    case 'GEMINI':
      return 'GEMINI';
    case 'AMP':
      return 'AMP';
    case 'REASONIX':
      return 'REASONIX';
    case 'CURSOR':
    case 'CURSOR_AGENT':
      return 'CURSOR_AGENT';
    case 'COPILOT':
      return 'COPILOT';
    case 'QWEN':
    case 'QWEN_CODE':
      return 'QWEN_CODE';
    case 'OPENCODE':
      return 'OPENCODE';
    case 'DROID':
      return 'DROID';
    case 'KIMI':
    case 'KIMI_CLI':
      return 'KIMI_CLI';
    default:
      return upper;
  }
}

async function resolveExecutorProfile(executor, variant) {
  if (!executor) {
    const info = await api('GET', '/info');
    executor = jqAlt(info?.config?.executor_profile?.executor, '');
    if (!variant) {
      variant = jqAlt(info?.config?.executor_profile?.variant, '');
    }
    if (!executor) {
      fail('error: could not read default executor from /api/info (config.executor_profile)');
    }
  } else {
    executor = normalizeExecutor(executor);
  }
  return { executor, variant: variant || '' };
}

async function resolveTargetBranch(repoId, branch) {
  if (branch) return branch;
  const repo = await api('GET', `/repos/${repoId}`);
  return jqAlt(repo?.default_target_branch, '') || 'main';
}

function resolveRepoId(repoId) {
  repoId = repoId || process.env.HELIOS_KANBAN_REPO_ID || '';
  if (!repoId) fail('error: --repo is required (or set HELIOS_KANBAN_REPO_ID)');
  return repoId;
}

function resolveIteration(iteration) {
  return iteration || process.env.HELIOS_KANBAN_ITERATION || '';
}

// Validate priority value; empty passes through (server defaults to medium).
function normalizePriority(raw) {
  const lower = String(raw).toLowerCase();
  if (['urgent', 'high', 'medium', 'low'].includes(lower)) return lower;
  fail(`error: invalid priority '${raw}' (urgent|high|medium|low)`);
}

// Validate task type value; empty passes through (server defaults to feat).
function normalizeTaskType(raw) {
  const lower = String(raw).toLowerCase();
  if (['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore'].includes(lower)) {
    return lower;
  }
  fail(`error: invalid task type '${raw}' (feat|fix|docs|style|refactor|perf|test|chore)`);
}

// Expand @tagname in text via GET /api/tags (same behavior as MCP create_task).
// Literal split/join replacement, mirroring hk.sh's jq reduce.
async function expandTags(text) {
  if (!text.includes('@')) return text;
  const tags = await apiOr([], 'GET', '/tags');
  if (!Array.isArray(tags) || tags.length === 0) return text;
  let out = text;
  for (const t of tags) {
    out = out.split('@' + t.tag_name).join(t.content);
  }
  return out;
}

// Only UUID-shaped ids are accepted — they get interpolated into API paths.
function validateId(name, value) {
  if (!UUID_RE.test(value || '')) {
    fail(`error: invalid ${name} '${value}' (expect UUID)`);
  }
}

// Build repos array for start/create-and-start.
// Each spec is "uuid" or "uuid:branch"; repos without an explicit branch use
// default_target_branch (else globalBranch/main).
async function buildReposJson(globalBranch, specs) {
  if (specs.length === 0) {
    const defaultRepo = process.env.HELIOS_KANBAN_REPO_ID || '';
    if (!defaultRepo) fail('error: --repo is required (or set HELIOS_KANBAN_REPO_ID)');
    specs = [defaultRepo];
  }

  const arr = [];
  for (const spec of specs) {
    let repoId, branch;
    const idx = spec.indexOf(':');
    if (idx !== -1) {
      repoId = spec.slice(0, idx);
      branch = spec.slice(idx + 1);
    } else {
      repoId = spec;
      branch = '';
    }
    validateId('repo_id', repoId);
    if (!branch) {
      branch = globalBranch || (await resolveTargetBranch(repoId, ''));
    }
    arr.push({ repo_id: repoId, target_branch: branch });
  }
  return arr;
}

// Resolve latest session for a task_id (preferred) or workspace_id.
async function resolveLatestSessionFor(id) {
  let workspaceId, taskId;

  const workspaces = await apiOr([], 'GET', `/task-attempts?task_id=${id}`);
  if (Array.isArray(workspaces) && workspaces.length > 0) {
    workspaceId = workspaces[0].id;
    taskId = id;
  } else {
    // Treat id as workspace_id
    workspaceId = id;
    const all = await api('GET', '/task-attempts');
    const row = Array.isArray(all) ? all.find((w) => w.id === workspaceId) : undefined;
    taskId = jqAlt(row?.task_id, '');
  }

  const sessions = await api('GET', `/sessions?workspace_id=${workspaceId}`);
  if (!Array.isArray(sessions) || sessions.length === 0) {
    fail(`error: no sessions found for workspace ${workspaceId}`);
  }

  return {
    taskId,
    workspaceId,
    sessionId: sessions[0].id,
    sessionExecutor: jqAlt(sessions[0].executor, ''),
  };
}

function usage() {
  process.stdout.write(`Helios Kanban remote CLI

Env:
  HELIOS_KANBAN_URL          Base URL (default: http://localhost:7964)
  HELIOS_KANBAN_PROJECT_ID   Default project UUID (omit project_id args when set)
  HELIOS_KANBAN_REPO_ID      Default repo UUID (omit --repo when set)
  HELIOS_KANBAN_ITERATION    Default iteration code (e.g. 260717)

Commands:
  health
  info
  projects
  projects create <name> [--description TEXT] [--repo-path PATH]...
  projects update <project_id> [--name TEXT] [--description TEXT]
  repos [project_id]
  branches <repo_id> [--query TEXT]
  tasks list [project_id] [--status S] [--priority P] [--type T] [--iteration CODE] [--query TEXT] [--limit N]
  tasks get <task_id>
  tasks create [project_id] <title> [--desc TEXT] [--iteration CODE] [--priority P] [--type T]
  tasks update <task_id> [--title T] [--status S] [--desc T] [--iteration CODE] [--priority P] [--type T]
  tasks cancel <task_id>
  tasks delete <task_id>
  start <task_id> [--repo ID|ID:branch]... [--executor E] [--variant V] [--branch B]
  create-and-start [project_id] <title> [--repo ID|ID:branch]... [--executor E] [--variant V] [--branch B] [--desc T] [--iteration CODE] [--priority P] [--type T]
  follow-up <task_id|workspace_id> <prompt...>   # auto-queues if agent running; expands @tags
  status <task_id>
  workspaces [--task TASK_ID]
  stop <workspace_id>
  tags
  approvals
  approve <approval_id> --process <execution_process_id>
  deny <approval_id> --process <execution_process_id> [--reason TEXT]

Notes:
  --executor optional → Settings default (config.executor_profile)
  --branch optional → repo.default_target_branch, else main
  --repo may repeat; use ID:branch for per-repo base branch
  --iteration optional → HELIOS_KANBAN_ITERATION when unset
  --priority: urgent | high | medium | low (default: medium)
  --type: feat | fix | docs | style | refactor | perf | test | chore (default: feat)
    → merge commit message is prefixed with it, e.g. "feat: <title> (helios-kanban xxxx)"
  @tagname in --desc / follow-up expands via /api/tags
  cancel ≠ delete ≠ stop (see SKILL.md)

Examples:
  hk tasks create "Fix login" --desc "Use @coding-standards" --priority urgent
  hk start <task_id> --repo <uuid1> --repo <uuid2>:develop
  hk follow-up <task_id> please also add unit tests
  hk status <task_id>
  hk approvals && hk approve <id> --process <ep_id>
  hk branches <repo_id> --query develop
`);
}

async function cmdHealth() {
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/health`);
  } catch (err) {
    fail(err.message);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail('error: invalid JSON in /api/health response');
  }
  print(json);
}

async function cmdInfo() {
  print(await api('GET', '/info'));
}

async function cmdProjects(args) {
  if (args[0] === 'update') return cmdProjectsUpdate(args.slice(1));
  if (args[0] === 'create') return cmdProjectsCreate(args.slice(1));
  const projects = await api('GET', '/projects');
  const out = [];
  // Enrich with repo names for agent routing
  for (const row of Array.isArray(projects) ? projects : []) {
    const repos = await apiOr([], 'GET', `/projects/${row.id}/repositories`);
    out.push({
      ...row,
      repos: (Array.isArray(repos) ? repos : []).map((r) => jqAlt(r.display_name, r.name)),
      description: jqAlt(row.description, null),
    });
  }
  print(out);
}

async function cmdProjectsUpdate(args) {
  const projectId = args[0];
  validateId('project_id', projectId);
  let name = '';
  let description = '';
  let hasDescription = false;
  for (let i = 1; i < args.length; ) {
    switch (args[i]) {
      case '--name':
        name = args[i + 1];
        i += 2;
        break;
      case '--description':
        description = args[i + 1];
        hasDescription = true;
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  const payload = {};
  if (name) payload.name = name;
  if (hasDescription) payload.description = description;
  print(await api('PUT', `/projects/${projectId}`, payload));
}

async function cmdProjectsCreate(args) {
  const name = args[0] || '';
  if (!name) fail('error: project name required');
  let description = '';
  const repoPaths = [];
  for (let i = 1; i < args.length; ) {
    switch (args[i]) {
      case '--description':
      case '--desc':
        description = args[i + 1];
        i += 2;
        break;
      case '--repo-path':
        repoPaths.push(args[i + 1]);
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  // git_repo_path is a path on the kanban SERVER host, not on this bot host
  const repositories = repoPaths.map((p) => {
    const trimmed = p.replace(/\/$/, '');
    return { display_name: trimmed.split('/').pop(), git_repo_path: trimmed };
  });
  const payload = { name, repositories };
  if (description !== '') payload.description = description;
  print(await api('POST', '/projects', payload));
}

async function cmdRepos(args) {
  const projectId = resolveProjectId(args[0]);
  if (!projectId) fail('error: project_id required (or set HELIOS_KANBAN_PROJECT_ID)');
  print(await api('GET', `/projects/${projectId}/repositories`));
}

async function cmdBranches(args) {
  const repoId = args[0];
  validateId('repo_id', repoId);
  let query = '';
  for (let i = 1; i < args.length; ) {
    switch (args[i]) {
      case '--query':
        query = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  const data = await api('GET', `/repos/${repoId}/branches`);
  let rows = Array.isArray(data) ? data : [];
  if (query) {
    const re = new RegExp(query, 'i');
    rows = rows.filter((b) => re.test(b.name));
  }
  print(rows.map(({ name, is_current, is_remote }) => ({ name, is_current, is_remote })));
}

async function cmdTasksList(args) {
  let projectId = '';
  if (args.length > 0 && UUID_RE.test(args[0])) {
    projectId = args[0];
    args = args.slice(1);
  } else {
    projectId = process.env.HELIOS_KANBAN_PROJECT_ID || '';
  }
  if (!projectId) fail('error: project_id required (or set HELIOS_KANBAN_PROJECT_ID)');

  let status = '';
  let iteration = '';
  let query = '';
  let limit = '50';
  let priority = '';
  let taskType = '';
  for (let i = 0; i < args.length; ) {
    switch (args[i]) {
      case '--status':
        status = args[i + 1];
        i += 2;
        break;
      case '--priority':
        priority = args[i + 1];
        i += 2;
        break;
      case '--type':
        taskType = args[i + 1];
        i += 2;
        break;
      case '--iteration':
        iteration = args[i + 1];
        i += 2;
        break;
      case '--query':
        query = args[i + 1];
        i += 2;
        break;
      case '--limit':
        limit = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  if (!/^[0-9]+$/.test(limit)) {
    fail(`error: invalid --limit '${limit}' (must be a non-negative integer)`);
  }
  const data = await api('GET', `/tasks?project_id=${projectId}`);
  let rows = Array.isArray(data) ? data : [];
  if (status) rows = rows.filter((t) => t.status === status);
  if (priority) {
    priority = normalizePriority(priority);
    rows = rows.filter((t) => t.priority === priority);
  }
  if (taskType) {
    taskType = normalizeTaskType(taskType);
    rows = rows.filter((t) => t.task_type === taskType);
  }
  if (iteration) rows = rows.filter((t) => t.iteration === iteration);
  if (query) {
    const re = new RegExp(query, 'i');
    rows = rows.filter((t) => re.test(`${t.title} ${jqAlt(t.description, '')}`));
  }
  print(rows.slice(0, Number(limit)));
}

async function cmdTasksGet(args) {
  validateId('task_id', args[0]);
  print(await api('GET', `/tasks/${args[0]}`));
}

async function cmdTasksCreate(args) {
  let projectId = '';
  let title = '';
  if (args.length >= 2 && UUID_RE.test(args[0])) {
    projectId = args[0];
    title = args[1];
    args = args.slice(2);
  } else if (args.length >= 1) {
    projectId = process.env.HELIOS_KANBAN_PROJECT_ID || '';
    title = args[0];
    args = args.slice(1);
  }
  if (!projectId || !title) {
    fail('error: need [project_id] <title> (or set HELIOS_KANBAN_PROJECT_ID)');
  }

  let desc = '';
  let iteration = '';
  let priority = '';
  let taskType = '';
  for (let i = 0; i < args.length; ) {
    switch (args[i]) {
      case '--desc':
        desc = args[i + 1];
        i += 2;
        break;
      case '--iteration':
        iteration = args[i + 1];
        i += 2;
        break;
      case '--priority':
        priority = args[i + 1];
        i += 2;
        break;
      case '--type':
        taskType = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  iteration = resolveIteration(iteration);
  if (priority) priority = normalizePriority(priority);
  if (taskType) taskType = normalizeTaskType(taskType);
  if (desc) desc = await expandTags(desc);

  const payload = { project_id: projectId, title, status: 'todo' };
  if (desc !== '') payload.description = desc;
  if (iteration !== '') payload.iteration = iteration;
  if (priority !== '') payload.priority = priority;
  if (taskType !== '') payload.task_type = taskType;
  const task = await api('POST', '/tasks', payload);
  print({ ...task, url: taskUrl(projectId, task.id) });
}

async function cmdTasksUpdate(args) {
  const taskId = args[0];
  validateId('task_id', taskId);
  let title = '';
  let status = '';
  let desc = '';
  let iteration = '';
  let hasIteration = false;
  let priority = '';
  let taskType = '';
  for (let i = 1; i < args.length; ) {
    switch (args[i]) {
      case '--title':
        title = args[i + 1];
        i += 2;
        break;
      case '--status':
        status = args[i + 1];
        i += 2;
        break;
      case '--desc':
        desc = args[i + 1];
        i += 2;
        break;
      case '--iteration':
        iteration = args[i + 1];
        hasIteration = true;
        i += 2;
        break;
      case '--priority':
        priority = args[i + 1];
        i += 2;
        break;
      case '--type':
        taskType = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  const payload = {};
  if (title) payload.title = title;
  if (status) payload.status = status;
  if (priority) payload.priority = normalizePriority(priority);
  if (taskType) payload.task_type = normalizeTaskType(taskType);
  if (desc) payload.description = await expandTags(desc);
  if (hasIteration) payload.iteration = iteration;
  print(await api('PUT', `/tasks/${taskId}`, payload));
}

async function cmdTasksDelete(args) {
  validateId('task_id', args[0]);
  print(await api('DELETE', `/tasks/${args[0]}`));
}

async function cmdTasksCancel(args) {
  const taskId = args[0];
  validateId('task_id', taskId);
  // Stop running workspaces first (best-effort)
  const workspaces = await apiOr([], 'GET', `/task-attempts?task_id=${taskId}`);
  if (Array.isArray(workspaces)) {
    for (const w of workspaces) {
      await apiOr(null, 'POST', `/task-attempts/${w.id}/stop`, {});
    }
  }
  print(await api('PUT', `/tasks/${taskId}`, { status: 'cancelled' }));
}

async function cmdStart(args) {
  const taskId = args[0];
  validateId('task_id', taskId);
  let executor = '';
  let variant = '';
  let branch = '';
  const repoSpecs = [];
  for (let i = 1; i < args.length; ) {
    switch (args[i]) {
      case '--executor':
        executor = args[i + 1];
        i += 2;
        break;
      case '--variant':
        variant = args[i + 1];
        i += 2;
        break;
      case '--repo':
        repoSpecs.push(args[i + 1]);
        i += 2;
        break;
      case '--branch':
        branch = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  const resolved = await resolveExecutorProfile(executor, variant);
  const repos = await buildReposJson(branch, repoSpecs);
  const payload = {
    task_id: taskId,
    executor_profile_id: resolved.variant
      ? { executor: resolved.executor, variant: resolved.variant }
      : { executor: resolved.executor },
    repos,
  };
  const result = await api('POST', '/task-attempts', payload);
  const task = await api('GET', `/tasks/${taskId}`);
  print({
    ...result,
    url: taskUrl(task.project_id, taskId),
    repos,
    executor: resolved.executor,
  });
}

async function cmdCreateAndStart(args) {
  let projectId = '';
  let title = '';
  if (args.length >= 2 && UUID_RE.test(args[0])) {
    projectId = args[0];
    title = args[1];
    args = args.slice(2);
  } else if (args.length >= 1) {
    projectId = process.env.HELIOS_KANBAN_PROJECT_ID || '';
    title = args[0];
    args = args.slice(1);
  }
  if (!projectId || !title) {
    fail('error: need [project_id] <title> (or set HELIOS_KANBAN_PROJECT_ID)');
  }

  let executor = '';
  let variant = '';
  let branch = '';
  let desc = '';
  let iteration = '';
  let priority = '';
  let taskType = '';
  const repoSpecs = [];
  for (let i = 0; i < args.length; ) {
    switch (args[i]) {
      case '--executor':
        executor = args[i + 1];
        i += 2;
        break;
      case '--variant':
        variant = args[i + 1];
        i += 2;
        break;
      case '--repo':
        repoSpecs.push(args[i + 1]);
        i += 2;
        break;
      case '--branch':
        branch = args[i + 1];
        i += 2;
        break;
      case '--desc':
        desc = args[i + 1];
        i += 2;
        break;
      case '--iteration':
        iteration = args[i + 1];
        i += 2;
        break;
      case '--priority':
        priority = args[i + 1];
        i += 2;
        break;
      case '--type':
        taskType = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  iteration = resolveIteration(iteration);
  if (priority) priority = normalizePriority(priority);
  if (taskType) taskType = normalizeTaskType(taskType);
  if (desc) desc = await expandTags(desc);
  const resolved = await resolveExecutorProfile(executor, variant);
  const repos = await buildReposJson(branch, repoSpecs);

  const taskObj = { project_id: projectId, title };
  if (desc !== '') taskObj.description = desc;
  if (iteration !== '') taskObj.iteration = iteration;
  if (priority !== '') taskObj.priority = priority;
  if (taskType !== '') taskObj.task_type = taskType;
  const payload = {
    task: taskObj,
    executor_profile_id: resolved.variant
      ? { executor: resolved.executor, variant: resolved.variant }
      : { executor: resolved.executor },
    repos,
  };
  const result = await api('POST', '/tasks/create-and-start', payload);
  const tid = jqAlt(result?.id, jqAlt(result?.task_id, ''));
  print({
    ...result,
    url: taskUrl(projectId, tid),
    repos,
    executor: resolved.executor,
  });
}

async function cmdFollowUp(args) {
  if (args.length < 2) {
    fail('usage: hk follow-up <task_id|workspace_id> <prompt...>');
  }
  const id = args[0];
  validateId('task_id|workspace_id', id);
  let prompt = args.slice(1).join(' ');
  if (!prompt) fail('error: prompt required');
  prompt = await expandTags(prompt);

  const session = await resolveLatestSessionFor(id);

  const resolved = await resolveExecutorProfile(session.sessionExecutor, '');

  let running = false;
  if (session.taskId) {
    const taskRow = await api('GET', `/tasks/${session.taskId}`);
    const projectId = taskRow.project_id;
    const tasks = await api('GET', `/tasks?project_id=${projectId}`);
    const row = Array.isArray(tasks) ? tasks.find((t) => t.id === session.taskId) : undefined;
    running = jqAlt(row?.has_in_progress_attempt, false);
  }

  const executorProfile = resolved.variant
    ? { executor: resolved.executor, variant: resolved.variant }
    : { executor: resolved.executor };

  let mode, result;
  if (running) {
    mode = 'queued';
    result = await api('POST', `/sessions/${session.sessionId}/queue`, {
      message: prompt,
      executor_profile_id: executorProfile,
    });
  } else {
    mode = 'follow_up';
    result = await api('POST', `/sessions/${session.sessionId}/follow-up`, {
      prompt,
      executor_profile_id: executorProfile,
    });
  }

  print({
    mode,
    session_id: session.sessionId,
    workspace_id: session.workspaceId,
    result,
  });
}

async function cmdStatus(args) {
  const taskId = args[0];
  validateId('task_id', taskId);
  const task = await api('GET', `/tasks/${taskId}`);
  const workspaces = await api('GET', `/task-attempts?task_id=${taskId}`);
  const summariesResp = await apiOr({ summaries: [] }, 'POST', '/task-attempts/summary', {
    archived: false,
  });
  const summaries = jqAlt(summariesResp?.summaries, []);

  const projectId = task.project_id;
  const tasksList = await api('GET', `/tasks?project_id=${projectId}`);
  const row = Array.isArray(tasksList) ? tasksList.find((t) => t.id === taskId) : undefined;

  print({
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      task_type: task.task_type,
      iteration: task.iteration,
      description: task.description,
    },
    url: taskUrl(projectId, taskId),
    running: jqAlt(row?.has_in_progress_attempt, false),
    last_attempt_failed: jqAlt(row?.last_attempt_failed, false),
    executor: jqAlt(row?.executor, null),
    workspaces: (Array.isArray(workspaces) ? workspaces : []).map((w) => ({
      id: w.id,
      branch: w.branch,
      archived: w.archived,
      name: w.name,
      summary:
        (Array.isArray(summaries) ? summaries : []).find((s) => s.workspace_id === w.id) ?? null,
    })),
  });
}

async function cmdWorkspaces(args) {
  let taskId = '';
  for (let i = 0; i < args.length; ) {
    switch (args[i]) {
      case '--task':
        taskId = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  if (taskId) {
    validateId('task_id', taskId);
    print(await api('GET', `/task-attempts?task_id=${taskId}`));
  } else {
    print(await api('GET', '/task-attempts'));
  }
}

async function cmdStop(args) {
  validateId('workspace_id', args[0]);
  print(await api('POST', `/task-attempts/${args[0]}/stop`, {}));
}

async function cmdTags() {
  const data = await api('GET', '/tags');
  print(
    (Array.isArray(data) ? data : []).map(({ id, tag_name, content }) => ({
      id,
      tag_name,
      content: [...String(content ?? '')].slice(0, 120).join(''),
    }))
  );
}

async function cmdApprovals() {
  print(await api('GET', '/approvals'));
}

async function cmdApprove(args) {
  const approvalId = args[0];
  validateId('approval_id', approvalId);
  let processId = '';
  for (let i = 1; i < args.length; ) {
    switch (args[i]) {
      case '--process':
        processId = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  if (!processId) fail('error: --process <execution_process_id> is required');
  print(
    await api('POST', `/approvals/${approvalId}/respond`, {
      execution_process_id: processId,
      status: { status: 'approved' },
    })
  );
}

async function cmdDeny(args) {
  const approvalId = args[0];
  validateId('approval_id', approvalId);
  let processId = '';
  let reason = '';
  for (let i = 1; i < args.length; ) {
    switch (args[i]) {
      case '--process':
        processId = args[i + 1];
        i += 2;
        break;
      case '--reason':
        reason = args[i + 1];
        i += 2;
        break;
      default:
        fail(`unknown arg: ${args[i]}`);
    }
  }
  if (!processId) fail('error: --process <execution_process_id> is required');
  const status = reason ? { status: 'denied', reason } : { status: 'denied' };
  print(
    await api('POST', `/approvals/${approvalId}/respond`, {
      execution_process_id: processId,
      status,
    })
  );
}

// --- main ---
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    process.exit(0);
  }

  const command = argv[0];
  const rest = argv.slice(1);

  switch (command) {
    case 'health':
      return cmdHealth();
    case 'info':
      return cmdInfo();
    case 'projects':
      return cmdProjects(rest);
    case 'repos':
      return cmdRepos(rest);
    case 'branches':
      return cmdBranches(rest);
    case 'tasks': {
      const sub = rest[0] || '';
      const subArgs = rest.slice(1);
      switch (sub) {
        case 'list':
          return cmdTasksList(subArgs);
        case 'get':
          return cmdTasksGet(subArgs);
        case 'create':
          return cmdTasksCreate(subArgs);
        case 'update':
          return cmdTasksUpdate(subArgs);
        case 'cancel':
          return cmdTasksCancel(subArgs);
        case 'delete':
          return cmdTasksDelete(subArgs);
        default:
          console.error(`unknown tasks subcommand: ${sub}`);
          usage();
          process.exit(1);
      }
    }
    case 'start':
      return cmdStart(rest);
    case 'create-and-start':
      return cmdCreateAndStart(rest);
    case 'follow-up':
      return cmdFollowUp(rest);
    case 'status':
      return cmdStatus(rest);
    case 'workspaces':
      return cmdWorkspaces(rest);
    case 'stop':
      return cmdStop(rest);
    case 'tags':
      return cmdTags();
    case 'approvals':
      return cmdApprovals();
    case 'approve':
      return cmdApprove(rest);
    case 'deny':
      return cmdDeny(rest);
    default:
      console.error(`unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
