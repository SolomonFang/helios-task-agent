// 发布前全量验证：typecheck → 单测 → smoke → e2e → build → bin 接线 → dist 模块加载。
// Windows 上 npm 用 cmd.exe 跑 script，POSIX 内联环境变量语法（HTA_REQUIRE_E2E=1 npm run smoke）
// 直接报错；这里统一用 spawnSync 显式传 env，全平台一致。任一步失败即非零退出并指明步骤。
// Run: npm run verify

import { spawnSync } from 'child_process';
import path from 'path';

const root = path.join(__dirname, '..');
// tsx / tsc 均经 process.execPath 跑其 JS 入口：node_modules/.bin 在 Windows 上是 .cmd shim，
// 直接 spawn 需要 shell:true（有注入面）；此写法与 scripts/run-tests.ts 同一惯例
const tsxCli = require.resolve('tsx/cli');
const tscCli = require.resolve('typescript/lib/tsc.js');

interface Step {
  name: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

const REQUIRE_E2E: NodeJS.ProcessEnv = { HTA_REQUIRE_E2E: '1' };

const STEPS: Step[] = [
  { name: 'typecheck', args: [tscCli, '-p', 'tsconfig.typecheck.json'] },
  { name: '单元测试', args: [tsxCli, 'scripts/run-tests.ts'] },
  { name: 'smoke（HTA_REQUIRE_E2E=1）', args: [tsxCli, 'scripts/smoke.ts'], env: REQUIRE_E2E },
  { name: 'e2e-mock（HTA_REQUIRE_E2E=1）', args: [tsxCli, 'scripts/e2e-mock.ts'], env: REQUIRE_E2E },
  { name: 'build', args: [tscCli] },
  { name: 'bin --version 接线', args: ['bin/helios-task-agent.js', '--version'] },
  {
    name: 'dist 模块加载（cli/bot-main/index）',
    args: ['-e', "require('./dist/cli');require('./dist/bot-main');require('./dist/index')"],
  },
];

for (const step of STEPS) {
  console.log(`\n==> ${step.name}`);
  const r = spawnSync(process.execPath, step.args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...step.env },
  });
  if (r.status !== 0) {
    console.error(`\nverify 失败于步骤「${step.name}」（退出码 ${r.status ?? `信号 ${r.signal}`}），后续步骤未执行`);
    process.exit(1);
  }
}

console.log('\nverify 全部通过 ✓');
