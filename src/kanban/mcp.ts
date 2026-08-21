import { execFile } from 'child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { MCP_FALLBACK_TEXT } from '../infra/deps';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KanbanMcp {
  readonly command: string;
  readonly args: string[];
  private client: Client | null = null;
  /** 当前 stdio transport 的直接子进程 pid（npx 壳），用于 close 后清理残留孙进程。 */
  private transportPid: number | null = null;
  /** 子进程 stderr 尾部（连接失败时用于诊断已知模式，如端口文件缺失）。 */
  private stderrTail = '';
  /**
   * close 请求挂起标志：connect 在途时 close() 因 client===null 本会成为 no-op，
   * connect 随后完成会留下无人持有的 stdio 子进程（supervisor.stop 竞速超时路径）。
   * close() 置位后，connect 完成时立即自我关闭。
   */
  private closePending = false;
  tools: Tool[] = [];

  constructor({ command, args }: { command: string; args: string[] }) {
    this.command = command;
    this.args = args;
  }

  async connect({ timeoutMs = 30000 }: { timeoutMs?: number } = {}): Promise<Tool[]> {
    this.closePending = false;
    this.stderrTail = '';
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      stderr: 'pipe',
    });
    if (transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
        if (process.env.HTA_DEBUG) process.stderr.write(`[mcp] ${chunk}`);
      });
    }
    const client = new Client({ name: 'helios-task-agent', version: '1.0.0' }, { capabilities: {} });
    // 超时路径的子孙进程快照：close 会杀掉直接子进程（npx 壳），孙进程被 reparent 后按
    // ppid 已找不到——必须在 close 前快照，否则超时场景恰好绕过 sweepOrphanedTree 清理
    let timeoutSnapshot: Map<number, string> | null = null;
    // 竞态护栏：超时回调里 await 快照期间 connect 可能已成功/失败返回——回调恢复后
    // 必须先复查 settled，否则会把已建立连接的 transport 关掉（调用方拿到 ok:true 但下次调用即失败）
    let settled = false;
    const timer = setTimeout(() => {
      void (async () => {
        if (settled) return;
        timeoutSnapshot = await collectDescendants(transport.pid);
        if (settled) return; // await 期间 connect 已落定，transport 归属成功/失败路径处理，不再误关
        await transport.close().catch(() => {});
      })();
    }, timeoutMs);
    try {
      await client.connect(transport);
      this.transportPid = transport.pid;
      const { tools } = await client.listTools();
      this.tools = tools || [];
      this.client = client;
      if (this.closePending) {
        // connect 在途期间收到 close()（如 supervisor.stop 竞速超时后进程退出）：
        // 立即关闭刚建立的连接，不留孤儿 stdio 子进程
        this.closePending = false;
        await this.close();
      }
      return this.tools;
    } catch (err) {
      // 快速失败路径（connect 在超时前 reject）：超时定时器尚未触发，transport 未关闭，
      // 不主动关会泄漏 stdio 子进程（超时已触发过的重复 close 无害）。
      // 快照须在 kill 之前：孙进程在直接子进程死后被 reparent，事后按父 pid 已找不到。
      // 超时路径复用定时器里 close 前已完成的快照（此刻直接子进程已死，现采快照为空）。
      const snapshot = timeoutSnapshot ?? (await collectDescendants(transport.pid));
      await transport.close().catch(() => {});
      await sweepOrphanedTree(snapshot);
      this.transportPid = null;
      throw err;
    } finally {
      // 先置 settled 再清定时器：若定时器回调恰在此刻进入，settled 保证其不再误关 transport
      settled = true;
      clearTimeout(timer);
    }
  }

  get connected(): boolean {
    return Boolean(this.client);
  }

  /** 最近一次 connect 期间捕获的子进程 stderr 尾部（诊断用）。 */
  getStderrTail(): string {
    return this.stderrTail.trim();
  }

  /** Liveness probe used by the supervisor (listTools is known to be supported). */
  async ping(): Promise<void> {
    if (!this.client) throw new Error('看板连接已断开，正在自动重连，请稍后再试');
    // 显式 30s 超时，不依赖 SDK 隐式默认值
    await this.client.listTools(undefined, { timeout: 30000 });
  }

  /** Drop the current client and establish a fresh stdio connection. */
  async reconnect({ timeoutMs = 45000 }: { timeoutMs?: number } = {}): Promise<void> {
    await this.close();
    await this.connect({ timeoutMs });
  }

  async callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.client) throw new Error('看板连接已断开，正在自动重连，请稍后再试');
    // 显式 60s 超时（与 SDK 默认值一致，但不依赖隐式默认）；调用方 signal 仍可提前中断
    const result = await this.client.callTool(
      { name, arguments: args || {} },
      undefined,
      { timeout: 60000, ...(signal ? { signal } : {}) },
    );
    const content = Array.isArray(result.content) ? result.content : [];
    const parts = content.map((block: { type: string; text?: string }) => {
      if (block.type === 'text') return block.text ?? '';
      return JSON.stringify(block);
    });
    return parts.join('\n') || '（空结果）';
  }

  async close(): Promise<void> {
    // 置位挂起标志：connect 在途时本轮 close 拿不到 client，由 connect 完成后自我关闭兜底
    this.closePending = true;
    // SDK 的 StdioClientTransport 不透传 spawn 选项（无 detached 进程组杀），只 SIGTERM/SIGKILL
    // 直接子进程（npx 壳）；孙进程（真正的 server）被 reparent 成孤儿。close 前先快照子进程树，
    // close 后 best-effort 补杀仍存活的孙进程（有界、失败吞掉、幂等）。
    const snapshot = await collectDescendants(this.transportPid);
    this.transportPid = null;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    await sweepOrphanedTree(snapshot);
  }
}

/** 批量取若干 pid 的当前命令行（pid → command，已退出的 pid 缺席）；ps 失败返回 null。 */
function commandsOf(pids: number[]): Promise<Map<number, string> | null> {
  if (pids.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile('ps', ['-p', pids.join(','), '-o', 'pid=,command='], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = new Map<number, string>();
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m) out.set(Number(m[1]), m[2]!);
      }
      resolve(out);
    });
  });
}

/**
 * 快照 rootPid 的全部后代进程（pid → 命令行，不含 root 自身）。仅 darwin/linux；
 * ps 失败或平台不支持返回 null，调用方按「无可清理」处理（best-effort，不影响主流程）。
 */
function collectDescendants(rootPid: number | null): Promise<Map<number, string> | null> {
  if (rootPid === null) return Promise.resolve(null);
  if (process.platform !== 'darwin' && process.platform !== 'linux') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,command='], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const ppidOf = new Map<number, number>();
      const cmdOf = new Map<number, string>();
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        ppidOf.set(Number(m[1]), Number(m[2]));
        cmdOf.set(Number(m[1]), m[3]!);
      }
      // 自 rootPid 向下 BFS 走子树（有界：进程表本身有界）
      const tree = new Map<number, string>();
      const queue = [rootPid];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const [pid, ppid] of ppidOf) {
          if (ppid === cur && !tree.has(pid) && pid !== rootPid) {
            tree.set(pid, cmdOf.get(pid) ?? '');
            queue.push(pid);
          }
        }
      }
      resolve(tree);
    });
  });
}

/**
 * 对快照中的 pid 做 best-effort 补杀：先复核命令行与快照一致（防 pid 复用误杀无关进程），
 * 再 SIGTERM→短等→SIGKILL。全部失败吞掉；有界（至多 2 次 ps + 300ms 等待），幂等。
 */
async function sweepOrphanedTree(snapshot: Map<number, string> | null): Promise<void> {
  if (!snapshot || snapshot.size === 0) return;
  const pids = [...snapshot.keys()];
  const killMatching = async (signal: NodeJS.Signals): Promise<void> => {
    const current = await commandsOf(pids);
    if (!current) return;
    for (const [pid, cmd] of snapshot) {
      if (current.get(pid) !== cmd) continue;
      try {
        process.kill(pid, signal);
      } catch {
        /* 已退出 */
      }
    }
  };
  await killMatching('SIGTERM');
  await sleep(300);
  await killMatching('SIGKILL');
}

/**
 * MCP 启动失败的已知模式诊断：命中返回给用户看的排查提示，未命中返回 null。
 * 典型场景：本机看板进程运行时间过长，其端口文件（vibe-kanban.port）被系统
 * 清理，MCP 服务启动即退出（Error: No such file or directory），重启看板即恢复。
 *
 * opts.fallbackAvailable === false 时（调用方已知 hk_cli 降级链缺 jq/curl）不得
 * 再宣称「已自动切换为备用通道」——此时备用通道同样不可用，如实告知。
 */
export function diagnoseMcpFailure(stderrTail: string, opts?: { fallbackAvailable?: boolean }): string | null {
  if (!stderrTail) return null;
  if (/vibe-kanban\.port|Reading port from/i.test(stderrTail) && /No such file|not found|error/i.test(stderrTail)) {
    const fallback =
      opts?.fallbackAvailable === false
        ? '看板读写暂不可用（备用通道缺少 jq、curl）。'
        : `当前${MCP_FALLBACK_TEXT}。`;
    return (
      '看板连接失败：看板运行时间过久，其端口记录文件可能已被系统清理。' +
      '退出并重新运行本程序即可恢复（会同时重启看板）。' +
      fallback
    );
  }
  return null;
}

export interface McpBootResult {
  mcp: KanbanMcp;
  ok: boolean;
  /** 连接失败的错误信息（ok=false 时有值）。 */
  error?: string;
  /** 已知失败模式的排查提示（未命中为 null）。 */
  hint: string | null;
}

/**
 * 连接 kanban MCP（45s 超时）；失败不抛出（调用方按通道风格提示降级），返回诊断 hint。
 *
 * onCreate：实例一创建（connect 发起前）即同步回调。连接窗口最长 45s，期间收到退出
 * 信号时调用方若等 resolve 才登记清理，in-flight 的 stdio 子进程会成孤儿——参照
 * kanban 的 onSpawn 模式，创建即登记（配合 KanbanMcp 的 closePending 兜底关闭）。
 *
 * fallbackAvailable：调用方已知 hk_cli 备用通道缺依赖（jq/curl）时传 false，
 * 诊断提示不再宣称「已自动切换为备用通道」。
 */
export async function connectMcp(
  cfg: { mcpCommand: string; mcpArgs: string[] },
  opts: {
    onCreate?: (mcp: KanbanMcp) => void;
    onLog?: (msg: string) => void;
    fallbackAvailable?: boolean;
  } = {},
): Promise<McpBootResult> {
  const mcp = new KanbanMcp({ command: cfg.mcpCommand, args: cfg.mcpArgs });
  opts.onCreate?.(mcp);
  // 连接窗口最长 45s：每 ~10 秒补一行进度，避免启动阶段长时间无反馈
  const connectStartedAt = Date.now();
  const beat = opts.onLog
    ? setInterval(() => {
        opts.onLog!(`仍在等待看板连接（已等待 ${Math.round((Date.now() - connectStartedAt) / 1000)} 秒）…`);
      }, 10000)
    : null;
  beat?.unref();
  try {
    await mcp.connect({ timeoutMs: 45000 });
    return { mcp, ok: true, hint: null };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (process.env.HTA_DEBUG) console.error(`\n[mcp] ${e.stack || e.message}`);
    return { mcp, ok: false, error: e.message, hint: diagnoseMcpFailure(mcp.getStderrTail(), { fallbackAvailable: opts.fallbackAvailable }) };
  } finally {
    if (beat) clearInterval(beat);
  }
}
