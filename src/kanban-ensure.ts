import { spawn, type ChildProcess } from 'child_process';
import http from 'http';
import https from 'https';
import { URL } from 'url';

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

async function fetchHealth(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
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
          res.resume();
          done(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500));
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
  }: {
    autoStart?: boolean;
    waitMs?: number;
    onLog?: (msg: string) => void;
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

  log(`未检测到看板，正在启动 npx helios-kanban（PORT=${port}）…`);
  const child = spawn('npx', ['-y', 'helios-kanban'], {
    env: {
      ...process.env,
      HOST: '0.0.0.0',
      PORT: port,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    if (process.env.HTA_DEBUG) process.stderr.write(`[kanban] ${chunk}`);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    if (process.env.HTA_DEBUG) process.stdout.write(`[kanban] ${chunk}`);
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
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

  child.kill('SIGTERM');
  throw new Error(`等待 helios-kanban 就绪超时（${waitMs}ms）：${url}`);
}

export async function stopKanbanChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await sleep(500);
  if (child.exitCode === null) child.kill('SIGKILL');
}
