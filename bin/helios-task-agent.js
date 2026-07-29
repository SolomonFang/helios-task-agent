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
  console.log(`Helios Task Agent

Usage:
  helios-task-agent           Start interactive terminal agent
  helios-task-agent bot       Start Feishu DM bot (long connection)
  helios-task-agent-bot       Same as "helios-task-agent bot"
  helios-task-agent help      Show this help
  helios-task-agent --version Show installed version

Config: first run opens an interactive wizard that writes to
  ~/.helios-task-agent/.env (override with HELIOS_TASK_AGENT_HOME).
  LLM_* required; FEISHU_* for bot.
Update: startup checks npm for new versions and offers to update
  (disable with HTA_UPDATE_CHECK=0); manual: npm i -g helios-task-agent@latest
Docs: see README.md
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
  console.error(`Unknown command: ${args[0]}`);
  printHelp();
  process.exit(1);
}
