import path from 'path';
import { execFile } from 'child_process';
import type { KanbanMcp } from './mcp';
import type { MemoryStore } from './memory';
import type { OpenAiTool, ToolHandlers } from './types';

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

const LOCAL_TOOLS: OpenAiTool[] = [
  {
    type: 'function',
    function: {
      name: 'lark_cli',
      description:
        '执行本机 lark-cli 命令以获取/操作飞书内容（消息、群聊、文档、日历、任务、多维表格等）。' +
        '用于：读取群消息、读取文档正文、搜索聊天等。参数为命令行参数数组，例如 ["im","--help"]。' +
        '拿不准用法时先执行 ["--help"] 或 ["<skill>","--help"] 自发现，禁止臆造子命令。',
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
        '详见 ["--help"]。默认会注入 HELIOS_KANBAN_* 环境变量。',
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
}): { openAiTools: OpenAiTool[]; handlers: ToolHandlers } {
  const openAiTools: OpenAiTool[] = [];
  const handlers: ToolHandlers = new Map();
  const uid = userId || 'local';

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
        try {
          return await mcp.callTool(tool.name, args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return `MCP 工具 ${tool.name} 调用失败: ${message}`;
        }
      });
    }
  }

  handlers.set('lark_cli', async (raw) => {
    const args = raw.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return '参数错误：args 必须是字符串数组';
    }
    return run('lark-cli', args as string[]);
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
    return run('bash', [HK_SCRIPT, ...(args as string[])], { env: hkEnv });
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
