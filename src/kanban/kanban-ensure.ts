import { spawn, type ChildProcess } from 'child_process';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { kanbanPackageSpec } from '../deps';
import { minimalChildEnv } from '../proc-env';

export interface KanbanEnsureResult {
  /** True if we spawned a new process. */
  started: boolean;
  /** Child we own (kill on shutdown). */
  child: ChildProcess | null;
  url: string;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
}

/** 导出以便单测直接验证健康判定（单测起本地 HTTP server 模拟各类占用者）。 */
export async function fetchHealth(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  const root = baseUrl.replace(/\/$/, '');
  const paths = ['/api/health', '/health'];
  for (const p of paths) {
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      try {
        const u = new URL(root + p);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(u, { timeout: timeoutMs }, (res) => {
          // 仅 2xx 且响应体是 kanban API 信封（"success":true）才算健康：
          // 任意占用端口的 HTTP 服务（含对这些路径回 404/HTML 的）不得误判为「看板已在运行」
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            done(false);
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (body.length < 8192) body += chunk;
          });
          res.on('end', () => done(body.includes('"success":true')));
          res.on('error', () => done(false));
        });
        req.on('error', () => done(false));
        req.on('timeout', () => {
          req.destroy();
          done(false);
        });
      } catch {
        done(false);
      }
    });
    if (ok) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * If kanban HTTP is down and URL is local, spawn `npx -y helios-kanban` and wait for health.
 * Set HELIOS_KANBAN_AUTO_START=0 to disable.
 */
export async function ensureKanbanRunning(
  kanbanUrl: string,
  {
    autoStart = process.env.HELIOS_KANBAN_AUTO_START !== '0',
    waitMs = 90000,
    onLog,
    onSpawn,
  }: {
    autoStart?: boolean;
    waitMs?: number;
    onLog?: (msg: string) => void;
    /** 子进程一拉起即回调（就绪前收到退出信号时，调用方需要拿到 child 才能清理）。 */
    onSpawn?: (child: ChildProcess) => void;
  } = {},
): Promise<KanbanEnsureResult> {
  const url = kanbanUrl || 'http://localhost:7964';
  const log = onLog || (() => {});

  if (await fetchHealth(url)) {
    log('helios-kanban 已在运行');
    return { started: false, child: null, url };
  }

  let hostname = 'localhost';
  let port = '7964';
  try {
    const u = new URL(url);
    hostname = u.hostname;
    port = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (!u.port && (hostname === 'localhost' || hostname === '127.0.0.1')) port = '7964';
  } catch {
    /* keep defaults */
  }

  if (!autoStart) {
    throw new Error(`helios-kanban 未运行（${url}），且已禁用自动启动（HELIOS_KANBAN_AUTO_START=0）`);
  }
  if (!isLocalHost(hostname)) {
    throw new Error(`helios-kanban 未运行（${url}）。非本机地址不会自动启动，请先手动拉起看板服务。`);
  }

  log(`未检测到看板，正在启动 npx ${kanbanPackageSpec()}（PORT=${port}）…`);
  const child = spawn('npx', ['-y', kanbanPackageSpec()], {
    // 最小环境（见 proc-env.ts）：npx 只需 PATH/HOME 与代理/registry，不继承敏感变量
    env: minimalChildEnv({
      // 默认只监听回环：看板 Web/API 无鉴权，绑定 0.0.0.0 会暴露到局域网
      HOST: process.env.HELIOS_KANBAN_HOST || '127.0.0.1',
      PORT: port,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    // 自成进程组：stopKanbanChild 按组杀，npx 拉起的看板孙进程（真正的监听者）才能一并退出
    detached: true,
  });
  onSpawn?.(child);

  let stderrBuf = '';
  // spawn 失败（如 npx 不存在）时 'error' 事件没有监听者会直接抛未捕获异常使进程崩溃；
  // 且此时 exitCode 恒为 null，仅靠轮询 exitCode 会白等满 waitMs。记录后在循环里快速失败。
  // 用对象持有避免 TS 把闭包内赋值的变量窄化为 null。
  const spawnFailure: { err: Error | null } = { err: null };
  child.on('error', (err) => {
    spawnFailure.err = err;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    // 环形截断只留尾部（64KB）：等待窗口内子进程可能持续刷 stderr，无界累积会撑爆内存
    stderrBuf = (stderrBuf + chunk.toString()).slice(-65536);
    if (process.env.HTA_DEBUG) process.stderr.write(`[kanban] ${chunk}`);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    if (process.env.HTA_DEBUG) process.stdout.write(`[kanban] ${chunk}`);
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    // 拷贝到局部变量：TS 会把闭包内才赋值的属性窄化为 null，分支内变成 never
    const spawnErr: Error | null = spawnFailure.err;
    if (spawnErr) {
      throw new Error(
        `无法启动 helios-kanban：执行 npx 失败（npx 不可执行或未安装 Node.js/npm）: ${spawnErr.message}`,
      );
    }
    if (child.exitCode !== null) {
      throw new Error(
        `helios-kanban 进程已退出（code=${child.exitCode}）\n${stderrBuf.slice(-800) || '(无 stderr)'}`,
      );
    }
    if (await fetchHealth(url)) {
      log(`helios-kanban 已就绪（${url}）`);
      return { started: true, child, url };
    }
    await sleep(800);
  }

  await stopKanbanChild(child);
  throw new Error(`等待 helios-kanban 就绪超时（${Math.round(waitMs / 1000)} 秒）：${url}。多数是首次 npx 下载慢，重试或手动启动后再试。`);
}

/** 按进程组发信号（spawn 时 detached: true）；组杀失败（如平台不支持负 pid）回退只杀 child。 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* 已退出 */
    }
  }
}

/** 进程组是否还有存活成员（npx 壳退出后，被 reparent 的看板孙进程仍在组里）。 */
function treeAlive(child: ChildProcess): boolean {
  try {
    process.kill(-child.pid!, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopKanbanChild(child: ChildProcess | null): Promise<void> {
  if (!child) return;
  // exitCode 不能作短路条件：npx 壳退出后，被 reparent 的看板孙进程仍在进程组里，
  // 直接返回会让看板成为孤儿继续占端口。组内无活口才真的无事可做。
  if (!treeAlive(child)) return;
  // 按进程组杀：npx 只是壳，看板服务是其子进程，只杀 npx 会让看板成为孤儿继续占端口
  killTree(child, 'SIGTERM');
  await sleep(500);
  // 看板进程对首轮 SIGTERM 可能不敏感（父进程死后才响应）：组内还有活口就补 SIGKILL
  if (treeAlive(child)) killTree(child, 'SIGKILL');
}
