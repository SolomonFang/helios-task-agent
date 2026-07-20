'use strict';

const path = require('path');
const { execFile } = require('child_process');

const HK_SCRIPT = path.join(__dirname, '..', 'skills', 'helios-kanban-remote', 'scripts', 'hk.sh');
const MAX_OUTPUT = 8000;
const EXEC_TIMEOUT = 60000;

function truncate(s) {
  const str = String(s);
  return str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + `\n…（输出过长，已截断，共 ${str.length} 字符）` : str;
}

function run(command, args, { env } = {}) {
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

const LOCAL_TOOLS = [
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
        '例如 ["health"]、["projects"]、["tasks","create","标题"]、["start","<task_id>"]、["follow-up","<task_id>","继续…"]、["approvals"]。' +
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

/**
 * Build the tool registry.
 * @param {object} deps
 * @param {import('./mcp').KanbanMcp|null} deps.mcp  connected MCP client or null
 * @param {string} deps.kanbanUrl
 * @param {string} [deps.kanbanProjectId]
 * @param {string} [deps.kanbanRepoId]
 * @param {string} [deps.kanbanIteration]
 * @returns {{ openAiTools: object[], handlers: Map<string, function> }}
 */
function buildTools({ mcp, kanbanUrl, kanbanProjectId, kanbanRepoId, kanbanIteration }) {
  const openAiTools = [];
  const handlers = new Map();

  // Bridge every MCP tool into an OpenAI function tool
  if (mcp && mcp.connected) {
    for (const tool of mcp.tools) {
      const name = `kanban_${tool.name}`;
      openAiTools.push({
        type: 'function',
        function: {
          name,
          description: `[helios-kanban MCP] ${tool.description || tool.name}`,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        },
      });
      handlers.set(name, async (args) => {
        try {
          return await mcp.callTool(tool.name, args);
        } catch (err) {
          return `MCP 工具 ${tool.name} 调用失败: ${err.message}`;
        }
      });
    }
  }

  handlers.set('lark_cli', async ({ args }) => {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return '参数错误：args 必须是字符串数组';
    }
    return run('lark-cli', args);
  });

  const hkEnv = { HELIOS_KANBAN_URL: kanbanUrl };
  if (kanbanProjectId) hkEnv.HELIOS_KANBAN_PROJECT_ID = kanbanProjectId;
  if (kanbanRepoId) hkEnv.HELIOS_KANBAN_REPO_ID = kanbanRepoId;
  if (kanbanIteration) hkEnv.HELIOS_KANBAN_ITERATION = kanbanIteration;

  handlers.set('hk_cli', async ({ args }) => {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
      return '参数错误：args 必须是字符串数组';
    }
    return run('bash', [HK_SCRIPT, ...args], { env: hkEnv });
  });

  openAiTools.push(...LOCAL_TOOLS);
  return { openAiTools, handlers };
}

module.exports = { buildTools };
