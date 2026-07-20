'use strict';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

/**
 * Helios Kanban MCP client (stdio). Spawns `npx -y helios-kanban@latest --mcp`
 * by default; command/args come from config.
 */
class KanbanMcp {
  constructor({ command, args }) {
    this.command = command;
    this.args = args;
    this.client = null;
    this.tools = [];
  }

  async connect({ timeoutMs = 30000 } = {}) {
    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      stderr: 'pipe',
    });
    // swallow server stderr noise unless debugging
    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => {
        if (process.env.HTA_DEBUG) process.stderr.write(`[mcp] ${chunk}`);
      });
    }
    const client = new Client(
      { name: 'helios-task-agent', version: '1.0.0' },
      { capabilities: {} },
    );
    const timer = setTimeout(() => {
      transport.close().catch(() => {});
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

  get connected() {
    return Boolean(this.client);
  }

  async callTool(name, args) {
    if (!this.client) throw new Error('MCP 未连接');
    const result = await this.client.callTool({ name, arguments: args || {} });
    // Flatten MCP content blocks into a string for the LLM
    const parts = (result.content || []).map((block) => {
      if (block.type === 'text') return block.text;
      return JSON.stringify(block);
    });
    return parts.join('\n') || '(空结果)';
  }

  async close() {
    if (this.client) {
      try {
        await this.client.close();
      } catch (_) {
        /* ignore */
      }
      this.client = null;
    }
  }
}

module.exports = { KanbanMcp };
