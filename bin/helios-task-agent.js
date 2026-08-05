#!/usr/bin/env node
'use strict';

/**
 * Unified CLI entry.
 *   helios-task-agent          → interactive terminal REPL
 *   helios-task-agent bot      → Feishu long-connection bot
 *   helios-task-agent --help / --version
 */
const args = process.argv.slice(2);
const cmd = (args[0] || '').toLowerCase();

function printHelp() {
  // 产品内文案全部为中文，--help 保持同一语气（命令名保留英文原文）
  console.log(`Helios Task Agent —— 从飞书内容到 helios-kanban 任务，一句话搞定

用法：
  helios-task-agent               启动终端交互 agent
  helios-task-agent bot           启动飞书私聊机器人（长连接）
  helios-task-agent bot --rebind  换绑飞书机器人（只重跑飞书凭证向导）
  helios-task-agent-bot           等同 helios-task-agent bot
  helios-task-agent help          显示本帮助
  helios-task-agent --version     显示版本号

配置：首次运行进入交互向导，写入 ~/.helios-task-agent/.env
  （可用 HELIOS_TASK_AGENT_HOME 覆盖目录）。LLM_* 必填；FEISHU_* 仅 bot 需要。
更新：启动时检查 npm 新版本并请示是否更新（HTA_UPDATE_CHECK=0 关闭）；
  手动更新：npm i -g helios-task-agent@latest
文档：见 README.md
`);
}

if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
  printHelp();
  process.exit(0);
}

if (cmd === 'version' || cmd === '-v' || cmd === '--version') {
  console.log(require('../package.json').version);
  process.exit(0);
}

if (cmd === 'bot') {
  require('../dist/bot').main();
} else if (cmd === 'cli' || cmd === 'start' || cmd === '') {
  require('../dist/cli').main();
} else {
  console.error(`未知命令: ${args[0]}`);
  printHelp();
  process.exit(1);
}
