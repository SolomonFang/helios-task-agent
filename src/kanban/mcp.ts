import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// MCP 降级口径文案：与 src/ui.ts 的 MCP_FALLBACK_TEXT 保持一致。
// kanban 层不反向依赖 ui 层，故此处保留内联副本；改动文案时两处需同步。
const MCP_FALLBACK_TEXT = '已自动切换为 hk_cli（看板 HTTP 接口）';

export class KanbanMcp {
  readonly command: string;
  readonly args: string[];
  private client: Client | null = null;
  /** 子进程 stderr 尾部（连接失败时用于诊断已知模式，如端口文件缺失）。 */
  private stderrTail = '';
  tools: Tool[] = [];

  constructor({ command, args }: { command: string; args: string[] }) {
    this.command = command;
    this.args = args;
  }

  async connect({ timeoutMs = 30000 }: { timeoutMs?: number } = {}): Promise<Tool[]> {
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
      return this.tools;
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
    await this.client.listTools();
  }

  /** Drop the current client and establish a fresh stdio connection. */
  async reconnect({ timeoutMs = 45000 }: { timeoutMs?: number } = {}): Promise<void> {
    await this.close();
    await this.connect({ timeoutMs });
  }

  async callTool(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    if (!this.client) throw new Error('MCP 未连接');
    const result = await this.client.callTool(
      { name, arguments: args || {} },
      undefined,
      signal ? { signal } : undefined,
    );
    const content = Array.isArray(result.content) ? result.content : [];
    const parts = content.map((block: { type: string; text?: string }) => {
      if (block.type === 'text') return block.text ?? '';
      return JSON.stringify(block);
    });
    return parts.join('\n') || '(空结果)';
  }

  async close(): Promise<void> {
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
