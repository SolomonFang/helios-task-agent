'use strict';

const OpenAI = require('openai');

const MAX_TOOL_ROUNDS = 10;
/** Keep system + this many subsequent messages (tool-call chains trimmed intact). */
const MAX_HISTORY_MESSAGES = 40;

/**
 * @param {object} cfg
 * @param {string} cfg.llmBaseUrl
 * @param {string} cfg.llmApiKey
 * @param {string} cfg.llmModel
 */
function createClient(cfg) {
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
 * @param {object[]} messages
 * @param {number} [maxMessages]
 */
function trimHistory(messages, maxMessages = MAX_HISTORY_MESSAGES) {
  if (messages.length <= maxMessages) return messages;
  const system = messages[0];
  const rest = messages.slice(1);
  while (rest.length > maxMessages - 1) {
    rest.shift();
    while (rest.length && rest[0].role === 'tool') rest.shift();
  }
  // Prefer starting at a user turn so we don't orphan an assistant/tool prefix.
  while (rest.length && rest[0].role !== 'user') {
    rest.shift();
    while (rest.length && rest[0].role === 'tool') rest.shift();
  }
  messages.length = 0;
  messages.push(system, ...rest);
  return messages;
}

/**
 * Run one full agent turn: send messages, execute tool calls in a loop,
 * return final assistant text. Mutates `messages` in place (appends).
 *
 * @param {object} args
 * @param {OpenAI} args.client
 * @param {string} args.model
 * @param {object[]} args.messages  chat history (will be appended)
 * @param {object[]} args.tools     OpenAI tool definitions
 * @param {Map<string, function>} args.handlers  tool name -> async (args) => string
 * @param {(info: {type: string, name?: string}) => void} [args.onProgress]  spinner updates
 */
async function runAgentTurn({ client, model, messages, tools, handlers, onProgress }) {
  trimHistory(messages);
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (onProgress) onProgress({ type: round === 0 ? 'think' : 'continue' });
    const resp = await client.chat.completions.create({
      model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      temperature: 0.3,
    });
    const msg = resp.choices[0] && resp.choices[0].message;
    if (!msg) throw new Error('模型返回为空');

    messages.push(msg);

    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) {
      return msg.content || '(模型未返回内容)';
    }

    for (const call of toolCalls) {
      const name = call.function.name;
      const handler = handlers.get(name);
      let result;
      if (onProgress) onProgress({ type: 'tool', name });
      if (!handler) {
        result = `错误：未知工具 ${name}`;
      } else {
        let args = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch (err) {
          result = `错误：工具参数 JSON 解析失败: ${err.message}`;
        }
        if (result === undefined) {
          try {
            result = String(await handler(args));
          } catch (err) {
            result = `工具 ${name} 执行异常: ${err.message}`;
          }
        }
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }
  return '（工具调用轮次过多，已中止。请缩小任务范围或分步执行。）';
}

module.exports = { createClient, runAgentTurn, trimHistory, MAX_HISTORY_MESSAGES };
