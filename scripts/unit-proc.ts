import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileCompat, killProcessTree, type ExecFileCompatError } from '../src/infra/proc';
import { checkAsync, finish } from './testkit';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`);
    await sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await checkAsync('proc：execFileCompat 正常命令保留 stdout 与回调错误形状', async () => {
    const result = await new Promise<{ error: ExecFileCompatError | null; stdout: string; stderr: string }>((resolve) => {
      execFileCompat(process.execPath, ['-e', "process.stdout.write('ok')"], { timeout: 1000 }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
    assert.equal(result.error, null);
    assert.equal(result.stdout, 'ok');
    assert.equal(result.stderr, '');
  });

  if (process.platform !== 'win32') {
    await checkAsync('proc：timeout/abort/maxBuffer 杀 POSIX 进程树并统一升级 SIGKILL', async () => {
      for (const mode of ['timeout', 'abort', 'maxBuffer'] as const) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `hta-unit-proc-${mode}-`));
        const pidFile = path.join(tmp, 'grandchild.pid');
        const controller = new AbortController();
        let rootPid: number | undefined;
        let grandchildPid = 0;
        let callbacks = 0;
        try {
          const rootScript = [
            "const { spawn } = require('child_process');",
            "const fs = require('fs');",
            "process.on('SIGTERM', () => {});",
            "const gc = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'inherit', 'inherit'] });",
            'fs.writeFileSync(process.argv[1], String(gc.pid));',
            "if (process.argv[2] === 'maxBuffer') process.stdout.write('x'.repeat(128));",
            'setInterval(() => {}, 1000);',
          ].join('\n');
          type Result = { error: ExecFileCompatError | null; stdout: string; stderr: string };
          let resolveDone!: (result: Result) => void;
          const done = new Promise<Result>((resolve) => (resolveDone = resolve));
          const startedAt = Date.now();
          const child = execFileCompat(
            process.execPath,
            ['-e', rootScript, pidFile, mode],
            {
              timeout: mode === 'timeout' ? 100 : 10_000,
              maxBuffer: mode === 'maxBuffer' ? 16 : 1024,
              ...(mode === 'abort' ? { signal: controller.signal } : {}),
            },
            (error, stdout, stderr) => {
              callbacks++;
              resolveDone({ error, stdout, stderr });
            },
          );
          rootPid = child.pid;
          assert.ok(rootPid, `${mode}：根进程应已启动`);
          if (mode === 'abort') {
            await waitFor(() => fs.existsSync(pidFile), '孙进程 pid 落盘后再中断');
            controller.abort();
          }
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              done,
              new Promise<never>((_, reject) => {
                watchdog = setTimeout(() => reject(new Error(`${mode}：5 秒内未回调，pipes 可能仍被孙进程持有`)), 5000);
              }),
            ]);
            const elapsed = Date.now() - startedAt;
            assert.ok(elapsed >= 1800, `${mode}：忽略 SIGTERM 后应经过统一 2 秒升级窗口，实际 ${elapsed}ms`);
            assert.ok(elapsed < 5000, `${mode}：强杀后应及时 close，实际 ${elapsed}ms`);
            assert.ok(result.error, `${mode}：应返回错误`);
            assert.equal(result.error!.killed, true, `${mode}：错误应保留 killed 标记`);
            if (mode === 'timeout') {
              assert.match(result.error!.message, /timed out/);
              assert.equal(result.error!.bufferExceeded, undefined);
            } else if (mode === 'abort') {
              assert.equal(result.error!.name, 'AbortError');
              assert.equal(result.error!.code, 'ABORT_ERR');
            } else {
              assert.equal(result.error!.bufferExceeded, 'stdout');
              assert.ok(result.stdout.length > 16, 'maxBuffer 错误应带回已收集 stdout');
            }
          } finally {
            if (watchdog) clearTimeout(watchdog);
          }
          grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
          assert.ok(grandchildPid > 0, `${mode}：真实孙进程应已启动`);
          await waitFor(() => !alive(grandchildPid), `${mode}：孙进程被进程组强杀`);
          await sleep(30);
          assert.equal(callbacks, 1, `${mode}：回调只能一次`);
        } finally {
          if (rootPid !== undefined) killProcessTree(rootPid, 'SIGKILL');
          if (grandchildPid > 0 && alive(grandchildPid)) {
            try {
              process.kill(grandchildPid, 'SIGKILL');
            } catch {
              // 已退出
            }
          }
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
    });
  }
}

main().then(finish).catch((err) => {
  console.error(err);
  process.exit(1);
});
