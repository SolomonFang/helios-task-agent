import OpenAI from 'openai';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
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

/**
 * Repair orphaned assistant `tool_calls` (e.g. left by an interrupted turn in
 * older versions): any function call without a following `tool` response gets
 * a placeholder response inserted, otherwise the next API request is rejected
 * ("assistant message with tool_calls must be followed by tool messages").
 * Mutates `messages` in place.
 */
export function sanitizeToolPairs(messages: ChatMessage[]): ChatMessage[] {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const id = (messages[j] as { tool_call_id?: string }).tool_call_id;
      if (id) answered.add(id);
      j++;
    }
    for (const call of m.tool_calls) {
      if (call.type !== 'function' || answered.has(call.id)) continue;
      messages.splice(j, 0, {
        role: 'tool',
        tool_call_id: call.id,
        content: '（该工具调用无响应记录：所在轮次曾被中断）',
      });
      j++;
    }
  }
  return messages;
}

/** 提前中止时为未执行的 tool_calls 补占位响应，保持历史可继续（见 sanitizeToolPairs）。 */
function fillUnanswered(messages: ChatMessage[], calls: ChatCompletionMessageToolCall[]): void {
  for (const call of calls) {
    if (call.type !== 'function') continue;
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: '（该工具调用未执行：本轮已提前中止）',
    });
  }
}

export async function runAgentTurn({
  client,
  model,
  messages,
  tools,
  handlers,
  onProgress,
  signal,
}: {
  client: OpenAiClient;
  model: string;
  messages: ChatMessage[];
  tools: OpenAiTool[];
  handlers: ToolHandlers;
  onProgress?: (info: ProgressInfo) => void;
  /** Aborted by /stop: checked before each round/tool call, passed to the LLM request. */
  signal?: AbortSignal;
}): Promise<string> {
  sanitizeToolPairs(messages);
  trimHistory(messages);
  let toolCallCount = 0;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (signal?.aborted) return '（已被用户中断）';
    if (onProgress) onProgress({ type: round === 0 ? 'think' : 'continue' });
    const resp = await client.chat.completions.create(
      {
        model,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? 'auto' : undefined,
        temperature: 0.3,
      },
      signal ? { signal } : {},
    );
    const msg = resp.choices[0]?.message;
    if (!msg) throw new Error('模型返回为空');

    messages.push(msg);

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      return msg.content || '(模型未返回内容)';
    }

    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      if (call.type !== 'function') continue;
      toolCallCount++;
      // 中断/超限时先为剩余 tool_calls 补占位响应再返回，避免 orphan tool_calls 损坏后续轮次
      if (signal?.aborted) {
        fillUnanswered(messages, toolCalls.slice(i));
        return '（已被用户中断）';
      }
      if (toolCallCount > MAX_TOOL_CALLS) {
        fillUnanswered(messages, toolCalls.slice(i));
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
            result = String(await handler(args, { signal }));
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