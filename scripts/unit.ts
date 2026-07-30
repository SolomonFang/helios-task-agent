// Unit tests: pure logic only — no LLM, no kanban, no network. Run: npm test

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import {
  classifyHk,
  classifyLark,
  classifyMcp,
  looksLikeStrongFailure,
  withBatchApproval,
  type ConfirmRequest,
} from '../src/guard';
import { ConfirmationManager, buildConfirmCard, buildResolvedCard } from '../src/confirm';
import { sanitizeToolPairs, trimHistory, runAgentTurn, MAX_HISTORY_MESSAGES } from '../src/llm';
import { createAccessChecker, parsePostContent, splitText } from '../src/channels/feishu';
import { extractSourceUrls, SourceRegistry } from '../src/source-registry';
import { MemoryStore } from '../src/memory';
import { resolveUnderRoot, runRepoFs } from '../src/repo-fs';
import { writeEnvFile } from '../src/config';
import { buildTools } from '../src/tools';
import { auditLog } from '../src/audit';
import { SessionRouter } from '../src/session-router';
import { AgentSession } from '../src/session';
import type { AgentConfig } from '../src/types';
import type { KanbanMcp } from '../src/kanban/mcp';
import { compareVersions, checkForUpdate, promptVersionUpdate, type DistTags } from '../src/update-check';
import { friendlyLlmError } from '../src/llm-error';
import { diagnoseMcpFailure } from '../src/kanban/mcp';
import { buildWatchEventCard, KanbanWatcher, type WatchEvent } from '../src/kanban/watcher';
import { fetchHealth } from '../src/kanban/kanban-ensure';
import { kanbanPackageSpec, ocrPackageSpec } from '../src/deps';
import { buildOcrEnv, findOcrCommand, resolveReviewTarget, sanitizeCliOutput } from '../src/kanban/ai-review';
import { isAllPass, parseOcrReview, renderReviewHtml, renderReviewMarkdown, writeReviewReport } from '../src/review-report';
import { startReportServer } from '../src/report-server';
import type { ChatMessage, OpenAiClient } from '../src/types';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/** try/catch 包装：异常即 FAIL。 */
async function checkAsync(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    check(name, true);
  } catch (err) {
    check(name, false, err instanceof Error ? err.message : String(err));
  }
}

// --- mock OpenAI client helpers ---

type ToolCallSpec = [id: string, name: string, argsJson: string];

function assistantWithCalls(calls: ToolCallSpec[]) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: args } })),
        },
      },
    ],
  };
}

function finalText(content: string) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

/** 依次返回预置响应；用完后重复最后一个。 */
function mockClient(responses: Array<Record<string, unknown>>): OpenAiClient {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => responses[Math.min(i++, responses.length - 1)],
      },
    },
  } as unknown as OpenAiClient;
}

function toolCallIds(messages: ChatMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) if (tc.type === 'function') ids.push(tc.id);
    }
  }
  return ids;
}

function toolResponseIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool') ids.add((m as { tool_call_id?: string }).tool_call_id || '');
  }
  return ids;
}

async function main(): Promise<void> {
  // ---------- guard 分类 ----------
  check('classifyLark 只读命令放行', classifyLark(['task', 'list']) === 'read' && classifyLark(['im', '--help']) === 'read');
  check('classifyLark 写动词拦截', classifyLark(['im', 'send', '--text', 'x']) === 'write');
  check('classifyLark api 仅 GET 免确认', classifyLark(['api', 'GET', '/x']) === 'read' && classifyLark(['api', 'POST', '/x']) === 'write');
  check('classifyLark 未知命令安全默认写', classifyLark(['doc', 'frobnicate']) === 'write');
  check(
    'classifyLark：update 与夹带 --help 的写命令不免确认',
    classifyLark(['update']) === 'write' &&
      classifyLark(['im', 'send', 'ou_x', '--help']) === 'write' &&
      classifyLark(['im', 'send', '--help']) === 'read' &&
      classifyLark(['task', 'list', '--help']) === 'read' &&
      classifyLark(['--help']) === 'read',
  );
  check('classifyHk 读写分类', classifyHk(['tasks', 'create', 't']) === 'write' && classifyHk(['tasks', 'list']) === 'read' && classifyHk(['start', 'id']) === 'write' && classifyHk(['health']) === 'read');
  check('classifyMcp 读写分类', classifyMcp('list_projects') === 'read' && classifyMcp('create_task') === 'write' && classifyMcp('xyzzy') === 'write');

  // ---------- 强失败判定 ----------
  check(
    'looksLikeStrongFailure 命中真实失败',
    looksLikeStrongFailure('命令执行失败: exit 1') &&
      looksLikeStrongFailure('MCP 工具 create_task 调用失败: boom') &&
      looksLikeStrongFailure('HTTP 500'),
  );
  check(
    'looksLikeStrongFailure 不误判内容文本',
    !looksLikeStrongFailure('已创建任务：修复 error handling 与失败重试逻辑') &&
      !looksLikeStrongFailure('{"success":true,"data":{"id":"…"}}'),
  );

  // ---------- 批量免问 ----------
  await checkAsync('withBatchApproval TTL 内免问 / 撤销 / once 不记忆', async () => {
    let asks = 0;
    const base = async () => {
      asks++;
      return 'batch' as const;
    };
    const fn = withBatchApproval(base, 60_000);
    const req = (batchKey?: string): ConfirmRequest => ({ kind: 'kanban', summary: 's', detail: 'd', batchKey });
    assert.equal(await fn(req('k1')), 'batch');
    assert.equal(await fn(req('k1')), 'batch');
    assert.equal(asks, 1); // 第二次免问
    assert.equal(fn.activeBatchApprovals(), 1);
    assert.equal(fn.revokeBatchApprovals(), 1);
    assert.equal(await fn(req('k1')), 'batch');
    assert.equal(asks, 2); // 撤销后重新询问
    const onceBase = async () => 'once' as const;
    const fn2 = withBatchApproval(onceBase, 60_000);
    await fn2(req('k2'));
    await fn2(req('k2')); // once 不记忆，但 base 固定返回 once
    assert.equal(fn2.activeBatchApprovals(), 0);
  });

  // ---------- ConfirmationManager ----------
  await checkAsync('确认管理器：文本裁决 yes/no/batch/ignored', async () => {
    const settled: string[] = [];
    const mgr = new ConfirmationManager(async () => undefined, { onSettled: (_o, _r, s) => settled.push(s) });
    const p1 = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
    assert.equal(mgr.resolveFromText('u1', '确认'), 'approved');
    assert.equal(await p1, 'once');
    const p2 = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd', batchKey: 'k' });
    assert.equal(mgr.resolveFromText('u1', '同类免问'), 'approved_batch');
    assert.equal(await p2, 'batch');
    const p2b = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd', batchKey: 'k' });
    assert.equal(mgr.resolveFromText('u1', '都允许'), 'approved_batch'); // 旧同义词保持兼容
    assert.equal(await p2b, 'batch');
    const p3 = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
    assert.equal(mgr.resolveFromText('u1', '取消'), 'denied');
    assert.equal(await p3, false);
    assert.equal(mgr.resolveFromText('u1', '确认'), 'ignored'); // 无 pending
    assert.deepEqual(settled, ['once', 'batch', 'batch', 'denied']);
  });

  await checkAsync('确认管理器：无 batchKey 时「同类免问」不生效', async () => {
    const mgr = new ConfirmationManager(async () => undefined);
    const p = mgr.request('u1', { kind: 'lark', summary: 's', detail: 'd' });
    assert.equal(mgr.resolveFromText('u1', '同类免问'), 'ignored'); // 破坏性操作不支持免问
    assert.equal(mgr.resolveFromText('u1', '确认'), 'approved');
    assert.equal(await p, 'once');
  });

  await checkAsync('确认管理器：新请求作废旧请求（superseded）', async () => {
    const events: string[] = [];
    const mgr = new ConfirmationManager(async () => undefined, {
      onSuperseded: () => events.push('superseded-notice'),
      onSettled: (_o, _r, s) => events.push(s),
    });
    const p1 = mgr.request('u1', { kind: 'kanban', summary: 's1', detail: 'd' });
    const p2 = mgr.request('u1', { kind: 'kanban', summary: 's2', detail: 'd' });
    assert.equal(await p1, false); // 旧请求被顶掉 = 拒绝
    assert.equal(mgr.resolveFromText('u1', '确认'), 'approved');
    assert.equal(await p2, 'once');
    assert.deepEqual(events, ['superseded-notice', 'superseded', 'once']);
  });

  await checkAsync('确认管理器：超时自动拒绝 / cancel 按拒绝', async () => {
    const settled: string[] = [];
    const mgr = new ConfirmationManager(async () => undefined, {
      timeoutMs: 40,
      destructiveTimeoutMs: 40,
      onSettled: (_o, _r, s) => settled.push(s),
    });
    const p1 = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd', batchKey: 'k' });
    assert.equal(await p1, false);
    const p2 = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
    assert.equal(mgr.cancel('u1'), true);
    assert.equal(await p2, false);
    assert.deepEqual(settled, ['timeout', 'denied']);
  });

  check('确认卡片：可批量 3 按钮 / 破坏性 2 按钮 / 终态无按钮', (() => {
    const withBatch = buildConfirmCard({ kind: 'kanban', summary: 's', detail: 'd', batchKey: 'k' }, 'id1', 120000) as {
      elements: Array<{ tag: string; actions?: unknown[] }>;
    };
    const destructive = buildConfirmCard({ kind: 'kanban', summary: 's', detail: 'd' }, 'id2', 300000) as {
      elements: Array<{ tag: string; actions?: unknown[] }>;
    };
    const actionOf = (c: typeof withBatch) => c.elements.find((e) => e.tag === 'action');
    const resolved = buildResolvedCard({ kind: 'kanban', summary: 's', detail: 'd' }, 'timeout') as {
      elements: Array<{ tag: string }>;
    };
    return (
      actionOf(withBatch)?.actions?.length === 3 &&
      actionOf(destructive)?.actions?.length === 2 &&
      !resolved.elements.some((e) => e.tag === 'action')
    );
  })());

  // ---------- llm：history 修剪与修复 ----------
  check('trimHistory 保留 system、边界无孤儿 tool', (() => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: 'user', content: `u${i}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }
    trimHistory(messages);
    return (
      messages.length <= MAX_HISTORY_MESSAGES &&
      messages[0]!.role === 'system' &&
      messages[1]!.role === 'user' &&
      !messages.some((m, i) => m.role === 'tool' && messages[i - 1]?.role === 'system')
    );
  })());

  check('trimHistory 字符预算：超限丢最旧整轮', (() => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `u${i}` });
      messages.push({ role: 'assistant', content: 'x'.repeat(3000) });
    }
    trimHistory(messages, 100, 10_000);
    const chars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    return chars <= 10_000 && messages[0]!.role === 'system' && messages[1]!.role === 'user';
  })());

  check('sanitizeToolPairs 补齐缺失的 tool 响应', (() => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'user', content: 'next' },
    ];
    sanitizeToolPairs(messages);
    const ids = toolResponseIds(messages);
    const insertAt = messages.findIndex((m) => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'c2');
    return ids.has('c1') && ids.has('c2') && insertAt === 4 && messages[5]!.role === 'user';
  })());

  await checkAsync('runAgentTurn 正常工具回路', async () => {
    const client = mockClient([assistantWithCalls([['c1', 'echo', '{"x":1}']]), finalText('done')]);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const handlers = new Map([['echo', async () => 'ok']]);
    const reply = await runAgentTurn({ client, model: 'm', messages, tools: [], handlers });
    assert.equal(reply, 'done');
    assert.deepEqual(toolCallIds(messages), ['c1']);
    assert.ok(toolResponseIds(messages).has('c1'));
  });

  await checkAsync('runAgentTurn 批次中断后无 orphan tool_calls，后续轮次可继续', async () => {
    const client = mockClient([
      assistantWithCalls([
        ['c1', 'hold', '{}'],
        ['c2', 'hold', '{}'],
        ['c3', 'hold', '{}'],
      ]),
      finalText('继续正常'),
    ]);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    const ctl = new AbortController();
    let ran = 0;
    const handlers = new Map([
      [
        'hold',
        async () => {
          ran++;
          ctl.abort(); // 第一个工具执行中中断（模拟 /stop）
          return 'ok';
        },
      ],
    ]);
    const reply = await runAgentTurn({ client, model: 'm', messages, tools: [], handlers, signal: ctl.signal });
    assert.ok(reply.includes('中断'));
    assert.equal(ran, 1); // 后续工具未执行
    const answered = toolResponseIds(messages);
    for (const id of ['c1', 'c2', 'c3']) assert.ok(answered.has(id), `缺少 ${id} 的 tool 响应`);
    // 历史完整 → 下一轮可正常进行
    messages.push({ role: 'user', content: '还在吗' });
    const reply2 = await runAgentTurn({ client, model: 'm', messages, tools: [], handlers });
    assert.equal(reply2, '继续正常');
  });

  await checkAsync('runAgentTurn 工具调用超限：剩余调用补占位响应', async () => {
    const calls: ToolCallSpec[] = Array.from({ length: 31 }, (_, i) => [`c${i}`, 'noop', '{}']);
    const client = mockClient([assistantWithCalls(calls)]);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    let ran = 0;
    const handlers = new Map([
      [
        'noop',
        async () => {
          ran++;
          return 'ok';
        },
      ],
    ]);
    const reply = await runAgentTurn({ client, model: 'm', messages, tools: [], handlers });
    assert.ok(reply.includes('上限'));
    assert.equal(ran, 30); // 第 31 个未执行
    const answered = toolResponseIds(messages);
    assert.equal(toolCallIds(messages).length, 31);
    for (const id of toolCallIds(messages)) assert.ok(answered.has(id), `缺少 ${id} 的 tool 响应`);
  });

  await checkAsync('runAgentTurn 上下文超限：自动丢最旧轮次并恢复', async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            if (calls === 1) throw new Error('400 This model\'s maximum context length is 8192 tokens');
            return finalText('恢复成功');
          },
        },
      },
    } as unknown as OpenAiClient;
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: `old-${i}` });
      messages.push({ role: 'assistant', content: 'x'.repeat(5000) });
    }
    messages.push({ role: 'user', content: '当前问题' });
    const reply = await runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() });
    assert.equal(reply, '恢复成功');
    assert.equal(calls, 2); // 第一次超限，丢轮后第二次成功
    assert.ok(messages.length < 12); // 旧轮次被丢弃
    assert.equal(messages[messages.length - 1]!.role, 'assistant');
  });

  await checkAsync('runAgentTurn 上下文超限不可恢复：有限重试后抛出', async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            throw new Error('maximum context length exceeded');
          },
        },
      },
    } as unknown as OpenAiClient;
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    await assert.rejects(() => runAgentTurn({ client, model: 'm', messages, tools: [], handlers: new Map() }));
    assert.ok(calls <= 4, `重试应有上限，实际 ${calls} 次`); // 1 + 最多 3 次重试（且无可丢时提前终止）
  });

  // ---------- 飞书通道 ----------
  check('splitText 长文分段不超限', (() => {
    const para = '这是一段用于测试的中文段落，重复多次以凑够长度。'.repeat(30);
    const text = Array.from({ length: 8 }, () => para).join('\n\n');
    const chunks = splitText(text, 3000);
    return chunks.length > 1 && chunks.every((ck) => ck.length <= 3000) && chunks.join('').includes(para.slice(0, 50));
  })());

  check('parsePostContent 富文本转纯文本', (() => {
    const post = {
      title: '标题',
      content: [
        [
          { tag: 'text', text: '请看 ' },
          { tag: 'a', text: '文档', href: 'https://x.feishu.cn/docx/1' },
          { tag: 'at', user_name: '张三' },
        ],
        [{ tag: 'img' }, { tag: 'code_block', text: 'const a = 1;' }],
      ],
    };
    const out = parsePostContent(JSON.stringify(post));
    return out.includes('标题') && out.includes('文档(https://x.feishu.cn/docx/1)') && out.includes('@张三') && out.includes('[图片]') && out.includes('const a = 1;');
  })());

  check('accessChecker 认领与白名单', (() => {
    const a = createAccessChecker([]);
    const claimed = a.check('u1') === 'claim' && a.check('u1') === 'allow' && a.check('u2') === 'deny';
    const b = createAccessChecker(['u9']);
    return claimed && b.check('u9') === 'allow' && b.check('u1') === 'deny';
  })());

  // ---------- 来源查重 ----------
  check('extractSourceUrls 提取/去重/去尾标点', (() => {
    const urls = extractSourceUrls(
      '见 https://a.feishu.cn/docx/123。和 https://a.feishu.cn/docx/123，以及 https://b.larksuite.com/wiki/x/ 还有 https://example.com/docx/9',
    );
    return urls.length === 2 && urls.includes('https://a.feishu.cn/docx/123') && urls.includes('https://b.larksuite.com/wiki/x');
  })());

  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-reg-'));
    const reg = new SourceRegistry(tmp);
    reg.record('u1', 'https://a.feishu.cn/docx/1', { taskId: 't-1', title: 'T', createdAt: '2026-01-01' });
    const reloaded = new SourceRegistry(tmp);
    check(
      'SourceRegistry 记录/查询/持久化',
      reloaded.lookup('u1', 'https://a.feishu.cn/docx/1')?.taskId === 't-1' && reg.lookup('u2', 'https://a.feishu.cn/docx/1') === undefined,
    );
    reloaded.remove('u1', 'https://a.feishu.cn/docx/1');
    check('SourceRegistry 删除后不可查', new SourceRegistry(tmp).lookup('u1', 'https://a.feishu.cn/docx/1') === undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 记忆 ----------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-mem-'));
    const mem = new MemoryStore(tmp);
    mem.setFact('u1', 'feishu_task_source', 'https://a.feishu.cn/task/1');
    for (let i = 0; i < 60; i++) mem.addNote('u1', `note-${i}`);
    const reloaded = new MemoryStore(tmp);
    const user = reloaded.getUser('u1');
    check(
      'MemoryStore 事实持久化 + 备注保留最近 50 条',
      reloaded.getFact('u1', 'feishu_task_source') === 'https://a.feishu.cn/task/1' &&
        user.notes.length === 50 &&
        user.notes[0] === 'note-10',
    );
    check('MemoryStore 删除事实', reloaded.deleteFact('u1', 'feishu_task_source') && new MemoryStore(tmp).getFact('u1', 'feishu_task_source') === undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- repo_fs 边界 ----------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-fs-'));
    const root = path.join(tmp, 'repo');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    let symlinkOk = true;
    try {
      fs.symlinkSync(outside, path.join(root, 'evil-link'), 'dir');
      fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'good-link'), 'dir');
    } catch {
      symlinkOk = false; // 平台不支持 symlink 时跳过该项
    }
    check(
      'resolveUnderRoot 正常放行 / 字符串越界拦截',
      resolveUnderRoot(root, 'sub').ok && resolveUnderRoot(root, '../outside').ok === false,
    );
    if (symlinkOk) {
      const evil = resolveUnderRoot(root, 'evil-link');
      const good = resolveUnderRoot(root, 'good-link');
      check('resolveUnderRoot 符号链接逃逸拦截 / 界内链接放行', !evil.ok && good.ok);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- .env 权限 ----------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-env-'));
    const envPath = path.join(tmp, '.env');
    writeEnvFile({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'm' }, envPath);
    const mode1 = fs.statSync(envPath).mode & 0o777;
    fs.chmodSync(envPath, 0o644); // 模拟历史遗留的宽松权限
    writeEnvFile({ LLM_BASE_URL: 'https://x' }, envPath);
    const mode2 = fs.statSync(envPath).mode & 0o777;
    const content = fs.readFileSync(envPath, 'utf8');
    check('.env 新建与重写均为 0600', mode1 === 0o600 && mode2 === 0o600, `mode=${mode1.toString(8)}/${mode2.toString(8)}`);
    check('.env 合并写保留既有键', content.includes('LLM_API_KEY=sk-test') && content.includes('LLM_BASE_URL=https://x'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- 数据文件权限 0600 ----------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-perm-'));
    const mem = new MemoryStore(tmp);
    mem.setFact('u1', 'k', 'v');
    const reg = new SourceRegistry(tmp);
    reg.record('u1', 'https://a.feishu.cn/docx/1', { taskId: 't', title: 'T', createdAt: 'x' });
    auditLog({ user: 'u1', kind: 'kanban', summary: 's', detail: 'd', decision: 'approved' }, tmp);
    const modes = ['memory.json', 'synced-sources.json', 'audit.log'].map(
      (f) => fs.statSync(path.join(tmp, f)).mode & 0o777,
    );
    check('数据文件（memory/查重/审计）均为 0600', modes.every((m) => m === 0o600), modes.map((m) => m.toString(8)).join(','));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- repo_fs root 白名单 ----------
  await checkAsync('repo_fs：root 必须是看板注册仓库（未注册拒绝 / 不可达失败关闭）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-wl-'));
    const registered = path.join(tmp, 'repo-a');
    const stranger = path.join(tmp, 'repo-b');
    fs.mkdirSync(registered, { recursive: true });
    fs.mkdirSync(stranger, { recursive: true });
    const server = http.createServer((req, res) => {
      if (req.url === '/api/repos') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: [{ path: registered }] }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const okOut = await runRepoFs(base, { action: 'list', root: registered, path: '.' });
      assert.ok(okOut.includes('root:'), `已注册仓库应放行，实际：${okOut.slice(0, 120)}`);
      const subOut = await runRepoFs(base, { action: 'list', root: path.join(registered, '..', 'repo-a'), path: '.' });
      assert.ok(subOut.includes('root:'), '等价路径应放行');
      const badOut = await runRepoFs(base, { action: 'list', root: stranger, path: '.' });
      assert.ok(badOut.includes('不在看板注册仓库内'), `未注册仓库应拒绝，实际：${badOut.slice(0, 120)}`);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
    const downOut = await runRepoFs('http://127.0.0.1:1', { action: 'list', root: registered, path: '.' });
    assert.ok(downOut.includes('无法校验仓库白名单'), `kanban 不可达应失败关闭，实际：${downOut.slice(0, 120)}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------- 会话上限淘汰 ----------
  check('SessionRouter 会话数上限（LRU 淘汰空闲会话）', (() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-sess-'));
    const cfg: AgentConfig = {
      llmBaseUrl: 'http://localhost:1/v1',
      llmApiKey: 'sk-x',
      llmModel: 'm',
      mcpCommand: 'npx',
      mcpArgs: [],
      kanbanUrl: 'http://localhost:1',
      kanbanProjectId: '',
      kanbanRepoId: '',
      kanbanIteration: '',
    };
    const router = new SessionRouter(cfg, null, false, new MemoryStore(tmp));
    for (let i = 0; i < 55; i++) router.getOrCreate(`u${i}`);
    const size = (router as unknown as { sessions: Map<string, unknown> }).sessions.size;
    fs.rmSync(tmp, { recursive: true, force: true });
    return size <= 50;
  })());

  // ---------- 会话创建上限（buildTools 闭包级） ----------
  await checkAsync('单会话创建上限 10 个：第 11 个被代码层拦截', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-cap-'));
    const fakeMcp = {
      connected: true,
      tools: [{ name: 'create_task', description: 'create', inputSchema: { type: 'object', properties: {} } }],
      callTool: async () => '{"success":true,"data":{"id":"11111111-2222-3333-4444-555555555555"}}',
    } as unknown as KanbanMcp;
    const { handlers } = buildTools({
      mcp: fakeMcp,
      kanbanUrl: 'http://localhost:1',
      confirm: async () => 'once',
      registry: new SourceRegistry(tmp),
      auditHome: tmp,
    });
    const create = handlers.get('kanban_create_task')!;
    let blocked = '';
    for (let i = 0; i < 11; i++) {
      const out = await create({ title: `t${i}` });
      if (out.includes('已达上限')) blocked = out;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.ok(blocked.includes('已达上限'), '第 11 次创建应被上限拦截');
  });

  // ---------- npm 更新检查 ----------
  check('compareVersions 版本比较', (() => {
    return (
      compareVersions('1.0.2', '1.0.2') === 0 &&
      compareVersions('1.1.0', '1.0.9') === 1 &&
      compareVersions('1.0.10', '1.0.9') === 1 &&
      compareVersions('0.9.9', '1.0.0') === -1 &&
      compareVersions('1.1.0-beta.0', '1.1.0') === -1 &&
      compareVersions('1.1.0-beta.1', '1.1.0-beta.0') === 1 &&
      compareVersions('1.2.0-alpha.0', '1.2.0-beta.0') === -1 &&
      compareVersions('v1.2.0', '1.2.0') === 0
    );
  })());

  await checkAsync('checkForUpdate：发现新版 / 无新版 / 缓存 24h / 失败静默', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-upd-'));
    let fetches = 0;
    const fetchTags = async (): Promise<DistTags> => {
      fetches++;
      return { latest: '1.1.0', next: '1.2.0-beta.0' };
    };
    const upd = await checkForUpdate({ current: '1.0.2', home: tmp, fetchDistTags: fetchTags });
    assert.ok(upd && upd.latest === '1.1.0' && upd.tag === 'latest');
    // 24h 内第二次走缓存，不再请求
    await checkForUpdate({ current: '1.0.2', home: tmp, fetchDistTags: fetchTags });
    assert.equal(fetches, 1);
    // 已是最新 → null
    const none = await checkForUpdate({ current: '1.1.0', home: tmp, fetchDistTags: fetchTags });
    assert.equal(none, null);
    // 预发布用户关注 next 频道
    const pre = await checkForUpdate({ current: '1.2.0-alpha.0', home: tmp, fetchDistTags: fetchTags, now: Date.now() + 25 * 3600 * 1000 });
    assert.ok(pre && pre.tag === 'next' && pre.latest === '1.2.0-beta.0');
    // registry 失败 → 静默 null
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-upd2-'));
    const fail = await checkForUpdate({
      current: '1.0.2',
      home: tmp2,
      fetchDistTags: async () => {
        throw new Error('offline');
      },
    });
    assert.equal(fail, null);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  });

  await checkAsync('promptVersionUpdate：y 执行更新 / N 跳过 / 失败回报', async () => {
    const info = { current: '1.0.2', latest: '1.1.0', tag: 'latest' as const };
    const ran: string[] = [];
    const yes = await promptVersionUpdate({
      info,
      ask: async () => 'y',
      runUpdate: async (tag) => {
        ran.push(tag);
        return true;
      },
    });
    assert.equal(yes, 'updated');
    assert.deepEqual(ran, ['latest']);
    const no = await promptVersionUpdate({ info, ask: async () => '', runUpdate: async () => true });
    assert.equal(no, 'skipped');
    const fail = await promptVersionUpdate({ info, ask: async () => 'y', runUpdate: async () => false });
    assert.equal(fail, 'failed');
  });

  // ---------- LLM 错误友好化 ----------
  check('friendlyLlmError 常见错误映射', (() => {
    return (
      friendlyLlmError('401 Unauthorized: invalid api key') !== null &&
      friendlyLlmError("This model's maximum context length is 128000 tokens") !== null &&
      friendlyLlmError('429 rate limit reached') !== null &&
      friendlyLlmError('The model `gpt-x` does not exist') !== null &&
      friendlyLlmError('fetch failed: ECONNREFUSED 127.0.0.1') !== null &&
      friendlyLlmError('some other weird error') === null
    );
  })());

  // ---------- MCP 失败诊断 ----------
  check('diagnoseMcpFailure 端口文件缺失模式', (() => {
    const portFileStderr =
      '2026-07-29T02:22:26Z DEBUG utils::port_file: Reading port from "/var/folders/…/vibe-kanban/vibe-kanban.port"\nError: No such file or directory (os error 2)';
    return (
      diagnoseMcpFailure(portFileStderr) !== null &&
      diagnoseMcpFailure('Error: spawn npx ENOENT') === null &&
      diagnoseMcpFailure('') === null
    );
  })());

  // ---------- /stop 丢弃排队消息 ----------
  await checkAsync('SessionRouter.cancelQueued：丢弃未开始的排队项，进行中与后续新消息不受影响', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-queue-'));
    const cfg: AgentConfig = {
      llmBaseUrl: 'http://localhost:1/v1',
      llmApiKey: 'sk-x',
      llmModel: 'm',
      mcpCommand: 'npx',
      mcpArgs: [],
      kanbanUrl: 'http://localhost:1',
      kanbanProjectId: '',
      kanbanRepoId: '',
      kanbanIteration: '',
    };
    const router = new SessionRouter(cfg, null, false, new MemoryStore(tmp));
    const ran: string[] = [];
    let releaseFirst!: () => void;
    const p1 = router.enqueue('u1', async () => {
      ran.push('first');
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
    });
    const p2 = router.enqueue('u1', async () => {
      ran.push('second');
    });
    const p3 = router.enqueue('u1', async () => {
      ran.push('third');
    });
    await new Promise((r) => setImmediate(r)); // 让 first 进入执行态（移出排队计数）
    assert.equal(router.queuedCount('u1'), 2);
    assert.equal(router.cancelQueued('u1'), 2);
    releaseFirst();
    await Promise.all([p1, p2, p3]);
    assert.deepEqual(ran, ['first']); // second/third 被丢弃
    assert.equal(router.queuedCount('u1'), 0);
    assert.equal(router.cancelQueued('u1'), 0); // 无排队时幂等
    await router.enqueue('u1', async () => {
      ran.push('fourth');
    });
    assert.deepEqual(ran, ['first', 'fourth']); // 丢弃后新消息正常处理
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------- LLM 错误指引按通道区分 ----------
  check('friendlyLlmError：bot 通道不提不存在的 /config，指向 .env', (() => {
    const cliHint = friendlyLlmError('401 invalid api key', { channel: 'cli' }) || '';
    const botHint = friendlyLlmError('401 invalid api key', { channel: 'bot' }) || '';
    const defaultHint = friendlyLlmError('401 invalid api key') || '';
    const botNet = friendlyLlmError('fetch failed: ECONNREFUSED', { channel: 'bot' }) || '';
    return (
      cliHint.includes('/config') &&
      defaultHint.includes('/config') &&
      !botHint.includes('/config') &&
      botHint.includes('.env') &&
      botNet.includes('.env')
    );
  })());

  // ---------- 看板事件卡片：人工审查 + AI 审查按钮 ----------
  check('待审阅卡片：有人工审查链接按钮，有 attemptId 时追加 AI 审查回传按钮', (() => {
    type Btn = { text?: { content?: string }; url?: string; value?: { hta_review?: string; title?: string } };
    const actionsOf = (card: Record<string, unknown>): Btn[] => {
      const els = (card as { elements: Array<{ tag: string; actions?: Btn[] }> }).elements;
      return els.find((e) => e.tag === 'action')?.actions ?? [];
    };
    const base: WatchEvent = {
      kind: 'review',
      title: '测试任务',
      transition: 'inprogress → inreview',
      url: 'http://kanban/tasks/t1?view=diffs',
      text: 'x',
    };
    const withId = actionsOf(buildWatchEventCard({ ...base, attemptId: 'att-1' }));
    const withoutId = actionsOf(buildWatchEventCard(base));
    const done = actionsOf(buildWatchEventCard({ ...base, kind: 'done', attemptId: 'att-1' }));
    return (
      withId.length === 2 &&
      withId[0]!.url === base.url &&
      withId[0]!.text?.content === '🔍 人工审查' &&
      withId[1]!.value?.hta_review === 'att-1' &&
      withId[1]!.value?.title === '测试任务' &&
      withId[1]!.text?.content === '🤖 AI 审查' &&
      withoutId.length === 1 && // 无 attemptId 不渲染 AI 审查
      done.length === 1 // 非 review 事件不渲染 AI 审查
    );
  })());

  // ---------- AI 审查：ocr 环境派生 ----------
  check('buildOcrEnv：派生机器人 LLM 配置 / 显式 OCR_LLM_URL 与已有 OCR 配置优先', (() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-ocr-'));
    const llm = { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-x', model: 'm1' };
    const derived = buildOcrEnv(llm, {}, tmp);
    const derivedOk =
      derived.OCR_LLM_URL === 'https://api.example.com/v1/chat/completions' &&
      derived.OCR_LLM_TOKEN === 'sk-x' &&
      derived.OCR_LLM_MODEL === 'm1' &&
      derived.OCR_USE_ANTHROPIC === 'false';
    // 已是完整端点不再拼接
    const full = buildOcrEnv({ ...llm, baseUrl: 'https://api.example.com/v1/chat/completions' }, {}, tmp);
    const fullOk = full.OCR_LLM_URL === 'https://api.example.com/v1/chat/completions';
    // 显式 env 优先，不覆盖
    const explicit = buildOcrEnv(llm, { OCR_LLM_URL: 'https://custom/v1/chat/completions' }, tmp);
    const explicitOk = explicit.OCR_LLM_URL === 'https://custom/v1/chat/completions' && !explicit.OCR_LLM_TOKEN;
    // 用户已有 OCR provider 配置 → 不注入
    fs.mkdirSync(path.join(tmp, '.opencodereview'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.opencodereview', 'config.json'), JSON.stringify({ provider: 'deepseek' }));
    const respect = buildOcrEnv(llm, {}, tmp);
    const respectOk = !respect.OCR_LLM_URL;
    fs.rmSync(tmp, { recursive: true, force: true });
    return derivedOk && fullOk && explicitOk && respectOk;
  })());

  check('findOcrCommand：PATH 无 ocr 时回退 npx', (() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-ocrpath-'));
    const cmd = findOcrCommand({ PATH: tmp });
    fs.rmSync(tmp, { recursive: true, force: true });
    return cmd.via === 'npx' && cmd.cmd === 'npx' && cmd.prefixArgs.join(' ').includes('open-code-review');
  })());

  check('sanitizeCliOutput 去 ANSI 与回车', (() => {
    return sanitizeCliOutput('\x1b[32mok\x1b[0m\r\nnext') === 'ok\nnext';
  })());

  // ---------- AI 审查：HTML 报告渲染 ----------
  check('renderReviewMarkdown：转义 / 标题 / 列表 / 代码围栏 / 行内格式', (() => {
    const html = renderReviewMarkdown(
      '## 结论\n- **严重** `a<b>.ts` 有问题\n1. 第一\n2. 第二\n```ts\nconst x = "<raw>";\n```\n普通段落',
    );
    return (
      html.includes('<h3>结论</h3>') &&
      html.includes('<li><strong>严重</strong> <code>a&lt;b&gt;.ts</code> 有问题</li>') &&
      html.includes('<ol>\n<li>第一</li>\n<li>第二</li>\n</ol>') &&
      html.includes('<pre><code>const x = &quot;&lt;raw&gt;&quot;;</code></pre>') &&
      html.includes('<p>普通段落</p>') &&
      !html.includes('<b>')
    );
  })());

  check('renderReviewHtml：自包含页面，标题与范围转义', (() => {
    const page = renderReviewHtml({
      title: 'x"><script>',
      attemptId: 'a1',
      fromRef: 'main',
      toRef: 'feat',
      generatedAt: '2026/7/30 12:00:00',
      text: '一切正常',
    });
    return (
      page.startsWith('<!DOCTYPE html>') &&
      page.includes('x&quot;&gt;&lt;script&gt;') &&
      page.includes('main → feat') &&
      !page.includes('<script>')
    );
  })());

  check('parseOcrReview：无分隔符时返回 null（回退扁平渲染）', (() => {
    return parseOcrReview('## 结论\n- ok') === null;
  })());

  check('parseOcrReview：解析 summary / 意见 / 类别严重度', (() => {
    const parsed = parseOcrReview(
      [
        '[ocr] Summary: 2 file(s) reviewed, 1 comment(s), ~1234 token(s) used, 12s elapsed',
        '─── src/a/b.js:10-12 ───',
        '[bug · high] 这里有问题',
        '',
        '正文说明',
        '─── src/c/d.vue:5 ───',
        '[performance · low] 性能建议',
      ].join('\n'),
    );
    return (
      parsed !== null &&
      parsed.summary === '2 file(s) reviewed, 1 comment(s), ~1234 token(s) used, 12s elapsed' &&
      parsed.intro === '' &&
      parsed.findings.length === 2 &&
      parsed.findings[0]!.file === 'src/a/b.js' &&
      parsed.findings[0]!.lines === '10-12' &&
      parsed.findings[0]!.category === 'bug' &&
      parsed.findings[0]!.severity === 'high' &&
      parsed.findings[0]!.body.includes('这里有问题') &&
      parsed.findings[0]!.body.includes('正文说明') &&
      parsed.findings[1]!.lines === '5'
    );
  })());

  check('renderReviewHtml：结构化渲染为分级卡片 + diff 高亮 + 转义', (() => {
    const page = renderReviewHtml({
      title: 't',
      attemptId: 'a1',
      generatedAt: '2026/7/30 12:00:00',
      text: [
        '[ocr] Summary: 2 file(s) reviewed, 1 comment(s), ~1234 token(s) used, 12s elapsed',
        '─── src/a/b.js:10-12 ───',
        '[bug · high] 这里有 <b> 问题',
        '',
        '- const a = 1;',
        '+ const a = 2;',
      ].join('\n'),
    });
    return (
      page.includes('共 1 条审查意见') &&
      page.includes('sev sev-high') &&
      page.includes('高危 × 1') &&
      page.includes('src/a/b.js') &&
      page.includes(':10-12') &&
      page.includes('&lt;b&gt;') &&
      !page.includes('<b> 问题') &&
      page.includes('<span class="dl del">- const a = 1;</span>') &&
      page.includes('<span class="dl add">+ const a = 2;</span>') &&
      !page.includes('<li>const a = 1') && // diff 行不得被当成 markdown 列表
      page.includes('<b>2</b> 审查文件')
    );
  })());

  check('isAllPass：有意见 false / 0 comment(s) 或空 findings true / 自由文本 false', (() => {
    const withFindings = [
      '[ocr] Summary: 1 file(s) reviewed, 1 comment(s), 3s elapsed',
      '─── src/a.js:1 ───',
      '[bug · high] 有问题',
    ].join('\n');
    const zeroComments = '[ocr] Summary: 3 file(s) reviewed, 0 comment(s), ~500 token(s) used, 8s elapsed';
    return (
      isAllPass(withFindings) === false &&
      isAllPass(zeroComments) === true &&
      isAllPass('一切正常') === false &&
      isAllPass('有 10 comment(s) 待处理') === false
    );
  })());

  check('renderReviewHtml：全通过时渲染绿色 hero + 庆祝横幅', (() => {
    const page = renderReviewHtml({
      title: 't',
      attemptId: 'a1',
      generatedAt: '2026/7/30 12:00:00',
      text: '[ocr] Summary: 2 file(s) reviewed, 0 comment(s), ~800 token(s) used, 6s elapsed',
    });
    return (
      page.includes('<header class="hero pass">') &&
      page.includes('AI 代码审查 · 全部通过') &&
      page.includes('class="pass-banner"') &&
      page.includes('审查全部通过') &&
      page.includes('<b>0</b> 意见数') &&
      !page.includes('class="finding') // 无意见卡片
    );
  })());

  check('renderReviewHtml：有意见时不出现庆祝横幅', (() => {
    const page = renderReviewHtml({
      title: 't',
      attemptId: 'a1',
      generatedAt: '2026/7/30 12:00:00',
      text: ['─── src/a.js:1 ───', '[bug · low] 小问题'].join('\n'),
    });
    return !page.includes('class="pass-banner"') && !page.includes('<header class="hero pass">');
  })());

  // ---------- AI 审查：报告静态服务 ----------
  await checkAsync('report-server：服务 reviews 目录 html / 拒绝路径穿越与非 html', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-report-'));
    const name = writeReviewReport(
      { title: '测试任务', attemptId: 'att-9', generatedAt: '2026/7/30 12:00:00', text: '## 结论\n- ok' },
      tmp,
    );
    const server = await startReportServer(tmp, 'http://127.0.0.1:7964');
    try {
      assert.match(name, /^review-.*-att-9-\d+\.html$/);
      assert.ok(server.baseUrl.startsWith('http://127.0.0.1:'));
      const ok = await fetch(`${server.baseUrl}/${name}`);
      const body = await ok.text();
      assert.equal(ok.status, 200);
      assert.match(ok.headers.get('content-type') || '', /text\/html/);
      assert.ok(body.includes('测试任务') && body.includes('<h3>结论</h3>'));
      for (const bad of ['/../etc/passwd', '/foo.txt', '/a%2f..%2fb.html', '/nope.html']) {
        const res = await fetch(`${server.baseUrl}${bad}`);
        assert.equal(res.status, 404, bad);
      }
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- AI 审查：attempt 目录解析 ----------
  await checkAsync('resolveReviewTarget：workspace 仓库目录优先 / 原仓库兜底 / 全失败报错', async () => {
    const { execFileSync } = await import('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-resolve-'));
    const wsRepo = path.join(tmp, 'ws', 'myrepo');
    const origRepo = path.join(tmp, 'orig');
    fs.mkdirSync(wsRepo, { recursive: true });
    fs.mkdirSync(origRepo, { recursive: true });
    execFileSync('git', ['init'], { cwd: wsRepo, stdio: 'ignore' });
    execFileSync('git', ['init'], { cwd: origRepo, stdio: 'ignore' });
    const routes: Record<string, unknown> = {};
    const server = http.createServer((req, res) => {
      const body = routes[req.url || ''];
      if (body !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: body }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // container_ref + agent_working_dir 命中最优先
      routes['/api/task-attempts/a1'] = { container_ref: path.join(tmp, 'ws'), agent_working_dir: 'myrepo', branch: 'er/x' };
      routes['/api/task-attempts/a1/repos'] = [{ path: origRepo, name: 'myrepo', target_branch: 'dev' }];
      const t1 = await resolveReviewTarget(base, 'a1');
      assert.equal(t1.repoDir, wsRepo);
      assert.equal(t1.fromRef, 'dev');
      assert.equal(t1.toRef, 'er/x');
      // workspace 目录不存在 → 兜底原始仓库 path
      routes['/api/task-attempts/a2'] = { container_ref: path.join(tmp, 'gone'), agent_working_dir: null, branch: 'main' };
      routes['/api/task-attempts/a2/repos'] = [{ path: origRepo, name: 'myrepo', target_branch: 'main' }];
      const t2 = await resolveReviewTarget(base, 'a2');
      assert.equal(t2.repoDir, origRepo);
      // 全部候选不可用 → 中文报错
      routes['/api/task-attempts/a3'] = { container_ref: null, agent_working_dir: null, branch: 'main' };
      routes['/api/task-attempts/a3/repos'] = [];
      await assert.rejects(() => resolveReviewTarget(base, 'a3'), /无法定位/);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 闸门 batchKey：create 可批量，start/approve/delete 始终逐次确认 ----------
  await checkAsync('闸门 batchKey：create 可批量，start/approve/delete 始终逐次确认', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-batchkey-'));
    const fakeMcp = {
      connected: true,
      tools: [
        { name: 'create_task', description: '', inputSchema: { type: 'object', properties: {} } },
        { name: 'start_workspace', description: '', inputSchema: { type: 'object', properties: {} } },
        { name: 'approve', description: '', inputSchema: { type: 'object', properties: {} } },
        { name: 'delete_task', description: '', inputSchema: { type: 'object', properties: {} } },
      ],
      callTool: async () => '{"success":true}',
    } as unknown as KanbanMcp;
    const seen: Array<string | undefined> = [];
    const { handlers } = buildTools({
      mcp: fakeMcp,
      kanbanUrl: 'http://localhost:1',
      confirm: async (req) => {
        seen.push(req.batchKey);
        return 'once';
      },
      registry: new SourceRegistry(tmp),
      auditHome: tmp,
    });
    await handlers.get('kanban_create_task')!({ title: 't' });
    await handlers.get('kanban_start_workspace')!({ task_id: 'x' });
    await handlers.get('kanban_approve')!({ approval_id: 'a' });
    await handlers.get('kanban_delete_task')!({ task_id: 'x' });
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.deepEqual(seen, ['kanban:create_task', undefined, undefined, undefined]);
  });

  // ---------- SessionRouter.busy：队列清理生效 ----------
  await checkAsync('SessionRouter.busy：任务完成后恢复空闲（修复清理失效导致的永真）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-busy-'));
    const cfg: AgentConfig = {
      llmBaseUrl: 'http://localhost:1/v1',
      llmApiKey: 'sk-x',
      llmModel: 'm',
      mcpCommand: 'npx',
      mcpArgs: [],
      kanbanUrl: 'http://localhost:1',
      kanbanProjectId: '',
      kanbanRepoId: '',
      kanbanIteration: '',
    };
    const router = new SessionRouter(cfg, null, false, new MemoryStore(tmp));
    assert.equal(router.busy('u1'), false);
    let release!: () => void;
    const p = router.enqueue(
      'u1',
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    assert.equal(router.busy('u1'), true);
    await new Promise((r) => setImmediate(r)); // 等 work 进入执行态（release 被赋值）
    release();
    await p;
    await new Promise((r) => setImmediate(r)); // 等 finally 清理微任务
    assert.equal(router.busy('u1'), false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------- injectSystemNote：轮边界注入 ----------
  await checkAsync('injectSystemNote：缓存到轮边界注入，不直接打断历史', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-note-'));
    const cfg: AgentConfig = {
      llmBaseUrl: 'http://localhost:1/v1', // 不可达：handleUserMessage 预期快速失败
      llmApiKey: 'sk-x',
      llmModel: 'm',
      mcpCommand: 'npx',
      mcpArgs: [],
      kanbanUrl: 'http://localhost:1',
      kanbanProjectId: '',
      kanbanRepoId: '',
      kanbanIteration: '',
    };
    const session = new AgentSession(cfg, null, false, { userId: 'u1', memory: new MemoryStore(tmp) });
    const msgs = () => (session as unknown as { messages: ChatMessage[] }).messages;
    session.injectSystemNote('后台事件-1');
    assert.equal(msgs().length, 1); // 只有 system prompt，未直接插入
    try {
      await session.handleUserMessage('hi');
    } catch {
      /* LLM 不可达，预期失败 */
    }
    // 失败的用户消息被弹出；note 已在轮边界注入到 system prompt 之后
    assert.equal(msgs().length, 2);
    assert.equal(msgs()[1]!.role, 'system');
    assert.equal(msgs()[1]!.content, '后台事件-1');
    try {
      await session.handleUserMessage('hi2');
    } catch {
      /* 同上 */
    }
    assert.equal(msgs().filter((m) => m.content === '后台事件-1').length, 1); // 不重复注入
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------- KanbanWatcher：推送失败不推进快照 ----------
  await checkAsync('KanbanWatcher：推送失败不推进快照，恢复后重投同一事件且不重复', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-watch-'));
    let taskStatus = 'inprogress';
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url.startsWith('/api/tasks?')) return json([{ id: 't1', title: '任务1', status: taskStatus }]);
      if (url.startsWith('/api/task-attempts')) return json([]);
      if (url.startsWith('/api/tasks/')) return json({ last_attempt_summary: '摘要' });
      if (url.startsWith('/api/approvals')) return json([]);
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const events: WatchEvent[] = [];
      let failNext = false;
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        notify: async (e) => {
          if (failNext) throw new Error('feishu down');
          events.push(e);
        },
      });
      const tick = (watcher as unknown as { tick: () => Promise<void> }).tick.bind(watcher);
      await tick(); // 基线，不通知
      assert.equal(events.length, 0);
      taskStatus = 'done';
      failNext = true;
      await tick(); // 推送失败 → 快照不推进，事件不丢
      assert.equal(events.length, 0);
      failNext = false;
      await tick(); // 恢复后同一事件重投
      assert.equal(events.length, 1);
      assert.equal(events[0]!.kind, 'done');
      await tick(); // 快照已推进，不再重复
      assert.equal(events.length, 1);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- fetchHealth：2xx + kanban 信封才算健康 ----------
  await checkAsync('fetchHealth：404 / HTML 占端口不再误判为「看板已在运行」', async () => {
    const mk = async (handler: http.RequestListener) => {
      const s = http.createServer(handler);
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
    };
    const close = async (s: http.Server) => {
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    };
    const kanban = await mk((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"success":true,"data":"OK","error_data":null,"message":null}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    assert.equal(await fetchHealth(kanban.url, 1500), true);
    await close(kanban.s);
    const html = await mk((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html></html>');
    });
    assert.equal(await fetchHealth(html.url, 1500), false);
    await close(html.s);
    const notFound = await mk((_req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    assert.equal(await fetchHealth(notFound.url, 1500), false);
    await close(notFound.s);
  });

  // ---------- npx 包规格：kanban 跟随最新版 / ocr 钉版本，env 均可覆盖 ----------
  check('npx 包规格默认值且 env 可覆盖', (() => {
    return (
      kanbanPackageSpec({}) === 'helios-kanban@latest' &&
      kanbanPackageSpec({ HELIOS_KANBAN_PACKAGE: 'helios-kanban@0.1.36' }) === 'helios-kanban@0.1.36' &&
      ocrPackageSpec({}).includes('open-code-review@') &&
      !ocrPackageSpec({}).endsWith('@latest') &&
      ocrPackageSpec({ OCR_PACKAGE: 'x@1' }) === 'x@1'
    );
  })());

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
