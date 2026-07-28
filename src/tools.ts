import path from 'path';
import { execFile } from 'child_process';
import type { KanbanMcp } from './kanban/mcp';
import type { MemoryStore } from './memory';
import type { OpenAiTool, ToolHandlers } from './types';
import { runRepoFs } from './repo-fs';
import {
  classifyHk,
  classifyLark,
  classifyMcp,
  passGate,
  summarizeMcp,
  wrapUntrusted,
  type ConfirmFn,
} from './guard';
import { auditLog } from './audit';
import { SourceRegistry, extractSourceUrls, kanbanTaskExists } from './source-registry';
import {
  applyRepoBaseBranches,
  extractWorkspaceId,
  fetchRepoDefaultBranches,
  formatMissingBaseBranchError,
  waitForWorkspaceReady,
  type RepoStartInput,
} from './kanban/workspace-ready';
import { collectWorkSummary, type WorkSummaryScope } from './kanban/summary';
import { summarizeForChat, writeSummaryReports } from './report';

const HK_SCRIPT = path.join(__dirname, '..', 'skills', 'helios-kanban-remote', 'scripts', 'hk.sh');
const MAX_OUTPUT = 8000;
const EXEC_TIMEOUT = 60000;

function truncate(s: unknown): string {
  const str = String(s);
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + `\n…（输出过长，已截断，共 ${str.length} 字符）` : str;
}

function run(
  command: string,
  args: string[],
  { env, signal }: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('（命令已被用户中断）');
      return;
    }
    execFile(
      command,
      args,
      { timeout: EXEC_TIMEOUT, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env }, signal },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          resolve('（命令已被用户中断）');
          return;
        }
        if (error && !stdout) {
          resolve(`命令执行失败: ${error.message}\n${truncate(stderr || '')}`.trim());
        } else {
          const out = truncate(stdout || '');
          resolve(stderr && !out ? truncate(stderr) : out || '(无输出)');
        }
      },
    );
  });
}

function looksLikeFailure(s: string): boolean {
  return /命令执行失败|调用失败|执行异常|^错误|error|HTTP \d|API error|失败|denied|not found/i.test(s.slice(0, 300));
}

function extractUuid(s: string): string | null {
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

/** hk tasks create [project_id] <title> — title = first non-flag arg that is not a UUID. */
function hkCreateTitle(args: string[]): string {
  const rest = args[0] === 'create-and-start' ? args.slice(1) : args.slice(2);
  for (const a of rest) {
    if (a.startsWith('--')) break;
    if (/^[0-9a-fA-F-]{36}$/.test(a)) continue;
    return a;
  }
  return '';
}

/** Destructive ops never batch — each requires its own confirmation. */
const NO_BATCH_RE = /delete|cancel|stop|deny/i;

function batchKeyForMcp(name: string): string | undefined {
  return NO_BATCH_RE.test(name) ? undefined : `kanban:${name}`;
}

function batchKeyForHk(argv: string[]): string | undefined {
  const sub = `${argv[0] ?? ''} ${argv[1] ?? ''}`.trim();
  return NO_BATCH_RE.test(sub) ? undefined : `hk:${sub}`;
}

function parseMcpStartRepos(args: Record<string, unknown>): RepoStartInput[] | null {
  if (!Array.isArray(args.repos)) return null;
  const out: RepoStartInput[] = [];
  for (const item of args.repos) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.repo_id !== 'string' || !row.repo_id) continue;
    out.push({
      repo_id: row.repo_id,
      base_branch: typeof row.base_branch === 'string' ? row.base_branch : undefined,
    });
  }
  return out.length ? out : null;
}

/** Ensure start repos have base_branch; mutates args.repos when filled from defaults. */
async function prepareMcpStartArgs(
  args: Record<string, unknown>,
  kanbanUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const repos = parseMcpStartRepos(args);
  if (!repos) return null;
  const defaults = await fetchRepoDefaultBranches(
    kanbanUrl,
    repos.map((r) => r.repo_id),
    signal,
  );
  const { repos: filled, unresolved } = applyRepoBaseBranches(repos, defaults);
  if (unresolved.length) return formatMissingBaseBranchError(unresolved);
  args.repos = filled.map((r) => ({
    repo_id: r.repo_id,
    ...(r.base_branch ? { base_branch: r.base_branch } : {}),
  }));
  return null;
}

function hkStartHasBranch(argv: string[]): boolean {
  if (argv.includes('--branch')) return true;
  return argv.some((a, i) => a === '--repo' && typeof argv[i + 1] === 'string' && String(argv[i + 1]).includes(':'));
}

async function appendWorkspaceReadyCheck(
  result: string,
  kanbanUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  if (looksLikeFailure(result)) return result;
  const workspaceId = extractWorkspaceId(result);
  if (!workspaceId) return result;
  const ready = await waitForWorkspaceReady(kanbanUrl, workspaceId, { signal });
  if (ready.ok) {
    return `${result}\n\n（workspace setup 已就绪：container 已创建）`;
  }
  return `${result}\n\n⚠️ setup 未完成：\n${ready.message || '未知原因'}`;
}

/** 单次会话创建任务数上限（代码层强制，不只靠 prompt 自觉）。 */
const MAX_CREATES_PER_SESSION = 10;
const CREATE_CAP_MESSAGE = `单次会话最多创建 ${MAX_CREATES_PER_SESSION} 个看板任务（已达上限，代码层强制）。请如实告知用户；如需更多，建议 /clear 后再创建。`;

/** 闸门卡片 detail：create 类结构化展示（标题/项目/描述预览），其余保持命令行原文。 */
function formatMcpDetail(toolName: string, args: Record<string, unknown>): string {
  if (!/create/i.test(toolName)) return `kanban_${toolName}(${JSON.stringify(args).slice(0, 800)})`;
  const title = typeof args.title === 'string' ? args.title : '';
  const desc = typeof args.description === 'string' ? args.description : '';
  const project = String(args.project_id ?? args.projectId ?? '');
  const preview = desc.length > 300 ? `${desc.slice(0, 300)}…` : desc;
  return [`标题：${title}`, project ? `项目：${project}` : '', preview ? `描述预览：\n${preview}` : '']
    .filter(Boolean)
    .join('\n');
}

const LOCAL_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'lark_cli',
      description:
        '执行本机 lark-cli 命令以获取/操作飞书内容（消息、群聊、文档、日历、任务、多维表格等）。' +
        '用于：读取群消息、读取文档正文、搜索聊天等。参数为命令行参数数组，例如 ["im","--help"]。' +
        '拿不准用法时先执行 ["--help"] 或 ["<skill>","--help"] 自发现，禁止臆造子命令。' +
        '只读命令直接执行；写命令（发消息、创建、修改、删除等）会触发用户确认闸门。',
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '传给 lark-cli 的参数数组',
          },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hk_cli',
      description:
        '执行 helios-kanban-remote 技能的 hk.sh（HTTP REST；MCP 不可用时的降级，或 MCP 缺能力时补充）。' +
        '例如 ["health"]、["projects"]、["projects","update",id,"--description","…"]、["tasks","create","标题"]、["start","<task_id>"]、["follow-up","<task_id>","继续…"]、["approvals"]。' +
        '详见 ["--help"]。默认会注入 HELIOS_KANBAN_* 环境变量。写操作会触发用户确认闸门。',
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: '传给 hk.sh 的参数数组',
          },
        },
        required: ['args'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_fs',
      description:
        '在 helios-kanban 关联仓库的本机 path 下只读浏览代码（list / read / grep）。' +
        '可选：偶尔查看本地文件。主路径是获取飞书内容 → 确认后写入 helios-kanban；是否 start 由用户决定。' +
        '必须提供 root（绝对路径）或 repo_id（会向 kanban API 解析 path）；path 为相对仓库根的路径。' +
        '禁止用于写文件或访问仓库外路径。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'grep'],
            description: 'list 列目录；read 读文件；grep 在目录内搜索正则',
          },
          repo_id: { type: 'string', description: 'kanban 仓库 UUID；与 root 二选一' },
          root: { type: 'string', description: '本机仓库绝对路径；与 repo_id 二选一' },
          path: {
            type: 'string',
            description: '相对仓库根的路径；list/grep 默认为 .；read 必填文件路径',
          },
          pattern: { type: 'string', description: 'grep 时的正则（忽略大小写）' },
          glob: {
            type: 'string',
            description: '可选文件过滤，如 *.ts 或 src/',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'work_summary',
      description:
        '生成工作总结报告（HTML/MD 文件），用于「这个迭代做了什么」「今天完成了什么」「总结一下进展」类请求。' +
        '数据来自 helios-kanban 任务及其 diff 统计（改动文件、增删行数、attempt 摘要）。只读，不写看板。',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: ['iteration', 'today', 'all'],
            description:
              '统计范围：iteration 按迭代（配置了默认迭代时为默认）、today 今天有更新的、all 全部任务',
          },
          iteration: { type: 'string', description: '可选；覆盖默认迭代号' },
          format: {
            type: 'string',
            enum: ['both', 'html', 'md'],
            description: '输出格式，默认 both',
          },
        },
      },
    },
  },
];

const MEMORY_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'memory_set',
      description:
        '持久化记住用户偏好（跨对话、重启仍有效）。用户说「以后都从…」「默认用…」时必须调用。' +
        '常用 key：feishu_task_source（飞书任务源 URL）、feishu_chat_id、preferred_project_id、preferred_repo_id、preferred_iteration。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '记忆键名，如 feishu_task_source' },
          value: { type: 'string', description: '要保存的值（URL、ID 等）' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_get',
      description:
        '读取持久化记忆。省略 key 则返回该用户全部 facts。用户说「同步我的任务」等时应先查 feishu_task_source。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '可选；指定则只返回该键' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: '删除一条记忆键（用户明确要求忘记某偏好时）。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '要删除的键名' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_note',
      description: '追加一条自由备注（非键值事实）。保留最近约 50 条。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '备注文本' },
        },
        required: ['text'],
      },
    },
  },
];

export function buildTools({
  mcp,
  kanbanUrl,
  kanbanProjectId,
  kanbanRepoId,
  kanbanIteration,
  memory,
  userId,
  onMemoryChange,
  confirm,
  registry,
  auditHome,
}: {
  mcp: KanbanMcp | null;
  kanbanUrl: string;
  kanbanProjectId?: string;
  kanbanRepoId?: string;
  kanbanIteration?: string;
  memory?: MemoryStore | null;
  userId?: string;
  /** Called after any successful memory write so session can refresh system prompt. */
  onMemoryChange?: () => void;
  /** Write gate: every write op waits for explicit user approval. Omit → writes blocked. */
  confirm?: ConfirmFn;
  /** Dedupe store for「飞书来源 → 看板任务」；defaults to <home>/synced-sources.json. */
  registry?: SourceRegistry;
  /** Override audit log home (tests). */
  auditHome?: string;
}): { openAiTools: OpenAiTool[]; handlers: ToolHandlers } {
  const openAiTools: OpenAiTool[] = [];
  const handlers: ToolHandlers = new Map();
  const uid = userId || 'local';
  const reg = registry || new SourceRegistry();
  let createCount = 0;

  /** Returns a block message if any source URL was already synced; cleans stale mappings. */
  const checkDuplicates = async (urls: string[]): Promise<string | null> => {
    for (const url of urls) {
      const hit = reg.lookup(uid, url);
      if (!hit) continue;
      const exists = hit.taskId === 'unknown' ? true : await kanbanTaskExists(kanbanUrl, hit.taskId);
      if (exists) {
        return (
          `该来源已同步过，为避免重复建任务已拦截：\n- 来源：${url}\n` +
          `- 已创建：${hit.createdAt} → 看板任务 ${hit.taskId}《${hit.title}》\n` +
          '如确需重建，请先在 kanban 中删除原任务（或告知用户该任务已存在）；\n' +
          '如用户是想把最新内容合并进原任务，改用 update 更新该任务，不要重建。'
        );
      }
      reg.remove(uid, url); // 原任务已被删除 → 清理映射后放行
    }
    return null;
  };

  const recordSources = (urls: string[], result: string, title: string): void => {
    if (!urls.length || looksLikeFailure(result)) return;
    const taskId = extractUuid(result);
    if (!taskId) return;
    const entry = { taskId, title, createdAt: new Date().toISOString() };
    for (const url of urls) reg.record(uid, url, entry);
  };

  if (mcp && mcp.connected) {
    for (const tool of mcp.tools) {
      const name = `kanban_${tool.name}`;
      openAiTools.push({
        type: 'function',
        function: {
          name,
          description: `[helios-kanban MCP] ${tool.description || tool.name}`,
          parameters: (tool.inputSchema as OpenAiTool['function']['parameters']) || {
            type: 'object',
            properties: {},
          },
        },
      });
      handlers.set(name, async (args, ctx) => {
        if (classifyMcp(tool.name) === 'read') {
          try {
            return await mcp.callTool(tool.name, args, ctx?.signal);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `MCP 工具 ${tool.name} 调用失败: ${message}`;
          }
        }
        // write path: dedupe → cap → gate → execute → audit (+record)
        const summary = summarizeMcp(tool.name, args);
        const detail = formatMcpDetail(tool.name, args);
        const isCreate = /create/i.test(tool.name);
        const isStart = /start_workspace/i.test(tool.name);
        const urls = isCreate ? extractSourceUrls(JSON.stringify(args)) : [];
        if (urls.length) {
          const dup = await checkDuplicates(urls);
          if (dup) {
            auditLog({ user: uid, kind: 'kanban', summary, detail, decision: 'blocked_dup' }, auditHome);
            return dup;
          }
        }
        if (isCreate && createCount >= MAX_CREATES_PER_SESSION) {
          auditLog({ user: uid, kind: 'kanban', summary, detail, decision: 'denied' }, auditHome);
          return CREATE_CAP_MESSAGE;
        }
        if (isStart) {
          const prepErr = await prepareMcpStartArgs(args, kanbanUrl, ctx?.signal);
          if (prepErr) {
            auditLog({ user: uid, kind: 'kanban', summary, detail, decision: 'error' }, auditHome);
            return prepErr;
          }
        }
        const gate = await passGate({ kind: 'kanban', summary, detail, batchKey: batchKeyForMcp(tool.name) }, confirm);
        if (!gate.allowed) {
          auditLog({ user: uid, kind: 'kanban', summary, detail, decision: gate.reason }, auditHome);
          return gate.message;
        }
        let result: string;
        try {
          result = await mcp.callTool(tool.name, args, ctx?.signal);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = `MCP 工具 ${tool.name} 调用失败: ${message}`;
        }
        if (isStart && !looksLikeFailure(result)) {
          result = await appendWorkspaceReadyCheck(result, kanbanUrl, ctx?.signal);
        }
        const ok = !looksLikeFailure(result) && !/⚠️ setup 未完成/.test(result);
        auditLog(
          { user: uid, kind: 'kanban', summary, detail, decision: 'approved', ok, resultSnippet: result },
          auditHome,
        );
        if (ok && urls.length) recordSources(urls, result, typeof args.title === 'string' ? args.title : '');
        if (ok && isCreate) createCount++;
        return result;
      });
    }
  }

  handlers.set('lark_cli', async (raw, ctx) => {
    const args = raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return '参数错误：args 必须是字符串数组';
    }
    const argv = args as string[];
    if (classifyLark(argv) === 'write') {
      const summary = `飞书写操作：lark-cli ${argv.slice(0, 3).join(' ')}`;
      const detail = `lark-cli ${argv.join(' ')}`.slice(0, 800);
      const gate = await passGate({ kind: 'lark', summary, detail }, confirm);
      if (!gate.allowed) {
        auditLog({ user: uid, kind: 'lark', summary, detail, decision: gate.reason }, auditHome);
        return gate.message;
      }
      const out = await run('lark-cli', argv, { signal: ctx?.signal });
      auditLog(
        { user: uid, kind: 'lark', summary, detail, decision: 'approved', ok: !looksLikeFailure(out), resultSnippet: out },
        auditHome,
      );
      return wrapUntrusted(out);
    }
    const out = await run('lark-cli', argv, { signal: ctx?.signal });
    return wrapUntrusted(out);
  });

  const hkEnv: NodeJS.ProcessEnv = { HELIOS_KANBAN_URL: kanbanUrl };
  if (kanbanProjectId) hkEnv.HELIOS_KANBAN_PROJECT_ID = kanbanProjectId;
  if (kanbanRepoId) hkEnv.HELIOS_KANBAN_REPO_ID = kanbanRepoId;
  if (kanbanIteration) hkEnv.HELIOS_KANBAN_ITERATION = kanbanIteration;

  handlers.set('hk_cli', async (raw, ctx) => {
    const args = raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return '参数错误：args 必须是字符串数组';
    }
    const argv = args as string[];
    if (classifyHk(argv) === 'read') {
      return run('bash', [HK_SCRIPT, ...argv], { env: hkEnv, signal: ctx?.signal });
    }
    const isCreate = argv[0] === 'create-and-start' || (argv[0] === 'tasks' && argv[1] === 'create');
    const isStart = argv[0] === 'start' || argv[0] === 'create-and-start';
    const title = isCreate ? hkCreateTitle(argv) : '';
    const summary = isCreate ? `创建看板任务「${title}」（hk_cli）` : `看板写操作：hk ${argv.slice(0, 3).join(' ')}`;
    const detail = `hk ${argv.join(' ')}`.slice(0, 800);
    const urls = isCreate ? extractSourceUrls(argv.join(' ')) : [];
    if (urls.length) {
      const dup = await checkDuplicates(urls);
      if (dup) {
        auditLog({ user: uid, kind: 'hk', summary, detail, decision: 'blocked_dup' }, auditHome);
        return dup;
      }
    }
    if (isCreate && createCount >= MAX_CREATES_PER_SESSION) {
      auditLog({ user: uid, kind: 'hk', summary, detail, decision: 'denied' }, auditHome);
      return CREATE_CAP_MESSAGE;
    }
    if (isStart && !hkStartHasBranch(argv)) {
      // Prefer env default repo's configured branch; otherwise require explicit --branch.
      const repoId = kanbanRepoId || '';
      if (repoId) {
        const defaults = await fetchRepoDefaultBranches(kanbanUrl, [repoId], ctx?.signal);
        const { unresolved } = applyRepoBaseBranches([{ repo_id: repoId }], defaults);
        if (unresolved.length) {
          auditLog({ user: uid, kind: 'hk', summary, detail, decision: 'error' }, auditHome);
          return formatMissingBaseBranchError(unresolved);
        }
        const branch = defaults[repoId];
        if (branch) argv.push('--branch', branch);
      } else {
        // Multi-repo or unspecified: hk.sh would fall back to main — block that.
        const hasRepo = argv.includes('--repo');
        if (!hasRepo) {
          auditLog({ user: uid, kind: 'hk', summary, detail, decision: 'error' }, auditHome);
          return (
            '无法启动 workspace：未指定 --branch / --repo ID:branch，且未配置 HELIOS_KANBAN_REPO_ID。\n' +
            '请显式传入目标分支（如 --branch hly-dev），避免静默回退到不存在的 main。'
          );
        }
      }
    }
    const gate = await passGate({ kind: 'hk', summary, detail, batchKey: batchKeyForHk(argv) }, confirm);
    if (!gate.allowed) {
      auditLog({ user: uid, kind: 'hk', summary, detail, decision: gate.reason }, auditHome);
      return gate.message;
    }
    let out = await run('bash', [HK_SCRIPT, ...argv], { env: hkEnv, signal: ctx?.signal });
    if (isStart && !looksLikeFailure(out)) {
      out = await appendWorkspaceReadyCheck(out, kanbanUrl, ctx?.signal);
    }
    const ok = !looksLikeFailure(out) && !/⚠️ setup 未完成/.test(out);
    auditLog({ user: uid, kind: 'hk', summary, detail, decision: 'approved', ok, resultSnippet: out }, auditHome);
    if (ok && urls.length) recordSources(urls, out, title);
    if (ok && isCreate) createCount++;
    return out;
  });

  handlers.set('repo_fs', async (raw) => {
    const action = typeof raw.action === 'string' ? raw.action : '';
    return runRepoFs(kanbanUrl, {
      action,
      root: typeof raw.root === 'string' ? raw.root : undefined,
      repo_id: typeof raw.repo_id === 'string' ? raw.repo_id : undefined,
      path: typeof raw.path === 'string' ? raw.path : undefined,
      pattern: typeof raw.pattern === 'string' ? raw.pattern : undefined,
      glob: typeof raw.glob === 'string' ? raw.glob : undefined,
    });
  });

  handlers.set('work_summary', async (raw) => {
    const iteration =
      (typeof raw.iteration === 'string' && raw.iteration.trim()) || kanbanIteration || '';
    const scopeArg = typeof raw.scope === 'string' ? raw.scope : '';
    let scope: WorkSummaryScope;
    if (scopeArg === 'iteration' || scopeArg === 'today' || scopeArg === 'all') scope = scopeArg;
    else scope = iteration ? 'iteration' : 'today';
    if (scope === 'iteration' && !iteration) scope = 'today';
    const format = raw.format === 'html' || raw.format === 'md' ? raw.format : 'both';
    try {
      const data = await collectWorkSummary({
        kanbanUrl,
        projectId: kanbanProjectId || undefined,
        iteration: iteration || undefined,
        scope,
      });
      const paths = writeSummaryReports(data, { format });
      const empty = data.tasks.length
        ? ''
        : '该范围内没有匹配的任务，已生成空报告（各项为 0）。\n\n';
      return empty + summarizeForChat(data, paths);
    } catch (err) {
      return (
        `生成工作总结失败: ${err instanceof Error ? err.message : String(err)}\n` +
        `请确认 kanban 服务可访问（${kanbanUrl}）后重试。`
      );
    }
  });

  if (memory) {
    handlers.set('memory_set', async (raw) => {
      const key = typeof raw.key === 'string' ? raw.key : '';
      const value = typeof raw.value === 'string' ? raw.value : '';
      if (!key.trim()) return '参数错误：key 不能为空';
      try {
        const user = memory.setFact(uid, key, value);
        onMemoryChange?.();
        return JSON.stringify({ ok: true, key: key.trim(), value, facts: user.facts });
      } catch (err) {
        return `memory_set 失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    });

    handlers.set('memory_get', async (raw) => {
      const key = typeof raw.key === 'string' ? raw.key.trim() : '';
      if (key) {
        const value = memory.getFact(uid, key);
        return value === undefined
          ? JSON.stringify({ key, value: null, found: false })
          : JSON.stringify({ key, value, found: true });
      }
      const user = memory.getUser(uid);
      return JSON.stringify({ facts: user.facts, notes: user.notes, updatedAt: user.updatedAt });
    });

    handlers.set('memory_delete', async (raw) => {
      const key = typeof raw.key === 'string' ? raw.key.trim() : '';
      if (!key) return '参数错误：key 不能为空';
      const ok = memory.deleteFact(uid, key);
      if (ok) onMemoryChange?.();
      return JSON.stringify({ ok, key });
    });

    handlers.set('memory_note', async (raw) => {
      const text = typeof raw.text === 'string' ? raw.text : '';
      try {
        const user = memory.addNote(uid, text);
        onMemoryChange?.();
        return JSON.stringify({ ok: true, notes: user.notes });
      } catch (err) {
        return `memory_note 失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    });

    openAiTools.push(...MEMORY_TOOLS);
  }

  openAiTools.push(...LOCAL_TOOLS);
  return { openAiTools, handlers };
}
