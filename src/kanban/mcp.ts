import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { MCP_FALLBACK_TEXT } from '../infra/deps';

export class KanbanMcp {
  readonly command: string;
  readonly args: string[];
  private client: Client | null = null;
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
    const timer = setTimeout(() => {
      void transport.close().catch(() => {});
    }, timeoutMs);
    try {
      await client.connect(transport);
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
      // 不主动关会泄漏 stdio 子进程（超时已触发过的重复 close 无害）
      await transport.close().catch(() => {});
      throw err;
    } finally {
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
    if (!this.client) throw new Error('MCP 未连接');
    // 显式 30s 超时，不依赖 SDK 隐式默认值
    await this.client.listTools(undefined, { timeout: 30000 });
  }

  /** Drop the current client and establish a fresh stdio connection. */
  async reconnect({ timeoutMs = 45000 }: { timeoutMs?: number } = {}): Promise<void> {
    await this.close();
    await this.connect({ timeoutMs });
  }

  async callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.client) throw new Error('MCP 未连接');
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
    return parts.join('\n') || '(空结果)';
  }

  async close(): Promise<void> {
    // 置位挂起标志：connect 在途时本轮 close 拿不到 client，由 connect 完成后自我关闭兜底
    this.closePending = true;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }
}

/**
 * MCP 启动失败的已知模式诊断：命中返回给用户看的排查提示，未命中返回 null。
 * 典型场景：本机看板进程运行时间过长，其端口文件（vibe-kanban.port）被系统
 * 清理，MCP 服务启动即退出（Error: No such file or directory），重启看板即恢复。
 */
export function diagnoseMcpFailure(stderrTail: string): string | null {
  if (!stderrTail) return null;
  if (/vibe-kanban\.port|Reading port from/i.test(stderrTail) && /No such file|not found|error/i.test(stderrTail)) {
    return (
      '提示：MCP 未能发现看板端口文件（vibe-kanban.port）。本机看板进程运行时间过长时，' +
      '该文件可能已被系统清理——重启 helios-kanban 后重新运行本程序即可恢复' +
      `（当前${MCP_FALLBACK_TEXT}，看板功能不受影响）。`
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
 */
export async function connectMcp(
  cfg: { mcpCommand: string; mcpArgs: string[] },
  opts: { onCreate?: (mcp: KanbanMcp) => void } = {},
): Promise<McpBootResult> {
  const mcp = new KanbanMcp({ command: cfg.mcpCommand, args: cfg.mcpArgs });
  opts.onCreate?.(mcp);
  try {
    await mcp.connect({ timeoutMs: 45000 });
    return { mcp, ok: true, hint: null };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (process.env.HTA_DEBUG) console.error(`\n[mcp] ${e.stack || e.message}`);
    return { mcp, ok: false, error: e.message, hint: diagnoseMcpFailure(mcp.getStderrTail()) };
  }
}
