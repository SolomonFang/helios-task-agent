import type { KanbanMcp } from '../kanban/mcp';
import { MemoryStore } from './memory';
import { createClient, runAgentTurn } from './llm';
import { buildSystemPrompt } from './prompt';
import { buildTools } from './tools';
import { withBatchApproval, type BatchConfirmFn, type ConfirmFn } from './guard';
import type {
  AgentConfig,
  ChatMessage,
  OpenAiClient,
  OpenAiTool,
  ProgressInfo,
  ToolHandlers,
  UserMemory,
} from '../types';

/** 待注入后台事件的缓存上限：超出丢弃最旧，避免 watcher 风暴/积压撑爆上下文。 */
const MAX_PENDING_NOTES = 20;

export interface AgentSessionOptions {
  /** CLI 默认 local；飞书通道传 open_id。 */
  userId?: string;
  memory?: MemoryStore;
  /** 写操作确认通道（CLI y/n 或飞书卡片）；缺省时所有写操作被闸门阻止。 */
  confirm?: ConfirmFn;
  /** bot 场景的报告静态服务基地址：work_summary 报告改推 HTTP 链接。 */
  reportLinkBaseUrl?: string;
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
  private readonly reportLinkBaseUrl?: string;
  private batchedConfirm?: BatchConfirmFn;
  private client: OpenAiClient;
  private openAiTools: OpenAiTool[];
  private handlers: ToolHandlers;
  private messages: ChatMessage[];
  /** 后台事件缓存（injectSystemNote）：下一个轮边界注入，避免打断 tool_calls 配对。 */
  private pendingNotes: Array<{ text: string; key?: string }> = [];

  constructor(cfg: AgentConfig, mcp: KanbanMcp | null, mcpOk: boolean, opts: AgentSessionOptions = {}) {
    this.cfg = cfg;
    this.mcp = mcp;
    this.mcpOk = mcpOk;
    this.userId = opts.userId || 'local';
    this.memory = opts.memory || new MemoryStore();
    this.confirm = opts.confirm;
    this.reportLinkBaseUrl = opts.reportLinkBaseUrl;
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

  /** 撤销当前会话所有「同类免问」授权（恢复逐次确认），返回撤销的类数。 */
  revokeBatchApprovals(): number {
    return this.batchedConfirm?.revokeBatchApprovals() ?? 0;
  }

  /** 当前生效中的「同类免问」授权类数（/confirm 查询用）。 */
  activeBatchApprovals(): number {
    return this.batchedConfirm?.activeBatchApprovals() ?? 0;
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
      reportLinkBaseUrl: this.reportLinkBaseUrl,
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
  injectSystemNote(note: string, dedupeKey?: string): void {
    // 不直接插入历史：后台事件可能在 tool 轮次中途（assistant(tool_calls) 与其 tool
    // 响应之间，例如等待写确认时）到达，直接 push 会破坏配对，导致后续请求被 API 拒绝。
    // 缓存到下一轮用户消息的轮边界再注入。
    // 去重：watcher 推送失败会重投同一事件。note 带注入时间戳，全串比较会被重投击穿，
    // 故 watcher 侧传事件 id 作 dedupeKey 按 key 去重；无 key 时回退全串比较。
    const dup =
      dedupeKey !== undefined
        ? this.pendingNotes.some((n) => n.key === dedupeKey)
        : this.pendingNotes.some((n) => n.key === undefined && n.text === note);
    if (dup) return;
    this.pendingNotes.push({ text: note, key: dedupeKey });
    // 上限兜底：积压过多时丢弃最旧
    if (this.pendingNotes.length > MAX_PENDING_NOTES) {
      this.pendingNotes.splice(0, this.pendingNotes.length - MAX_PENDING_NOTES);
    }
  }

  /**
   * 把待注入的后台事件落到历史里（仅允许在轮边界调用）。
   * 存储侧保持 system 角色（紧跟 system prompt 的上下文注记）；真正发给模型时由
   * llm.downgradeSystemNotes 降级为 user + UNTRUSTED 包裹——部分 OpenAI 兼容网关
   * 对非首位/多条 system 消息直接 400。
   */
  private flushPendingNotes(): void {
    if (!this.pendingNotes.length) return;
    for (const note of this.pendingNotes) this.messages.push({ role: 'system', content: note.text });
    this.pendingNotes = [];
  }

  /** Clear chat history only — memory is kept. 重建工具闭包以重置「单会话创建上限」等会话级计数。 */
  clearHistory(): void {
    this.applyConfig(this.cfg);
    this.messages = this.messages.slice(0, 1);
  }

  async handleUserMessage(
    text: string,
    onProgress?: (info: ProgressInfo) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    this.flushPendingNotes();
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
