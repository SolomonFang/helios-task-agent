/**
 * 跨平台子进程兼容层。
 *
 * 为什么存在：Windows 上 Node 原生的 execFile/spawn 不带 shell 无法启动 .cmd 壳
 * （npx / npm / lark-cli / ocr 都是 npm 全局 bin 的 .cmd shim），直接报 ENOENT。
 * cross-spawn 在 win32 下自动改走 cmd.exe 并正确转义参数，命令不存在时仍会
 * 模拟出 ENOENT 的 'error' 事件；POSIX 下行为与原生一致。
 *
 * 但 cross-spawn 只解决「起进程」，execFile/execFileSync 的上层语义（回调错误
 * 形状、timeout 杀进程、maxBuffer 截断、AbortSignal 中断）需要在这里补齐到与
 * Node 原生一致，调用方才能无差别替换。错误形状刻意对齐原生 execFile：
 * - 命令不存在 → error.code === 'ENOENT'，stdout 为空；
 * - 非零退出 → error.code 为退出码（数字），stdout/stderr 照常带回；
 * - timeout 触发 → error.killed === true、error.signal === 'SIGTERM'（调用方据此判超时）；
 * - AbortSignal 触发 → 杀子进程并回调 AbortError（调用方自行查 signal.aborted）。
 */

import { spawnSync, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'child_process';
import crossSpawn from 'cross-spawn';

/** 对齐 Node 原生 execFile 回调错误对象的字段（调用方按 code/killed/signal 分支）。 */
export interface ExecFileCompatError extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

export type ExecFileCompatCallback = (error: ExecFileCompatError | null, stdout: string, stderr: string) => void;

/**
 * execFile 的 drop-in 替代：实现于 cross-spawn 之上，win32 可启动 .cmd shim。
 * 任何失败（含 spawn 期错误）都只经回调返回一次，绝不同步抛、绝不重复回调。
 */
export function execFileCompat(
  cmd: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCompatCallback,
): ChildProcess {
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const killSignal = (options.killSignal ?? 'SIGTERM') as NodeJS.Signals;
  const cmdline = [cmd, ...args].join(' ');
  let stdout = '';
  let stderr = '';
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let bufferExceeded: 'stdout' | 'stderr' | null = null;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  };
  const done = (error: ExecFileCompatError | null) => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) {
      // 与原生一致：错误对象上同时带 stdout/stderr（ai-review 等调用方取错误里的输出）
      error.stdout = stdout;
      error.stderr = stderr;
    }
    callback(error, stdout, stderr);
  };

  let child: ChildProcess;
  try {
    child = crossSpawn(cmd, args as string[], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      windowsHide: true,
    });
  } catch (err) {
    // cross-spawn 起进程失败正常走 'error' 事件；此分支是兜底，保证语义不变成同步抛
    process.nextTick(() => done(err as ExecFileCompatError));
    return undefined as unknown as ChildProcess;
  }

  const timer =
    options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill(killSignal);
        }, options.timeout)
      : null;

  const onAbort = () => {
    aborted = true;
    child.kill(killSignal);
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    if (!bufferExceeded && stdout.length > maxBuffer) {
      bufferExceeded = 'stdout';
      child.kill(killSignal);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    if (!bufferExceeded && stderr.length > maxBuffer) {
      bufferExceeded = 'stderr';
      child.kill(killSignal);
    }
  });

  // cross-spawn 在 win32 下会把 cmd.exe 的「不是内部或外部命令」识别回 ENOENT，
  // 与 POSIX 原生 spawn 的 ENOENT 同形，调用方一套分支即可
  child.on('error', (err: ExecFileCompatError) => {
    done(err);
  });

  // 用 'close' 而非 'exit'：stdio 全部冲刷完再回调，保证 stdout/stderr 收集完整
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (aborted) {
      // 对齐原生 AbortError：调用方在回调里自查 signal.aborted（shared.ts 即如此）
      const err = new Error('The operation was aborted') as ExecFileCompatError;
      err.name = 'AbortError';
      err.code = 'ABORT_ERR';
      err.killed = true;
      err.signal = signal ?? killSignal;
      done(err);
      return;
    }
    if (timedOut) {
      const err = new Error(`Command timed out after ${options.timeout}ms: ${cmdline}`) as ExecFileCompatError;
      err.killed = true;
      err.signal = signal ?? killSignal;
      err.code = code;
      done(err);
      return;
    }
    if (bufferExceeded) {
      const err = new Error(`${bufferExceeded} maxBuffer length exceeded`) as ExecFileCompatError;
      err.killed = true;
      err.signal = signal ?? killSignal;
      done(err);
      return;
    }
    if (code !== 0) {
      // 非零退出 / 信号退出：错误信息对齐原生格式（Command failed: ... + stderr 尾部）
      const err = new Error(
        `Command failed: ${cmdline}${stderr ? `\n${stderr}` : ''}`,
      ) as ExecFileCompatError;
      err.code = code;
      err.signal = signal;
      done(err);
      return;
    }
    done(null);
  });

  return child;
}

/**
 * execFileSync 的 drop-in 替代（cross-spawn.sync）：exit 0 返回 stdout 字符串，
 * 否则抛错——含命令不存在（error.code === 'ENOENT'）与非零退出（error.status/error.code）。
 */
export function execFileSyncCompat(
  cmd: string,
  args: readonly string[],
  options: {
    timeout?: number;
    encoding?: 'utf8';
    stdio?: SpawnOptions['stdio'];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    maxBuffer?: number;
  } = {},
): string {
  const res = crossSpawn.sync(cmd, args as string[], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    maxBuffer: options.maxBuffer,
    encoding: 'utf8',
    windowsHide: true,
  });
  // spawn 期错误（ENOENT 等）：原样抛出，code 字段与原生 execFileSync 一致
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const err = new Error(`Command failed: ${[cmd, ...args].join(' ')}`) as Error & {
      status?: number | null;
      code?: number | null;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
    };
    err.status = res.status;
    err.code = res.status;
    err.signal = res.signal;
    err.stdout = typeof res.stdout === 'string' ? res.stdout : '';
    err.stderr = typeof res.stderr === 'string' ? res.stderr : '';
    throw err;
  }
  return typeof res.stdout === 'string' ? res.stdout : '';
}

/**
 * spawn 的 drop-in 替代：cross-spawn 与 child_process.spawn 同签名同行为
 * （POSIX 下即原生 spawn；win32 下可启动 .cmd shim），此处仅做类型对齐的再导出。
 */
export const spawnCompat: typeof import('child_process').spawn = crossSpawn as unknown as typeof import('child_process').spawn;

/**
 * 杀整棵进程树（kanban/MCP 的子进程是 npx 壳，真正的服务是孙进程，只杀壳会留孤儿）。
 * POSIX：按进程组发信号（spawn 时 detached:true），组杀失败回退只杀根进程；
 * win32：无进程组信号语义，taskkill /T 杀整棵树、/F 强制（不区分 SIGTERM/SIGKILL，失败忽略）。
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 已退出 */
    }
  }
}

/**
 * 进程树是否还有存活成员（npx 壳退出后，被 reparent 的孙进程仍在进程组里）。
 * POSIX 探进程组（kill 信号 0 只探活不真杀）；win32 无进程组，退化为探根进程。
 */
export function processTreeAlive(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      process.kill(pid, 0);
    } else {
      process.kill(-pid, 0);
    }
    return true;
  } catch {
    return false;
  }
}
