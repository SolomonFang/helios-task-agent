#!/usr/bin/env node
'use strict';

/**
 * Standalone Feishu bot entry（等同 helios-task-agent bot）。
 * 只做分发：argv 原样透传给 bot-main 的 main()，参数解析 / 校验 / --help 文案
 * 以 bot-main.ts 的 parseBotArgs 为唯一来源（此处不再重复一份）。
 */
// package.json engines 声明 node>=20：低于 20 直接报错退出，不在旧运行时上跑出莫名错误
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 20) {
  console.error(`helios-task-agent 需要 Node.js 20 或更高版本（当前 ${process.version}），请升级后重试。`);
  process.exit(1);
}

// main() 是 async：顶层 reject 必须显式捕获，否则 unhandledRejection 打崩溃栈
require('../dist/bot-main').main().catch((err) => {
  console.error(err);
  process.exit(1);
});
