import OpenAI from 'openai';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import { UNTRUSTED_OPEN, wrapUntrusted } from './guard';
import { errMessage } from '../infra/err';
import type {
  ChatMessage,
  InlineImage,
  LlmClientConfig,
  OpenAiClient,
  OpenAiTool,
  ProgressInfo,
  ToolHandlers,
} from '../types';

/** Backstop on LLM rounds; real limit is on tool-call count below. */
const MAX_TOOL_ROUNDS = 25;
/** Max tool invocations per user turn (covers「最多展开 10 条链接」with headroom). */
const MAX_TOOL_CALLS = 30;
/** 单轮对话墙钟上限（分钟，默认 30）：bot 无人值守时防止超长工具链阻塞该用户的串行队列。 */
const TURN_WALL_CLOCK_MS = Math.max(1, Number(process.env.HTA_TURN_TIMEOUT_MIN || 30) || 30) * 60_000;
/** Keep system + this many subsequent messages (tool-call chains trimmed intact). */
export const MAX_HISTORY_MESSAGES = 40;
/**
 * 历史字符预算（粗 token 代理，含 tool 输出）：条数上限之外的双保险。
 * 工具输出单条可达 8000 字符，仅按条数裁剪仍可能撑爆小上下文模型。
 */
export const MAX_HISTORY_CHARS = 100_000;

export function createClient(cfg: LlmClientConfig): OpenAiClient {
  return new OpenAI({
    baseURL: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey,
    timeout: 120000,
    // SDK 内建指数退避（0.5s→1s→2s，封顶 8s）已覆盖 408/409/429/5xx 与连接错误：
    // 长工具链（最多 25 轮）中途的瞬时限流/抖动自动重试，不再整轮报废。
    // abort 信号不走重试（APIUserAbortError），/stop 仍即时生效。
    maxRetries: 3,
  });
}

function messageChars(m: ChatMessage): number {
  let n = 0;
  const c = (m as { content?: unknown }).content;
  if (typeof c === 'string') n += c.length;
  else if (c != null) n += JSON.stringify(c).length;
  const tc = (m as { tool_calls?: unknown }).tool_calls;
  if (tc) n += JSON.stringify(tc).length;
  return n;
}

/**
 * 丢弃最旧的一整轮（system 之后到第二条 user 之前的全部消息，tool 链随轮次整体移除）。
 * 返回 false 表示只剩当前轮（system + 当前 user + 本轮 assistant/tool），不可再丢。
 */
function dropOldestTurn(messages: ChatMessage[]): boolean {
  if (messages.length <= 3) return false;
  let idx = -1;
  for (let i = 2; i < messages.length; i++) {
    if (messages[i]!.role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return false;
  messages.splice(1, idx - 1);
  sanitizeToolPairs(messages);
  return true;
}

/**
 * Trim old turns from the front while preserving the system message and
 * not leaving orphaned `tool` messages without their assistant tool_calls.
 * 双重上限：条数（maxMessages）与总字符（maxChars）。Mutates in place.
 */
export function trimHistory(
  messages: ChatMessage[],
  maxMessages = MAX_HISTORY_MESSAGES,
  maxChars = MAX_HISTORY_CHARS,
): ChatMessage[] {
  while (messages.length > maxMessages && messages.length > 3) {
    if (!dropOldestTurn(messages)) break;
  }
  let chars = messages.reduce((n, m) => n + messageChars(m), 0);
  while (messages.length > 3 && chars > maxChars) {
    const before = messages.length;
    if (!dropOldestTurn(messages)) break;
    chars = messages.reduce((n, m) => n + messageChars(m), 0);
    if (messages.length === before) break; // 防御：无进展即停
  }
  return messages;
}

/** 模型返回的上下文超限错误特征（用于自动恢复重试）。 */
export const CONTEXT_OVERFLOW_RE =
  /context.{0,20}(length|window|limit)|maximum context|too many tokens|prompt is too long|reduce the length|exceed.{0,20}token|token.{0,10}exceed/i;

/**
 * 发送前把非首位的 system 消息（flushPendingNotes 注入的后台事件通知）降级为 user 角色。
 * 部分 OpenAI 兼容网关对非首位/多条 system 消息直接 400；降级后语义为「外部事件通知，
 * 非用户指令、非系统指令」，并确保 UNTRUSTED 包裹（调用方已包裹的保持原样，不重复包裹）。
 * 只作用于请求载荷，会话内存储的消息角色不变。
 */
export function downgradeSystemNotes(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m, i) => {
    if (i === 0 || m.role !== 'system') return m;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return { role: 'user', content: content.includes(UNTRUSTED_OPEN) ? content : wrapUntrusted(content) };
  });
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
  image,
  wallClockMs = TURN_WALL_CLOCK_MS,
}: {
  client: OpenAiClient;
  model: string;
  messages: ChatMessage[];
  tools: OpenAiTool[];
  handlers: ToolHandlers;
  onProgress?: (info: ProgressInfo) => void;
  /** Aborted by /stop: checked before each round/tool call, passed to the LLM request. */
  signal?: AbortSignal;
  /** 当次透传的图片：仅注入首轮请求（含上下文超限重试），历史与后续工具轮次均为文本占位。 */
  image?: InlineImage;
  /** 本轮对话墙钟上限（毫秒）：到点掐断在途请求/工具执行，按「已超时」路径收尾。 */
  wallClockMs?: number;
}): Promise<string> {
  sanitizeToolPairs(messages);
  trimHistory(messages);
  let toolCallCount = 0;
  // 墙钟看门狗：到点 abort 内部信号，掐断在途的 LLM 请求与工具执行；
  // 用户 /stop 的 signal 转发进同一开关，保持即时生效。两者在收尾文案上区分。
  let timedOut = false;
  const watchdog = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    watchdog.abort();
  }, wallClockMs);
  timer.unref();
  const forwardAbort = () => watchdog.abort();
  if (signal) {
    if (signal.aborted) watchdog.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  const turnSignal = watchdog.signal;
  const timeoutText = `（本轮处理已超过 ${Math.max(1, Math.round(wallClockMs / 60000))} 分钟时间上限，已中止。已完成的操作不受影响，可问我「刚才完成了哪些操作」确认进度；也可缩小任务范围分步执行。）`;
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (signal?.aborted) return '⏹ 已中断（未完成的操作未执行，可继续对话）。';
      if (timedOut) return timeoutText;
      if (onProgress) onProgress({ type: round === 0 ? 'think' : 'continue' });
      const createReq = () => {
        const payload = downgradeSystemNotes(messages);
        // 图片只进当次首个请求：会话历史存的是文本占位（[图片] …），这里仅在请求载荷副本上
        // 把末尾 user 消息替换为多模态 content 数组，避免 base64 随历史回放反复进上下文。
        if (image && round === 0) {
          const last = payload[payload.length - 1];
          if (last && last.role === 'user') {
            payload[payload.length - 1] = {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: image.dataUrl } },
                { type: 'text', text: image.prompt },
              ],
            };
          }
        }
        return client.chat.completions.create(
          {
            model,
            messages: payload,
            tools: tools.length ? tools : undefined,
            tool_choice: tools.length ? 'auto' : undefined,
            temperature: 0.3,
          },
          { signal: turnSignal },
        );
      };
      let resp: Awaited<ReturnType<typeof createReq>> | undefined;
      try {
        resp = await createReq();
      } catch (err) {
        if (timedOut) return timeoutText; // 墙钟到点掐断在途请求：请求未入历史，直接收尾
        const msgText = errMessage(err);
        if (!CONTEXT_OVERFLOW_RE.test(msgText) || signal?.aborted) throw err;
        // 上下文超限自愈：逐级丢弃最旧轮次后重试（最多 3 次），仍失败则抛出原始错误
        let recovered = false;
        for (let attempt = 0; attempt < 3 && !recovered; attempt++) {
          if (!dropOldestTurn(messages)) break;
          try {
            resp = await createReq();
            recovered = true;
          } catch (retryErr) {
            if (timedOut) return timeoutText;
            const retryText = errMessage(retryErr);
            if (!CONTEXT_OVERFLOW_RE.test(retryText)) throw retryErr;
          }
        }
        if (!recovered) throw err;
        if (onProgress) onProgress({ type: 'continue' });
      }
      if (!resp) throw new Error('模型请求失败');
      const msg = resp.choices[0]?.message;
      if (!msg) throw new Error('模型返回为空');

      messages.push(msg);

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        return msg.content || '（模型未返回内容）';
      }

      for (let i = 0; i < toolCalls.length; i++) {
        const call = toolCalls[i]!;
        if (call.type !== 'function') continue;
        toolCallCount++;
        // 中断/超时/超限时先为剩余 tool_calls 补占位响应再返回，避免 orphan tool_calls 损坏后续轮次
        if (signal?.aborted) {
          fillUnanswered(messages, toolCalls.slice(i));
          return '⏹ 已中断（未完成的操作未执行，可继续对话）。';
        }
        if (timedOut) {
          fillUnanswered(messages, toolCalls.slice(i));
          return timeoutText;
        }
        if (toolCallCount > MAX_TOOL_CALLS) {
          fillUnanswered(messages, toolCalls.slice(i));
          return `（本轮工具调用已达上限 ${MAX_TOOL_CALLS} 次，已中止。已完成的操作不受影响，可问我「刚才完成了哪些操作」确认进度；也可缩小任务范围分步执行。）`;
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
            const message = errMessage(err);
            result = `错误：工具参数 JSON 解析失败：${message}`;
          }
          if (result === undefined) {
            try {
              result = String(await handler(args, { signal: turnSignal }));
            } catch (err) {
              const message = errMessage(err);
              result = `工具 ${name} 执行异常：${message}`;
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
    return `（本轮对话轮次已达上限 ${MAX_TOOL_ROUNDS} 轮，已中止。已完成的操作不受影响，可问我「刚才完成了哪些操作」确认进度；也可缩小任务范围分步执行。）`;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}