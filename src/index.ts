/** Public API for embedding (e.g. Feishu channel process). */
export { AgentSession } from './session';
export { KanbanMcp } from './mcp';
export { MemoryStore, defaultDataHome, SUGGESTED_MEMORY_KEYS } from './memory';
export { ensureConfig, currentConfig, PRESETS } from './config';
export { buildSystemPrompt } from './prompt';
export { buildTools } from './tools';
export { createClient, runAgentTurn, trimHistory } from './llm';
export { main as runCli } from './cli';
export type {
  AgentConfig,
  AgentChannel,
  InboundMessage,
  ChatMessage,
  ProgressInfo,
  UserMemory,
  MemoryFile,
} from './types';
