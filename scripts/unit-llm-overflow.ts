// 上下文超限自愈链路单测（src/agent/llm.ts runAgentTurn 的 CONTEXT_OVERFLOW_RE 分支）：
// 丢轮重试恢复 / truncation note 注入 / 带图首轮不重试短路 / 非超限错误不误判 / 3 次后放弃。
// 仅用本地 mock server，无外部网络。Run: npx tsx scripts/unit-llm-overflow.ts

import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { createClient, HISTORY_TRUNCATED_NOTE, runAgentTurn } from '../src/agent/llm';
import type { ChatMessage } from '../src/types';
import { checkAsync, finish } from './testkit';

/** 触发 CONTEXT_OVERFLOW_RE 的网关错误文案（OpenAI 风格）。 */
const OVERFLOW_MSG = "This model's maximum context length is exceeded. Please reduce the length of the messages.";

function completionBody(content: string) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  };
}

/**
 * 本地 mock OpenAI 服务：plan 为每次请求返回的 {status, message} 序列，用完后重复最后一项。
 * 400 属 SDK 不可重试错误（仅 408/409/429/5xx 进内建退避），请求数 = createReq 调用数，可精确断言。
 */
async function startMockLlm(plan: Array<{ status: number; message: string }>) {
  const seen: Array<{ body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const n = seen.length;
      seen.push({ body });
      const step = plan[Math.min(n, plan.length - 1)]!;
      if (step.status === 200) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completionBody('pong')));
      } else {
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.message, type: 'mock_error' } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, seen };
}

async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

const mkClient = (base: string) => createClient({ llmBaseUrl: `${base}/v1`, llmApiKey: 'sk-x', llmModel: 'm' });

async function main(): Promise<void> {
  await checkAsync('超限自愈：400 超限后丢弃最旧轮重试成功，注入 truncation note，后续请求不再含已丢内容', async () => {
    const { server, base, seen } = await startMockLlm([
      { status: 400, message: OVERFLOW_MSG },
      { status: 200, message: '' },
    ]);
    try {
      const client = mkClient(base);
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '第一轮问题' },
        { role: 'assistant', content: '第一轮回答' },
        { role: 'user', content: '第二轮问题' },
        { role: 'assistant', content: '第二轮回答' },
        { role: 'user', content: '当前问题' },
      ];
      const reply = await runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() });
      assert.equal(reply, 'pong');
      assert.equal(seen.length, 2, '原始请求 1 次 + 丢轮后重试 1 次');
      // 最旧整轮（第一轮 user+assistant）被丢弃，其余轮次保留
      assert.ok(!messages.some((m) => String(m.content).includes('第一轮问题')), '最旧轮应从历史中移除');
      assert.ok(messages.some((m) => m.content === '第二轮问题'), '较新轮次应保留');
      // truncation note 注入存储侧（system 角色，紧跟 system prompt；不重复注入由 insertTruncationNote 保证）
      assert.equal(messages[1]!.role, 'system');
      assert.equal(messages[1]!.content, HISTORY_TRUNCATED_NOTE);
      // 重试请求载荷不再含已丢轮次（裁剪注记在恢复成功后才注入历史，供后续轮次使用，
      // 故本断言只查已丢内容不进载荷）
      const retryPayload = JSON.parse(seen[1]!.body).messages as Array<{ role: string; content: unknown }>;
      assert.ok(!JSON.stringify(retryPayload).includes('第一轮问题'), '重试载荷不应含已丢内容');
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('超限自愈：首轮带图不做丢轮重试（图片不进历史，重试载荷不变注定失败），原错抛出', async () => {
    const { server, base, seen } = await startMockLlm([{ status: 400, message: OVERFLOW_MSG }]);
    try {
      const client = mkClient(base);
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '看图说话' },
      ];
      await assert.rejects(
        () =>
          runAgentTurn({
            client,
            model: 'm',
            messages,
            tools: [],
            handlers: new Map(),
            image: { dataUrl: 'data:image/png;base64,AAA', prompt: '看图说话' },
          }),
        /maximum context/,
      );
      assert.equal(seen.length, 1, '带图首轮不得重试');
      // 图片确实注入了首个请求载荷（多模态 content 数组）
      const payload = JSON.parse(seen[0]!.body).messages as Array<{ content: unknown }>;
      const last = payload[payload.length - 1]!;
      assert.ok(Array.isArray(last.content), '带图首轮的载荷应为多模态 content 数组');
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('超限自愈：重试中遇到非超限错误立即原样抛出，不继续丢轮', async () => {
    const { server, base, seen } = await startMockLlm([
      { status: 400, message: OVERFLOW_MSG },
      { status: 400, message: 'invalid api key' },
    ]);
    try {
      const client = mkClient(base);
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '旧回答' },
        { role: 'user', content: '当前问题' },
      ];
      await assert.rejects(
        () => runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() }),
        /invalid api key/,
        '非超限错误应原样抛出',
      );
      assert.equal(seen.length, 2, '丢轮重试一次后即放弃');
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('超限自愈：持续超限最多丢 3 轮后放弃（1+3 次请求），抛出原始错误', async () => {
    const { server, base, seen } = await startMockLlm([{ status: 400, message: OVERFLOW_MSG }]);
    try {
      const client = mkClient(base);
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
        { role: 'assistant', content: 'a3' },
        { role: 'user', content: '当前问题' },
      ];
      await assert.rejects(
        () => runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() }),
        /maximum context/,
      );
      assert.equal(seen.length, 4, '原始请求 + 3 次丢轮重试后放弃');
      assert.deepEqual(
        messages.map((m) => m.content),
        ['sys', '当前问题'],
        '3 轮丢尽后只剩 system 与当前轮',
      );
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('超限自愈：历史只剩当前轮（不可再丢）时超限直接抛出，不发额外请求', async () => {
    const { server, base, seen } = await startMockLlm([{ status: 400, message: OVERFLOW_MSG }]);
    try {
      const client = mkClient(base);
      const messages: ChatMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ];
      await assert.rejects(
        () => runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() }),
        /maximum context/,
      );
      assert.equal(seen.length, 1, '无可丢轮次不得空转重试');
    } finally {
      await stopServer(server);
    }
  });

  finish();
}

void main();
