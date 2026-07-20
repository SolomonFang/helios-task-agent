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

export interface LlmPreset {
  name: string;
  baseUrl: string;
  model: string;
}

export type AskFn = (prompt: string) => Promise<string | null>;
export type ChooseFn = (presets: LlmPreset[]) => Promise<number>;

export type ChatMessage = ChatCompletionMessageParam;
export type OpenAiTool = ChatCompletionTool;
export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;
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
 * Future transport for Feishu IM / webhook / long-poll.
 * CLI is one channel; a Feishu bot channel can implement the same surface.
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
