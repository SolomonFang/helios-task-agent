import OpenAI from 'openai';

/**
 * kanban 层 OpenAI 兼容客户端工厂：与 src/agent/llm.ts createClient 同源的 SDK 配置
 * （timeout / maxRetries / SDK 内建指数退避语义）。
 *
 * 不直接 import agent/llm 的原因：agent 层已反向依赖本层（agent/tools → kanban 的
 * 值级 import），本层再 import agent 会闭合分层回环；且 createClient 把
 * timeout:120000 / maxRetries:3 写死，诊断等场景需要按调用点定制每次尝试超时。
 * 改动 agent/llm.ts 的客户端配置时请同步此处，反之亦然。
 */
export interface KanbanLlmClientOptions {
  baseUrl: string;
  apiKey: string;
  /** 单次尝试超时（同 agent/llm 的 timeout 语义；叠加重试后最坏 (maxRetries+1) 倍，调用方需有整体兜底）。 */
  timeoutMs: number;
  /**
   * SDK 内建指数退避（0.5s→1s→2s，封顶 8s）覆盖 408/409/429/5xx 与连接错误：
   * 瞬时限流/抖动自动重试；abort 信号不走重试（APIUserAbortError），中断仍即时生效。
   */
  maxRetries: number;
}

export function createKanbanLlmClient(opts: KanbanLlmClientOptions): OpenAI {
  return new OpenAI({
    baseURL: opts.baseUrl,
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  });
}
