import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export class KanbanMcp {
  readonly command: string;
  readonly args: string[];
  private client: Client | null = null;
  tools: Tool[] = [];

  constructor({ command, args }: { command: string; args: string[] }) {
    this.command = command;
    this.args = args;
  }

  async connect({ timeoutMs = 30000 }: { timeoutMs?: number } = {}): Promise<Tool[]> {
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      stderr: 'pipe',
    });
    if (transport.stderr) {
      transport.stderr.on('data', (chunk: Buffer) => {
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
