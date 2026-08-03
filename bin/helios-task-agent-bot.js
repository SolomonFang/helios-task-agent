#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2).map((a) => a.toLowerCase());
const USAGE = `用法: helios-task-agent-bot [选项]

选项
  --rebind      换绑飞书机器人（只重跑飞书凭证，保留模型/看板配置）
  --version     打印版本号
  --help        显示本帮助`;

if (args.includes('version') || args.includes('-v') || args.includes('--version')) {
  console.log(require('../package.json').version);
  process.exit(0);
}
if (args.includes('help') || args.includes('-h') || args.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== 'rebind' && a !== '--rebind');
if (unknown.length) {
  console.error(`未知参数: ${unknown.join(' ')}\n\n${USAGE}`);
  process.exit(1);
}
require('../dist/bot').main();
