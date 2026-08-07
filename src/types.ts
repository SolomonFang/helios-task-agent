import type OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';

/** App config loaded from .env / wizard. */
export interface AgentConfig {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  mcpCommand: string;
  mcpArgs: string[];
  kanbanUrl: string;
  kanbanProjectId: string;
  kanbanRepoId: string;
  kanbanIteration: string;
}

/** Feishu bot long-connection credentials. */
export interface FeishuBotConfig {
  appId: string;
  appSecret: string;
  /** Empty = allow all DMs; otherwise only listed open_ids. */
  allowedOpenIds: string[];
}

export interface LlmPreset {
  name: string;
  baseUrl: string;
  model: string;
}

export type AskFn = (prompt: string) => Promise<string | null>;
export type ChooseFn = (presets: LlmPreset[]) => Promise<number>;

export type ChatMessage = ChatCompletionMessageParam;
export type OpenAiTool = ChatCompletionTool;
export interface ToolContext {
  /** Aborted by /stop — long-running handlers should pass it to subprocess/API calls. */
  signal?: AbortSignal;
}
export type ToolHandler = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
export type ToolHandlers = Map<string, ToolHandler>;

export type ProgressInfo =
  | { type: 'think' | 'continue' }
  | { type: 'tool'; name: string };

export interface LlmClientConfig {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export type OpenAiClient = OpenAI;

/** Per-user persistent memory (facts + optional notes). */
export interface UserMemory {
  facts: Record<string, string>;
  notes: string[];
  updatedAt: string;
}

export interface MemoryFile {
  version: number;
  users: Record<string, UserMemory>;
}

/**
 * 消息通道抽象：当前唯一实现是飞书 bot 通道（src/channels/feishu.ts），
 * 接口形状（sessionId / open_id 风格 senderId）按飞书 IM 设计；CLI 终端不走此接口。
 */
export interface AgentChannel {
  readonly name: string;
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  reply(msg: InboundMessage, text: string): Promise<void>;
  stop(): Promise<void>;
}

export interface InboundMessage {
  /** Stable conversation / chat id for session routing. */
  sessionId: string;
  /** Human-readable sender (open_id / name). */
  senderId: string;
  text: string;
  /** Raw channel payload for reply threading. */
  raw?: unknown;
}
