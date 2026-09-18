// 跨平台单测入口：顺序跑全部套件，任一失败最后统一报告并以非零码退出（语义同原 bash for-loop）。
// 替代 POSIX 脚本，Windows 无 bash 也能 npm test。Run: npm test
//
// 套件自动发现：scripts/ 下所有 unit*.ts 即套件（按文件名排序保证顺序稳定），
// 新增套件无需登记；run-tests / smoke / e2e-mock / testkit / verify 等辅助脚本不匹配该模式。

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { killProcessTree } from '../src/infra/proc';

const SUITES = fs
  .readdirSync(__dirname)
  .filter((f) => /^unit.*\.ts$/.test(f))
  .sort();

// tsx CLI 入口走 require.resolve：node_modules/.bin 在 Windows 上是 .cmd shim，
// 直接 spawn 需要 shell:true（有注入面）；用 process.execPath 跑 cli.mjs 则全平台一致。
const tsxCli = require.resolve('tsx/cli');

const TIMEOUT_MS = 10 * 60_000;

// 单套件挂死（如 mock server 永不退出）时兜底杀掉并计失败，避免 npm test 永久卡住。
// 不能用 spawnSync 的裸 timeout：它只杀直接子进程（tsx），测试内 spawn 的孙进程
// （慢命令、cli 子进程）会成孤儿占端口污染后续套件——须按进程树杀（infra/proc.killProcessTree）。
function runSuite(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, path.join(__dirname, file)], {
      stdio: 'inherit',
      // POSIX 下 detached 使子进程成为进程组组长，killProcessTree 才能整组杀；win32 走 taskkill /T
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n套件 ${file} 超过 ${TIMEOUT_MS / 60000} 分钟未退出，按进程树强杀`);
      if (child.pid !== undefined) killProcessTree(child.pid, 'SIGKILL');
    }, TIMEOUT_MS);
    // detached 后终端 Ctrl+C 不再自动传入子进程组，须显式转发杀树，否则用户中断会留套件孤儿
    const onSignal = (sig: NodeJS.Signals) => {
      if (child.pid !== undefined) killProcessTree(child.pid, sig);
      process.exit(128 + (sig === 'SIGINT' ? 2 : 15));
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const settle = (code: number) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      resolve(code);
    };
    child.on('error', () => settle(1));
    child.on('close', (code) => settle(timedOut ? 1 : (code ?? 1)));
  });
}

async function main(): Promise<void> {
  const failed: string[] = [];
  for (const suite of SUITES) {
    if ((await runSuite(suite)) !== 0) failed.push(suite.replace(/\.ts$/, ''));
  }

  if (failed.length > 0) {
    console.log('');
    console.log(`失败的测试套件： ${failed.join(' ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
