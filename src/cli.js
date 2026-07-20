'use strict';

const readline = require('readline');
const { execFileSync } = require('child_process');

const { c, printBanner, Spinner, renderReply } = require('./ui');
const { ensureConfig } = require('./config');
const { KanbanMcp } = require('./mcp');
const { buildTools } = require('./tools');
const { buildSystemPrompt } = require('./prompt');
const { createClient, runAgentTurn } = require('./llm');
const pkg = require('../package.json');

function checkLarkCli() {
  try {
    execFileSync('lark-cli', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Single 'line'-event-driven reader shared by the wizard and the REPL.
 * Returns nextLine(): Promise<string|null> (null on stdin EOF).
 */
function createLineReader(rl) {
  const queue = [];
  let waiter = null;
  let closed = false;
  rl.on('line', (line) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(line);
    } else {
      queue.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(null);
    }
  });
  return () =>
    new Promise((resolve) => {
      if (queue.length) return resolve(queue.shift());
      if (closed) return resolve(null);
      waiter = resolve;
    });
}

const HELP = `
  ${c.strong('命令')}
  ${c.info('/help')}     显示帮助
  ${c.info('/config')}   重新配置模型 / kanban 地址
  ${c.info('/tools')}    列出当前可用的 kanban 工具
  ${c.info('/clear')}    清空对话历史
  ${c.info('/exit')}     退出

  ${c.strong('试试对我说')}
  · 有哪些项目 / 看看进行中的任务
  · 创建一个任务：修复登录页样式 bug
  · 把 xx 群最近的聊天记录整理成任务
  · 读一下这篇飞书文档 <链接>，提炼成开发任务
`;

async function main() {
  const isTTY = process.stdin.isTTY === true;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
  });
  const nextLine = createLineReader(rl);
  const ask = (promptText) => {
    process.stdout.write(promptText);
    return nextLine();
  };

  let cfg;
  try {
    cfg = await ensureConfig(ask);
  } catch (err) {
    console.error(c.err(`\n配置失败: ${err.message}`));
    rl.close();
    process.exit(1);
  }

  // Connect helios-kanban MCP (with loading)
  const boot = new Spinner('正在连接 helios-kanban MCP…').start();
  const mcp = new KanbanMcp({ command: cfg.mcpCommand, args: cfg.mcpArgs });
  let mcpOk = true;
  try {
    await mcp.connect({ timeoutMs: 45000 });
  } catch (err) {
    mcpOk = false;
    if (process.env.HTA_DEBUG) console.error(`\n[mcp] ${err.stack || err.message}`);
  }
  boot.stop();

  const larkOk = checkLarkCli();

  printBanner({
    version: pkg.version,
    model: cfg.llmModel,
    baseUrl: cfg.llmBaseUrl,
    kanbanUrl: cfg.kanbanUrl,
    mcp: mcpOk ? 'ok' : 'fail',
    mcpToolCount: mcpOk ? mcp.tools.length : 0,
    larkOk,
  });

  const { openAiTools, handlers } = buildTools({ mcp: mcpOk ? mcp : null, kanbanUrl: cfg.kanbanUrl });
  const client = createClient(cfg);
  const spinner = new Spinner('思考中…');

  let messages = [
    {
      role: 'system',
      content: buildSystemPrompt({
        mcpOk,
        mcpToolNames: mcpOk ? mcp.tools.map((t) => t.name) : [],
        kanbanUrl: cfg.kanbanUrl,
        projectId: cfg.kanbanProjectId || undefined,
      }),
    },
  ];

  const cleanup = async () => {
    spinner.stop();
    await mcp.close();
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', () => {
    console.log('\n' + c.gray('再见 👋'));
    cleanup();
  });

  for (;;) {
    const input = await ask(c.info('› '));
    if (input === null) await cleanup(); // stdin EOF
    const line = input.trim();
    if (!line) continue;

    if (line.startsWith('/')) {
      const cmd = line.toLowerCase();
      if (cmd === '/exit' || cmd === '/quit') {
        console.log(c.gray('再见 👋'));
        await cleanup();
      } else if (cmd === '/help') {
        console.log(HELP);
      } else if (cmd === '/clear') {
        messages = messages.slice(0, 1);
        console.log(c.gray('对话历史已清空。'));
      } else if (cmd === '/tools') {
        if (!mcpOk) {
          console.log(c.warn('MCP 未连接（降级模式），仅有 lark_cli / hk_cli 两个工具。'));
        } else {
          console.log(c.strong('kanban MCP 工具:'));
          for (const t of mcp.tools) console.log(`  ${c.info('kanban_' + t.name)}  ${c.gray((t.description || '').split('\n')[0])}`);
          console.log(c.strong('本地工具:'));
          for (const t of ['lark_cli', 'hk_cli']) console.log(`  ${c.info(t)}`);
        }
      } else if (cmd === '/config') {
        try {
          cfg = await ensureConfig(ask, { force: true });
          messages[0].content = buildSystemPrompt({
            mcpOk,
            mcpToolNames: mcpOk ? mcp.tools.map((t) => t.name) : [],
            kanbanUrl: cfg.kanbanUrl,
            projectId: cfg.kanbanProjectId || undefined,
          });
          console.log(c.ok('配置已更新，模型切换为 ') + c.strong(cfg.llmModel));
        } catch (err) {
          console.error(c.err(`配置失败: ${err.message}`));
        }
      } else {
        console.log(c.warn(`未知命令 ${line}，输入 /help 查看帮助。`));
      }
      continue;
    }

    messages.push({ role: 'user', content: line });
    spinner.start('思考中…');
    try {
      const reply = await runAgentTurn({
        client,
        model: cfg.llmModel,
        messages,
        tools: openAiTools,
        handlers,
        onProgress: (info) => {
          if (info.type === 'tool') spinner.setText(`调用工具 ${info.name} …`);
          else spinner.setText('思考中…');
        },
      });
      spinner.stop();
      console.log('\n' + renderReply(reply) + '\n');
    } catch (err) {
      spinner.stop();
      console.error(c.err(`\n请求失败: ${err.message}`));
      console.error(c.gray('可用 /config 检查模型配置，或稍后重试。\n'));
      // drop the failed user message so history stays consistent
      if (messages[messages.length - 1] && messages[messages.length - 1].role === 'user') messages.pop();
    }
  }
}

module.exports = { main };
