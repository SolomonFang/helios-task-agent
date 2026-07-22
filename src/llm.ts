import OpenAI from 'openai';
import type {
  ChatMessage,
  LlmClientConfig,
  OpenAiClient,
  OpenAiTool,
  ProgressInfo,
  ToolHandlers,
} from './types';

/** Backstop on LLM rounds; real limit is on tool-call count below. */
const MAX_TOOL_ROUNDS = 25;
/** Max tool invocations per user turn (covers「最多展开 10 条链接」with headroom). */
const MAX_TOOL_CALLS = 30;
/** Keep system + this many subsequent messages (tool-call chains trimmed intact). */
export const MAX_HISTORY_MESSAGES = 40;

export function createClient(cfg: LlmClientConfig): OpenAiClient {
  return new OpenAI({
    baseURL: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey,
    timeout: 120000,
    maxRetries: 1,
  });
}

/**
 * Trim old turns from the front while preserving the system message and
 * not leaving orphaned `tool` messages without their assistant tool_calls.
 * Mutates `messages` in place.
 */
export function trimHistory(messages: ChatMessage[], maxMessages = MAX_HISTORY_MESSAGES): ChatMessage[] {
  if (messages.length <= maxMessages) return messages;
  const system = messages[0]!;
  const rest = messages.slice(1);
  while (rest.length > maxMessages - 1) {
    rest.shift();
    while (rest.length && rest[0]?.role === 'tool') rest.shift();
  }
  while (rest.length && rest[0]?.role !== 'user') {
    rest.shift();
    while (rest.length && rest[0]?.role === 'tool') rest.shift();
  }
  messages.length = 0;
  messages.push(system, ...rest);
  return messages;
}

export async function runAgentTurn({
  client,
  model,
  messages,
  tools,
  handlers,
  onProgress,
}: {
  client: OpenAiClient;
  model: string;
  messages: ChatMessage[];
  tools: OpenAiTool[];
  handlers: ToolHandlers;
  onProgress?: (info: ProgressInfo) => void;
}): Promise<string> {
  trimHistory(messages);
  let toolCallCount = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (onProgress) onProgress({ type: round === 0 ? 'think' : 'continue' });
    const resp = await client.chat.completions.create({
      model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      temperature: 0.3,
    });
    const msg = resp.choices[0]?.message;
    if (!msg) throw new Error('模型返回为空');

    messages.push(msg);

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      return msg.content || '(模型未返回内容)';
    }

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      toolCallCount++;
      if (toolCallCount > MAX_TOOL_CALLS) {
        return `（工具调用次数超过上限 ${MAX_TOOL_CALLS}，已中止。请缩小任务范围或分步执行。）`;
      }
      const name = call.function.name;
      const handler = handlers.get(name);
      let result: string | undefined;
      if (onProgress) onProgress({ type: 'tool', name });
      if (!handler) {
        result = `错误：未知工具 ${name}`;
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = `错误：工具参数 JSON 解析失败: ${message}`;
        }
        if (result === undefined) {
          try {
            result = String(await handler(args));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result = `工具 ${name} 执行异常: ${message}`;
          }
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result!,
      });
    }
  }
  return '（工具调用轮次过多，已中止。请缩小任务范围或分步执行。）';
}