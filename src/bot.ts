/**
 * Feishu bot entry (Hermes-style): run → wizard if needed → long-connection DM.
 *
 *   helios-task-agent bot
 *   helios-task-agent-bot
 */

import readline from 'readline';
import { currentConfig, ensureBotConfig, feishuBotConfig, userEnvPath } from './config';
import { KanbanMcp } from './mcp';
import { MemoryStore } from './memory';
import { FeishuChannel, type FeishuInboundMessage } from './channels/feishu';
import { SessionRouter } from './session-router';
import { ensureKanbanRunning, stopKanbanChild } from './kanban-ensure';
import type { AskFn, InboundMessage } from './types';
import type { ChildProcess } from 'child_process';
import { c } from './ui';

const BOT_HELP = `Helios Task Agent（飞书私聊）

命令
/help     显示帮助
/memory   查看你的持久化记忆
/clear    清空本对话历史（不清记忆）

可以说
· 以后都从这个飞书地址同步任务：<链接>
· 同步/列出我的任务（含链接会展开详情）
· 写进 helios-kanban（确认后再创建，不自动启动）
· 有哪些项目 / 创建一个任务：…
· 用 Claude 跑这个任务（是否启用、用谁跑由你决定）`;

function isCommand(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  return t.split(/\s+/)[0]!.toLowerCase();
}

function createAsk(): { ask: AskFn; close: () => void } {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  const ask: AskFn = (promptText) =>
    new Promise((resolve) => {
      rl.question(promptText, (ans) => resolve(ans));
      rl.once('close', () => resolve(null));
    });
  return {
    ask,
    close: () => rl.close(),
  };
}

async function main(): Promise<void> {
  console.log(c.strong('Helios Task Agent — 飞书机器人'));
  console.log(c.gray(`配置目录: ${userEnvPath()}`));

  const { ask, close } = createAsk();
  let agentCfg;
  let feishuCfg;
  try {
    const ready = await ensureBotConfig(ask, { force: false });
    agentCfg = ready.agent;
    feishuCfg = ready.feishu;
    console.log(c.gray(`已加载配置: ${ready.envPath}`));
  } catch (err) {
    close();
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`配置失败: ${message}`));
    process.exit(1);
  }
  close();

  // Refresh from env after wizard
  agentCfg = currentConfig();
  feishuCfg = feishuBotConfig();

  console.log(c.gray(`模型: ${agentCfg.llmModel}  kanban: ${agentCfg.kanbanUrl}`));
  if (feishuCfg.allowedOpenIds.length) {
    console.log(c.gray(`允许 open_id: ${feishuCfg.allowedOpenIds.join(', ')}`));
  } else {
    console.log(c.warn('未设置 FEISHU_ALLOWED_OPEN_IDS：所有私聊用户均可对话'));
  }

  let kanbanChild: ChildProcess | null = null;
  try {
    const ensured = await ensureKanbanRunning(agentCfg.kanbanUrl, {
      onLog: (msg) => console.log(c.gray(msg)),
    });
    kanbanChild = ensured.child;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`看板启动失败: ${message}`));
    console.error(c.gray('可手动执行: HOST=0.0.0.0 PORT=7964 npx -y helios-kanban'));
    console.error(c.gray('或设置 HELIOS_KANBAN_AUTO_START=0 并自行保证服务已运行。'));
    process.exit(1);
  }

  const bootLabel = '正在连接 helios-kanban MCP…';
  process.stdout.write(c.gray(bootLabel));
  const mcp = new KanbanMcp({ command: agentCfg.mcpCommand, args: agentCfg.mcpArgs });
  let mcpOk = true;
  try {
    await mcp.connect({ timeoutMs: 45000 });
    process.stdout.write(c.ok(`\rMCP 已连接（${mcp.tools.length} 个工具）          \n`));
  } catch (err) {
    mcpOk = false;
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(c.warn(`\rMCP 连接失败，降级 hk_cli：${message}\n`));
  }

  const memory = new MemoryStore();
  const router = new SessionRouter(agentCfg, mcpOk ? mcp : null, mcpOk, memory);
  const channel = new FeishuChannel(feishuCfg);

  const handle = async (msg: InboundMessage) => {
    const fmsg = msg as FeishuInboundMessage;

    if (fmsg.messageType && fmsg.messageType !== 'text') {
      await channel.reply(msg, '暂只支持文字消息。');
      return;
    }

    const text = (msg.text || '').trim();
    if (!text) {
      await channel.reply(msg, '请发送文字内容。');
      return;
    }

    const cmd = isCommand(text);
    if (cmd === '/help') {
      await channel.reply(msg, BOT_HELP);
      return;
    }

    const openId = msg.senderId;
    await router.enqueue(openId, async () => {
      const session = router.getOrCreate(openId);

      if (cmd === '/memory') {
        await channel.reply(msg, `你的记忆（open_id=${openId}）\n${session.formatMemory()}`);
        return;
      }
      if (cmd === '/clear') {
        session.clearHistory();
        await channel.reply(msg, '对话历史已清空（记忆保留）。');
        return;
      }
      if (cmd) {
        await channel.reply(msg, `未知命令 ${cmd}，发送 /help 查看帮助。`);
        return;
      }

      await channel.reply(msg, '收到，处理中…');
      try {
        const reply = await session.handleUserMessage(text);
        await channel.reply(msg, reply || '(无回复)');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await channel.reply(msg, `请求失败: ${message}\n请检查模型配置或稍后重试。`);
      }
    });
  };

  const shutdown = async () => {
    console.log('\n' + c.gray('正在退出…'));
    await channel.stop();
    await mcp.close();
    await stopKanbanChild(kanbanChild);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  console.log(c.ok('正在建立飞书长连接…'));
  try {
    await channel.start(handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(c.err(`\n长连接失败: ${message}`));
    console.error(c.gray('请确认：开放平台事件订阅已选「长连接」、已添加 im.message.receive_v1、App 已发布/可用。'));
    console.error(c.gray('改凭证可再运行一次 helios-task-agent bot（会进入向导），或编辑 ' + userEnvPath()));
    await mcp.close();
    await stopKanbanChild(kanbanChild);
    process.exit(1);
  }
  console.log(c.ok('长连接已就绪。手机飞书搜索机器人 → 私聊即可。'));
  console.log(c.gray('Ctrl+C 退出'));
}

export { main };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
