import type { KanbanMcp } from './mcp';
import { MemoryStore } from './memory';
import { createClient, runAgentTurn } from './llm';
import { buildSystemPrompt } from './prompt';
import { buildTools } from './tools';
import { withBatchApproval, type ConfirmFn } from './guard';
import type {
  AgentConfig,
  ChatMessage,
  OpenAiClient,
  OpenAiTool,
  ProgressInfo,
  ToolHandlers,
  UserMemory,
} from './types';

export interface AgentSessionOptions {
  /** CLI 默认 local；飞书通道传 open_id。 */
  userId?: string;
  memory?: MemoryStore;
  /** 写操作确认通道（CLI y/n 或飞书卡片）；缺省时所有写操作被闸门阻止。 */
  confirm?: ConfirmFn;
}

/**
 * Channel-agnostic agent session. CLI and future Feishu IM both drive this.
 * One session per conversation (terminal REPL, or Feishu chat_id).
 */
export class AgentSession {
  private cfg: AgentConfig;
  private mcp: KanbanMcp | null;
  private mcpOk: boolean;
  private readonly userId: string;
  private readonly memory: MemoryStore;
  private readonly confirm?: ConfirmFn;
  private batchedConfirm?: ConfirmFn;
  private client: OpenAiClient;
  private openAiTools: OpenAiTool[];
  private handlers: ToolHandlers;
  private messages: ChatMessage[];

  constructor(cfg: AgentConfig, mcp: KanbanMcp | null, mcpOk: boolean, opts: AgentSessionOptions = {}) {
    this.cfg = cfg;
    this.mcp = mcp;
    this.mcpOk = mcpOk;
    this.userId = opts.userId || 'local';
    this.memory = opts.memory || new MemoryStore();
    this.confirm = opts.confirm;
    const runtime = this.buildRuntime(cfg);
    this.client = runtime.client;
    this.openAiTools = runtime.openAiTools;
    this.handlers = runtime.handlers;
    this.messages = [{ role: 'system', content: runtime.systemPrompt }];
  }

  get config(): AgentConfig {
    return this.cfg;
  }

  get memoryUserId(): string {
    return this.userId;
  }

  get toolNames(): string[] {
    return this.openAiTools.map((t) => t.function.name);
  }

  getUserMemory(): UserMemory {
    return this.memory.getUser(this.userId);
  }

  formatMemory(): string {
    return this.memory.formatForPrompt(this.userId);
  }

  private refreshSystemPrompt(): void {
    const systemPrompt = buildSystemPrompt(this.promptOpts());
    if (this.messages[0]) this.messages[0] = { role: 'system', content: systemPrompt };
  }

  private promptOpts() {
    return {
      mcpOk: this.mcpOk,
      mcpToolNames: this.mcpOk && this.mcp ? this.mcp.tools.map((t) => t.name) : [],
      kanbanUrl: this.cfg.kanbanUrl,
      projectId: this.cfg.kanbanProjectId || undefined,
      repoId: this.cfg.kanbanRepoId || undefined,
      iteration: this.cfg.kanbanIteration || undefined,
      memoryText: this.memory.formatForPrompt(this.userId),
    };
  }

  private getConfirm(): ConfirmFn | undefined {
    if (!this.confirm) return undefined;
    if (!this.batchedConfirm) this.batchedConfirm = withBatchApproval(this.confirm);
    return this.batchedConfirm;
  }

  private buildRuntime(cfg: AgentConfig) {
    const { openAiTools, handlers } = buildTools({
      mcp: this.mcpOk ? this.mcp : null,
      kanbanUrl: cfg.kanbanUrl,
      kanbanProjectId: cfg.kanbanProjectId,
      kanbanRepoId: cfg.kanbanRepoId,
      kanbanIteration: cfg.kanbanIteration,
      memory: this.memory,
      userId: this.userId,
      onMemoryChange: () => this.refreshSystemPrompt(),
      confirm: this.getConfirm(),
    });
    const systemPrompt = buildSystemPrompt(this.promptOpts());
    return {
      client: createClient(cfg),
      openAiTools,
      handlers,
      systemPrompt,
    };
  }

  /** Hot-reload LLM / kanban defaults after /config. */
  applyConfig(cfg: AgentConfig): void {
    this.cfg = cfg;
    const runtime = this.buildRuntime(cfg);
    this.client = runtime.client;
    this.openAiTools = runtime.openAiTools;
    this.handlers = runtime.handlers;
    if (this.messages[0]) this.messages[0] = { role: 'system', content: runtime.systemPrompt };
  }

  /** Hot-swap MCP availability (supervisor reconnect/degrade): rebuild tools + prompt, keep history. */
  setMcpOk(ok: boolean): void {
    if (this.mcpOk === ok) return;
    this.mcpOk = ok;
    this.applyConfig(this.cfg);
  }

  /** Inject a background event (e.g. kanban watcher notification) into the conversation context. */
  injectSystemNote(note: string): void {
    this.messages.push({ role: 'system', content: note });
  }

  /** Clear chat history only — memory is kept. */
  clearHistory(): void {
    this.refreshSystemPrompt();
    this.messages = this.messages.slice(0, 1);
  }

  async handleUserMessage(
    text: string,
    onProgress?: (info: ProgressInfo) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    this.messages.push({ role: 'user', content: text });
    try {
      return await runAgentTurn({
        client: this.client,
        model: this.cfg.llmModel,
        messages: this.messages,
        tools: this.openAiTools,
        handlers: this.handlers,
        onProgress,
        signal,
      });
    } catch (err) {
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'user') this.messages.pop();
      throw err;
    }
  }
}
