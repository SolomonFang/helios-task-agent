import path from 'path';
import { execFile } from 'child_process';
import type { KanbanMcp } from './mcp';
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

const HK_SCRIPT = path.join(__dirname, '..', 'skills', 'helios-kanban-remote', 'scripts', 'hk.sh');
const MAX_OUTPUT = 8000;
const EXEC_TIMEOUT = 60000;

function truncate(s: unknown): string {
  const str = String(s);
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + `\n…（输出过长，已截断，共 ${str.length} 字符）` : str;
}

function run(command: string, args: string[], { env }: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: EXEC_TIMEOUT, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
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
      description: '追加一条自由备注（非键值事实）。保留最近约 20 条。',
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
          '如确需重建，请先在 kanban 中删除原任务（或告知用户该任务已存在）。'
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
      handlers.set(name, async (args) => {
        if (classifyMcp(tool.name) === 'read') {
          try {
            return await mcp.callTool(tool.name, args);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `MCP 工具 ${tool.name} 调用失败: ${message}`;
          }
        }
        // write path: dedupe → gate → execute → audit (+record)
        const summary = summarizeMcp(tool.name, args);
        const detail = `kanban_${tool.name}(${JSON.stringify(args).slice(0, 800)})`;
        const isCreate = /create/i.test(tool.name);
        const urls = isCreate ? extractSourceUrls(JSON.stringify(args)) : [];
        if (urls.length) {
          const dup = await checkDuplicates(urls);
          if (dup) {
            auditLog({ user: uid, kind: 'kanban', summary, detail, decision: 'blocked_dup' }, auditHome);
            return dup;
          }
        }
        const gate = await passGate({ kind: 'kanban', summary, detail, batchKey: batchKeyForMcp(tool.name) }, confirm);
        if (!gate.allowed) {
          auditLog({ user: uid, kind: 'kanban', summary, detail, decision: gate.reason }, auditHome);
          return gate.message;
        }
        let result: string;
        try {
          result = await mcp.callTool(tool.name, args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = `MCP 工具 ${tool.name} 调用失败: ${message}`;
        }
        const ok = !looksLikeFailure(result);
        auditLog(
          { user: uid, kind: 'kanban', summary, detail, decision: 'approved', ok, resultSnippet: result },
          auditHome,
        );
        if (ok && urls.length) recordSources(urls, result, typeof args.title === 'string' ? args.title : '');
        return result;
      });
    }
  }

  handlers.set('lark_cli', async (raw) => {
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
      const out = await run('lark-cli', argv);
      auditLog(
        { user: uid, kind: 'lark', summary, detail, decision: 'approved', ok: !looksLikeFailure(out), resultSnippet: out },
        auditHome,
      );
      return wrapUntrusted(out);
    }
    const out = await run('lark-cli', argv);
    return wrapUntrusted(out);
  });

  const hkEnv: NodeJS.ProcessEnv = { HELIOS_KANBAN_URL: kanbanUrl };
  if (kanbanProjectId) hkEnv.HELIOS_KANBAN_PROJECT_ID = kanbanProjectId;
  if (kanbanRepoId) hkEnv.HELIOS_KANBAN_REPO_ID = kanbanRepoId;
  if (kanbanIteration) hkEnv.HELIOS_KANBAN_ITERATION = kanbanIteration;

  handlers.set('hk_cli', async (raw) => {
    const args = raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return '参数错误：args 必须是字符串数组';
    }
    const argv = args as string[];
    if (classifyHk(argv) === 'read') {
      return run('bash', [HK_SCRIPT, ...argv], { env: hkEnv });
    }
    const isCreate = argv[0] === 'create-and-start' || (argv[0] === 'tasks' && argv[1] === 'create');
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
    const gate = await passGate({ kind: 'hk', summary, detail, batchKey: batchKeyForHk(argv) }, confirm);
    if (!gate.allowed) {
      auditLog({ user: uid, kind: 'hk', summary, detail, decision: gate.reason }, auditHome);
      return gate.message;
    }
    const out = await run('bash', [HK_SCRIPT, ...argv], { env: hkEnv });
    const ok = !looksLikeFailure(out);
    auditLog({ user: uid, kind: 'hk', summary, detail, decision: 'approved', ok, resultSnippet: out }, auditHome);
    if (ok && urls.length) recordSources(urls, out, title);
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
