// 跨平台单测入口：顺序跑全部套件，任一失败最后统一报告并以非零码退出（语义同原 bash for-loop）。
// 替代 POSIX 脚本，Windows 无 bash 也能 npm test。Run: npm test

import { spawnSync } from 'child_process';
import path from 'path';

const SUITES = [
  'unit',
  'unit-safety',
  'unit-kanban',
  'unit-resilience',
  'unit-bot',
  'unit-handler',
  'unit-coverage',
  'unit-feishu-filter',
  'unit-daily-brief',
  'unit-weekly-brief',
  'unit-session-store',
  'unit-repo-fs',
  'unit-tools',
  'unit-stale-diagnosis',
  'unit-reports',
  'unit-reminder',
];

// tsx CLI 入口走 require.resolve：node_modules/.bin 在 Windows 上是 .cmd shim，
// 直接 spawn 需要 shell:true（有注入面）；用 process.execPath 跑 cli.mjs 则全平台一致。
const tsxCli = require.resolve('tsx/cli');

const failed: string[] = [];
for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [tsxCli, path.join(__dirname, `${suite}.ts`)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(suite);
}

if (failed.length > 0) {
  console.log('');
  console.log(`失败的测试套件： ${failed.join(' ')}`);
  process.exit(1);
}
