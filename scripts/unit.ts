// Unit tests: pure logic only — no LLM, no kanban, no network. Run: npm test

import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import {
  classifyHk,
  classifyLark,
  classifyMcp,
  isBatchable,
  looksLikeStrongFailure,
  withBatchApproval,
  DENIED_MESSAGE,
  NO_GATE_MESSAGE,
  type ConfirmRequest,
} from '../src/guard';
import {
  ConfirmationManager,
  buildConfirmCard,
  buildResolvedCard,
  CONFIRM_YES_RE,
  CONFIRM_BATCH_RE,
  CONFIRM_NO_RE,
  isConfirmWord,
  kindLabel,
} from '../src/confirm';
import { sanitizeToolPairs, trimHistory, runAgentTurn, MAX_HISTORY_MESSAGES } from '../src/llm';
import { createAccessChecker, FeishuChannel, parsePostContent, splitText } from '../src/channels/feishu';
import { extractSourceUrls, SourceRegistry } from '../src/source-registry';
import { MemoryStore } from '../src/memory';
import { resolveUnderRoot, runRepoFs } from '../src/repo-fs';
import { loadEnvFiles, writeEnvFile } from '../src/config';
import { buildTools } from '../src/tools';
import { parseFrontmatter, loadSkillDigests, readSkillDoc, renderSkillsBlock, userSkillsDir, validateSkills, buildSystemPrompt } from '../src/prompt';
import { auditLog } from '../src/audit';
import { SessionRouter } from '../src/session-router';
import { AgentSession } from '../src/session';
import type { AgentConfig } from '../src/types';
import type { KanbanMcp } from '../src/kanban/mcp';
import { compareVersions, checkForUpdate, promptVersionUpdate, CHANGELOG_URL, type DistTags } from '../src/update-check';
import { friendlyLlmError } from '../src/llm-error';
import { diagnoseMcpFailure } from '../src/kanban/mcp';
import { buildWatchEventCard, isLoopbackUrl, KanbanWatcher, type WatchEvent } from '../src/kanban/watcher';
import { apiGet, apiPost, taskPageUrl, attemptDiffUrl, pickLatestAttempt, sortTaskAttempts } from '../src/kanban/http';
import { McpSupervisor } from '../src/bot/supervisor';
import { WsAlerter } from '../src/bot/ws-alerter';
import { ensureKanbanRunning, fetchHealth } from '../src/kanban/kanban-ensure';
import { minimalChildEnv } from '../src/proc-env';
import {
  checkCurl,
  checkHkDeps,
  checkJq,
  checkLarkCli,
  checkLarkCliStatus,
  probeLarkCliAuth,
  kanbanPackageSpec,
  ocrPackageSpec,
  LARK_CLI_AUTH_HINT,
} from '../src/deps';
import { buildOcrEnv, findOcrCommand, resolveReviewTarget, sanitizeCliOutput } from '../src/kanban/ai-review';
import { isAllPass, parseOcrReview, renderReviewHtml, renderReviewMarkdown, writeReviewReport } from '../src/review-report';
import { startReportServer, newReportToken } from '../src/report-server';
import { summarizeForChat, writeSummaryReports } from '../src/report';
import {
  parseCommand,
  buildStatusLines,
  buildToolsLines,
  buildSkillsLines,
  plainPaint,
  confirmStateText,
  confirmRevokedText,
  llmFailureParts,
  CLEARED_TEXT,
} from '../src/commands';
import { renderReply, printBanner, MCP_FALLBACK_TEXT } from '../src/ui';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { WorkSummaryData } from '../src/kanban/summary';
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
  check('classifyHk fail-closed：未知命令/未知子命令一律判写，已知读命令仍放行', (() => {
    return (
      classifyHk(['frobnicate']) === 'write' && // 未知命令（此前默认 read）
      classifyHk(['tasks', 'frobnicate']) === 'write' && // tasks 未知子命令
      classifyHk(['tasks']) === 'write' && // tasks 无子命令（未知）
      classifyHk(['projects', 'frobnicate']) === 'write' && // projects 未知子命令
      classifyHk(['projects', 'update', 'p1']) === 'write' &&
      classifyHk(['projects', 'create', 'n']) === 'write' &&
      classifyHk(['projects']) === 'read' && // projects 无子命令 = 列表
      classifyHk(['tasks', 'list']) === 'read' &&
      classifyHk(['tasks', 'get', 't1']) === 'read' &&
      ['health', 'info', 'repos', 'branches', 'status', 'workspaces', 'tags', 'approvals'].every(
        (c) => classifyHk([c]) === 'read',
      )
    );
  })());
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

  // ---------- 来源查重：跨实例写盘前合并（mergeFromDisk） ----------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-regmerge-'));
    const a = new SourceRegistry(tmp);
    const b = new SourceRegistry(tmp);
    a.record('u1', 'https://a.feishu.cn/docx/1', { taskId: 't-1', title: 'T1', createdAt: 'x' });
    b.record('u1', 'https://a.feishu.cn/docx/2', { taskId: 't-2', title: 'T2', createdAt: 'x' });
    const onDisk = new SourceRegistry(tmp);
    check(
      'SourceRegistry 跨实例合并：两个实例各写的 key 都在盘上',
      onDisk.lookup('u1', 'https://a.feishu.cn/docx/1')?.taskId === 't-1' &&
        onDisk.lookup('u1', 'https://a.feishu.cn/docx/2')?.taskId === 't-2',
    );
    a.remove('u1', 'https://a.feishu.cn/docx/1');
    const after = new SourceRegistry(tmp);
    check(
      'SourceRegistry 跨实例合并：A 删除不复活且不波及 B 的 key',
      after.lookup('u1', 'https://a.feishu.cn/docx/1') === undefined &&
        after.lookup('u1', 'https://a.feishu.cn/docx/2')?.taskId === 't-2',
    );
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

  // ---------- 记忆：变更日志语义（跨实例合并且删除不复活） ----------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-memmerge-'));
    const a = new MemoryStore(tmp);
    a.setFact('u1', 'ka', '1');
    const b = new MemoryStore(tmp); // B 此时已看到 ka
    b.setFact('u1', 'kb', '2');
    a.deleteFact('u1', 'ka');
    // B 内存陈旧（仍持有 ka），再写别的 key 不得复活 ka
    b.setFact('u1', 'kc', '3');
    const fresh = new MemoryStore(tmp);
    check(
      'MemoryStore 变更日志：跨实例写入合并，陈旧实例不覆盖、删除不复活',
      fresh.getFact('u1', 'ka') === undefined &&
        fresh.getFact('u1', 'kb') === '2' &&
        fresh.getFact('u1', 'kc') === '3',
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  await checkAsync('MemoryStore.persist：目录不可写时容错不抛出，内存态仍可用', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-memro-'));
    fs.writeFileSync(path.join(tmp, 'blocker'), 'x'); // 占住路径，使 mkdir 必然 ENOTDIR
    const mem = new MemoryStore(path.join(tmp, 'blocker', 'sub'));
    mem.setFact('u1', 'k', 'v'); // persist 内部写盘失败，但不得抛出
    mem.addNote('u1', 'n1');
    assert.equal(mem.getFact('u1', 'k'), 'v');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------- memory 写工具过确认闸门：无通道/拒绝不落盘，批准才写入 ----------
  await checkAsync('memory 闸门：无 confirm 通道拒绝且不落盘，memory_get 只读免闸门', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-memgate-'));
    try {
      const mem = new MemoryStore(tmp);
      const { handlers } = buildTools({
        mcp: null,
        kanbanUrl: 'http://localhost:1',
        memory: mem,
        userId: 'u1',
        registry: new SourceRegistry(tmp),
        auditHome: tmp,
      });
      const r = await handlers.get('memory_set')!({ key: 'k', value: 'v' });
      assert.equal(r, NO_GATE_MESSAGE);
      assert.equal(mem.getFact('u1', 'k'), undefined);
      assert.equal(new MemoryStore(tmp).getFact('u1', 'k'), undefined); // 盘上也没有
      // memory_get 只读：无 confirm 通道仍可用
      const g = JSON.parse(await handlers.get('memory_get')!({}));
      assert.deepEqual(g.facts, {});
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('memory 闸门：拒绝不落盘，批准才写入；kind=memory 且无 batchKey', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-memgate2-'));
    try {
      const mem = new MemoryStore(tmp);
      const seen: Array<{ kind: string; batchKey: string | undefined }> = [];
      const denying = buildTools({
        mcp: null,
        kanbanUrl: 'http://localhost:1',
        memory: mem,
        userId: 'u1',
        confirm: async (req) => {
          seen.push({ kind: req.kind, batchKey: req.batchKey });
          return false;
        },
        registry: new SourceRegistry(tmp),
        auditHome: tmp,
      });
      const r1 = await denying.handlers.get('memory_set')!({ key: 'k', value: 'v' });
      const r2 = await denying.handlers.get('memory_delete')!({ key: 'k' });
      const r3 = await denying.handlers.get('memory_note')!({ text: 'n' });
      for (const r of [r1, r2, r3]) assert.equal(r, DENIED_MESSAGE);
      assert.equal(mem.getFact('u1', 'k'), undefined);
      assert.equal(new MemoryStore(tmp).getUser('u1').notes.length, 0);
      // 记忆永不批量免问：三次都过闸门且不带 batchKey
      assert.equal(seen.length, 3);
      assert.ok(seen.every((s) => s.kind === 'memory' && s.batchKey === undefined));

      const approving = buildTools({
        mcp: null,
        kanbanUrl: 'http://localhost:1',
        memory: mem,
        userId: 'u1',
        confirm: async () => 'once',
        registry: new SourceRegistry(tmp),
        auditHome: tmp,
      });
      const ok = JSON.parse(await approving.handlers.get('memory_set')!({ key: 'k', value: 'v' }));
      assert.equal(ok.ok, true);
      assert.equal(new MemoryStore(tmp).getFact('u1', 'k'), 'v'); // 落盘
      const okDel = JSON.parse(await approving.handlers.get('memory_delete')!({ key: 'k' }));
      assert.equal(okDel.ok, true);
      assert.equal(new MemoryStore(tmp).getFact('u1', 'k'), undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

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
    check('.env 原子写无 tmp 残留', fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp')).length === 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---------- loadEnvFiles：cwd .env 高危键不生效，非受限键仍覆盖 ----------
  await checkAsync('loadEnvFiles：cwd .env 受限键（LLM/飞书凭证/白名单）被忽略，非受限键仍生效', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-envhome-'));
    const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-envcwd-'));
    fs.writeFileSync(path.join(tmpHome, '.env'), 'LLM_API_KEY=home-key\nLLM_BASE_URL=https://home\n');
    fs.writeFileSync(
      path.join(tmpCwd, '.env'),
      'LLM_API_KEY=evil-key\nLLM_BASE_URL=https://evil\nFEISHU_APP_SECRET=evil-secret\nHTA_UNIT_NONRESTRICTED=from-cwd\n',
    );
    const ENV_KEYS = ['HELIOS_TASK_AGENT_HOME', 'LLM_API_KEY', 'LLM_BASE_URL', 'FEISHU_APP_SECRET', 'HTA_UNIT_NONRESTRICTED'];
    const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
    const prevCwd = process.cwd();
    // 静默丢弃提示（[config] cwd .env 中的高危键已被忽略…），不打断测试输出
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      process.env.HELIOS_TASK_AGENT_HOME = tmpHome;
      // shell 已提供的受限键：cwd 不得覆盖，最终须等于 home 值（home 最后 override 加载）
      process.env.LLM_API_KEY = 'shell-key';
      process.chdir(tmpCwd);
      // macOS 上 os.tmpdir()（/var/…）chdir 后 process.cwd() 会解析为 /private/var/…，以 cwd 为准
      const cwdEnv = path.join(process.cwd(), '.env');
      const { primaryWritePath, loaded } = loadEnvFiles();
      assert.equal(process.env.LLM_API_KEY, 'home-key');
      assert.equal(process.env.LLM_BASE_URL, 'https://home');
      assert.notEqual(process.env.FEISHU_APP_SECRET, 'evil-secret');
      assert.equal(process.env.HTA_UNIT_NONRESTRICTED, 'from-cwd');
      assert.equal(primaryWritePath, cwdEnv);
      assert.ok(loaded.some((p) => path.resolve(p) === path.resolve(cwdEnv)));
    } finally {
      console.warn = origWarn;
      process.chdir(prevCwd);
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

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
  check('friendlyLlmError：bot 通道不提不存在的 /config，首选 bot --reconfig，.env 手编为备选', (() => {
    const cliHint = friendlyLlmError('401 invalid api key', { channel: 'cli' }) || '';
    const botHint = friendlyLlmError('401 invalid api key', { channel: 'bot' }) || '';
    const defaultHint = friendlyLlmError('401 invalid api key') || '';
    const botNet = friendlyLlmError('fetch failed: ECONNREFUSED', { channel: 'bot' }) || '';
    return (
      cliHint.includes('/config') &&
      defaultHint.includes('/config') &&
      !botHint.includes('/config') &&
      botHint.includes('helios-task-agent bot --reconfig') &&
      botHint.includes('.env') && // 手编 .env 仍作为备选保留
      botNet.includes('helios-task-agent bot --reconfig') &&
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

  check('buildOcrEnv：LLM_API_KEY 等敏感变量不泄漏到 OCR 环境', (() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-ocrleak-'));
    const out = buildOcrEnv(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', model: 'm1' },
      { PATH: '/usr/bin', HOME: tmp, LLM_API_KEY: 'sk-leak', FEISHU_APP_SECRET: 'fs-leak', AWS_SECRET: 'aws-leak', OCR_DEBUG: '1' },
      tmp,
    );
    fs.rmSync(tmp, { recursive: true, force: true });
    return (
      !('LLM_API_KEY' in out) &&
      !('FEISHU_APP_SECRET' in out) &&
      !('AWS_SECRET' in out) &&
      out.OCR_DEBUG === '1' && // OCR_ 前缀显式放行
      out.PATH === '/usr/bin' &&
      out.OCR_LLM_TOKEN === 'sk-x' // 派生配置仍生效
    );
  })());

  // ---------- 子进程最小环境（proc-env） ----------
  check('minimalChildEnv：敏感变量不带入 / PATH、HOME 保留 / extra 显式生效且 undefined 被过滤', (() => {
    const base = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/tester',
      LLM_API_KEY: 'sk-leak',
      FEISHU_APP_SECRET: 'fs-leak',
      AWS_SECRET: 'aws-leak',
      LC_ALL: 'zh_CN.UTF-8',
    };
    const env = minimalChildEnv({ CUSTOM_FLAG: '1', DROP_ME: undefined, HOME: undefined }, base);
    return (
      env.PATH === '/usr/bin:/bin' &&
      !('HOME' in env) && // extra 里 undefined 可删除 base 的放行项
      !('LLM_API_KEY' in env) &&
      !('FEISHU_APP_SECRET' in env) &&
      !('AWS_SECRET' in env) &&
      env.LC_ALL === 'zh_CN.UTF-8' && // LC_* 前缀放行
      env.CUSTOM_FLAG === '1' &&
      !('DROP_ME' in env)
    );
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
      // 既有命名契约：token 在 attemptId 之前
      assert.match(name, /^review-.*-att-9-\d+\.html$/);
      // 文件名带 128-bit token（访问凭证），且符合服务端白名单正则（否则 404 服务不到）
      assert.match(name, /^review-.*-[0-9a-f]{32}-att-9-\d+\.html$/);
      assert.match(name, /^[\w.-]+\.html$/);
      assert.match(newReportToken(), /^[0-9a-f]{32}$/);
      assert.notEqual(newReportToken(), newReportToken());
      // 报告含代码 diff：写盘必须 0600
      assert.equal(fs.statSync(path.join(tmp, name)).mode & 0o777, 0o600);
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

  // ---------- KanbanWatcher：owners + notifyOwner 按 (事件, owner) 粒度追踪 ----------
  await checkAsync('KanbanWatcher：按 owner 粒度送达追踪，失败 owner 单独重投且不连累他人、不重复', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-watch-owner-'));
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
      const delivered: string[] = [];
      let failOwner2 = true;
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        owners: () => ['ou_1', 'ou_2'],
        notifyOwner: async (e, owner) => {
          if (owner === 'ou_2' && failOwner2) throw new Error('feishu down');
          delivered.push(`${e.kind}@${owner}`);
        },
        // owners/notifyOwner 齐备时 notify 不应被调用
        notify: async () => {
          throw new Error('不应走整批回退');
        },
      });
      const tick = (watcher as unknown as { tick: () => Promise<void> }).tick.bind(watcher);
      await tick(); // 基线，不通知
      assert.equal(delivered.length, 0);
      taskStatus = 'done';
      await tick(); // ou_1 送达，ou_2 失败 → 仅 (事件, ou_2) 记入待重投
      assert.deepEqual(delivered, ['done@ou_1']);
      failOwner2 = false;
      await tick(); // 恢复后仅重投 ou_2，ou_1 不重复
      assert.deepEqual(delivered, ['done@ou_1', 'done@ou_2']);
      await tick(); // 全员送达后不再重复
      assert.equal(delivered.length, 2);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- kanban/http：统一信封解析 ----------
  await checkAsync('kanban http：信封成功取 data、失败抛 message、无信封宽松回退、HTTP 错误抛状态码', async () => {
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (payload: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url === '/api/ok') return json({ success: true, data: { v: 1 } });
      if (url === '/api/fail') return json({ success: false, message: 'boom' });
      if (url === '/api/envelope-less-data') return json({ data: [1, 2] }); // 无 success 字段：宽松取 data
      if (url === '/api/raw') return json([3, 4]); // 无信封裸数据：原样返回
      if (url === '/api/echo' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => json({ success: true, data: JSON.parse(body) }));
        return;
      }
      res.writeHead(500);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.deepEqual(await apiGet(base, '/ok'), { v: 1 });
      await assert.rejects(() => apiGet(base, '/fail'), /boom/);
      assert.deepEqual(await apiGet(base, '/envelope-less-data'), [1, 2]);
      assert.deepEqual(await apiGet(base, '/raw'), [3, 4]);
      await assert.rejects(() => apiGet(base, '/missing'), /HTTP 500/);
      assert.deepEqual(await apiPost(base, '/echo', { a: 'b' }), { a: 'b' });
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });

  // ---------- kanban/http：URL 拼接与最新 attempt ----------
  check('kanban http：任务页/diff URL 拼接去尾斜杠，最新 attempt 优先未归档按创建时间', (() => {
    const page = taskPageUrl('http://k:7964/', 'p1', 't1');
    const attempts = [
      { id: 'a-new-archived', archived: true, created_at: '2026-03-01' },
      { id: 'a-old', created_at: '2026-01-01' },
      { id: 'a-new', created_at: '2026-02-01' },
      { id: null }, // 无效行被过滤
    ];
    const latest = pickLatestAttempt(attempts);
    return (
      page === 'http://k:7964/local-projects/p1/tasks/t1' &&
      attemptDiffUrl(page, 'a1') === `${page}/attempts/a1?view=diffs` &&
      latest?.id === 'a-new' && // 有未归档时忽略归档行（即使更新）
      pickLatestAttempt([{ id: 'a-arch', archived: true }])?.id === 'a-arch' && // 全归档回退归档池
      pickLatestAttempt('not-array') === null &&
      pickLatestAttempt([]) === null &&
      sortTaskAttempts(attempts).map((a) => a.id).join(',') === 'a-old,a-new'
    );
  })());

  // ---------- McpSupervisor：失败阈值 / 降级与恢复 ----------
  await checkAsync('McpSupervisor：连续失败达阈值才降级，恢复后回调切回', async () => {
    let pingOk = false;
    const mcp = {
      tools: [],
      ping: async () => {
        if (!pingOk) throw new Error('down');
      },
      reconnect: async () => {},
    } as unknown as KanbanMcp;
    let lost = 0;
    let recovered = 0;
    const sup = new McpSupervisor({
      mcp,
      initiallyAlive: true,
      onLost: () => lost++,
      onRecovered: () => recovered++,
    });
    await sup.tick(); // 第 1 次失败：未达阈值，不降级
    assert.equal(lost, 0);
    assert.equal(sup.isAlive, true);
    await sup.tick(); // 第 2 次失败：达阈值降级（failures<=3，本轮即触发重连尝试）
    assert.equal(lost, 1);
    assert.equal(sup.isAlive, false);
    await sup.tick(); // 已降级：onLost 不重复
    assert.equal(lost, 1);
    pingOk = true;
    await sup.tick(); // 恢复：切回并回调一次
    assert.equal(recovered, 1);
    assert.equal(sup.isAlive, true);
    await sup.tick(); // 健康期：无重复回调
    assert.equal(recovered, 1);
    assert.equal(lost, 1);
  });

  // ---------- McpSupervisor：有轮次在跑不重连；轮次归零后补重连 ----------
  await checkAsync('McpSupervisor：in-flight 轮次期间跳过重连，轮次结束后下一轮重连', async () => {
    let reconnectCalls = 0;
    const mcp = {
      tools: [],
      ping: async () => {
        throw new Error('down');
      },
      reconnect: async () => {
        reconnectCalls++;
      },
    } as unknown as KanbanMcp;
    const sup = new McpSupervisor({ mcp, initiallyAlive: true, failThreshold: 1 });
    await sup.enterTurn();
    await sup.tick(); // 达阈值降级，但有轮次在跑 → 不重连（close 会杀 in-flight 调用）
    assert.equal(reconnectCalls, 0);
    await sup.tick(); // 轮次仍在：退避节奏命中也不重连
    assert.equal(reconnectCalls, 0);
    sup.exitTurn();
    await sup.tick(); // 轮次归零：补重连
    assert.equal(reconnectCalls, 1);
  });

  // ---------- McpSupervisor：重连期间新轮次等待重连结束（竞态关闭） ----------
  await checkAsync('McpSupervisor：重连进行中 enterTurn 阻塞，重连结束后才放行', async () => {
    let releaseReconnect!: () => void;
    let reconnectCalls = 0;
    const mcp = {
      tools: [],
      ping: async () => {
        throw new Error('down');
      },
      reconnect: async () => {
        reconnectCalls++;
        await new Promise<void>((r) => (releaseReconnect = r));
      },
    } as unknown as KanbanMcp;
    const sup = new McpSupervisor({ mcp, initiallyAlive: false });
    const tickDone = sup.tick(); // 失败 → 触发重连（挂起，直到 releaseReconnect）
    for (let i = 0; i < 10; i++) await Promise.resolve(); // 让 tick 推进到 reconnect 内
    assert.equal(reconnectCalls, 1);
    let entered = false;
    const entering = sup.enterTurn().then(() => {
      entered = true;
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(entered, false); // 重连未完成：新轮次不得开始（否则 close 杀 in-flight）
    releaseReconnect();
    await tickDone;
    await entering;
    assert.equal(entered, true);
    assert.equal(sup.turnCount, 1);
    sup.exitTurn();
    assert.equal(sup.turnCount, 0);
  });

  // ---------- WsAlerter：宽限期内恢复静默，超时断线才告警 ----------
  await checkAsync('WsAlerter：快速抖动不通知；持续断线超时告警一次，恢复时补「已恢复」', async () => {
    const sent: string[] = [];
    const alerter = new WsAlerter({ graceMs: 30, notify: (t) => sent.push(t) });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // 快速抖动：宽限期内恢复 → 完全静默（刷屏场景）
    alerter.onState('reconnecting');
    alerter.onState('reconnected');
    await sleep(60);
    assert.equal(sent.length, 0);

    // 持续断线超过宽限期 → 告警一次
    alerter.onState('reconnecting');
    await sleep(60);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes('断开超过'));
    // 断线期间 SDK 反复触发 reconnecting：不重复告警
    alerter.onState('reconnecting');
    await sleep(60);
    assert.equal(sent.length, 1);
    // 恢复：因告警过，补一条「已恢复」
    alerter.onState('reconnected');
    assert.equal(sent.length, 2);
    assert.ok(sent[1].includes('已恢复'));
    alerter.stop();
  });

  // ---------- WsAlerter：重连失败立即告警且只报一次 ----------
  await checkAsync('WsAlerter：failed 立即告警一次；failed 后的状态变化不再打扰', async () => {
    const sent: string[] = [];
    const alerter = new WsAlerter({ graceMs: 30, notify: (t) => sent.push(t) });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    alerter.onState('reconnecting'); // 宽限期计时中
    alerter.onState('failed'); // 取消宽限期，立即告警
    assert.equal(sent.length, 1);
    assert.ok(sent[0].includes('重连失败'));
    alerter.onState('failed'); // 重复 failed 不再报
    assert.equal(sent.length, 1);
    alerter.onState('reconnecting'); // 已判失败：不再起宽限期告警
    await sleep(60);
    assert.equal(sent.length, 1);
    alerter.stop();
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

  // ---------- ensureKanbanRunning：spawn 失败快速报错（child.on('error')） ----------
  await checkAsync('ensureKanbanRunning：npx 不可执行时快速失败，不白等 waitMs', async () => {
    // 先占后放一个确定空闲的端口
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const prevPath = process.env.PATH;
    // PATH 指向不存在目录 → spawn('npx') ENOENT（minimalChildEnv 从 process.env 取 PATH）
    process.env.PATH = path.join(os.tmpdir(), 'hta-nonexistent-dir-no-npx');
    const startedAt = Date.now();
    try {
      await assert.rejects(() => ensureKanbanRunning(`http://127.0.0.1:${port}`, { waitMs: 30000 }), /npx/);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 10_000, `spawn 失败应快速报错，实际耗时 ${elapsed}ms`);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  // ---------- ensureKanbanRunning：onSpawn 拉起即回调 + detached 进程组超时清理 ----------
  await checkAsync('ensureKanbanRunning：onSpawn 回调拿到 child，超时后进程组被清理', async () => {
    // 假 npx = 常驻脚本：忽略 -y 等参数直接 sleep，health 永不通，走超时路径。
    // （不能用系统二进制符号链接：GNU yes/sleep 会把 spawn 的 -y 当非法选项直接退出，Linux CI 上假 npx 秒退）
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-fakenpx-'));
    fs.writeFileSync(path.join(bin, 'npx'), '#!/bin/sh\nexec /bin/sleep 60\n', { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = bin;
    let spawned: import('child_process').ChildProcess | null = null;
    let groupAliveAtSpawn = false;
    try {
      await assert.rejects(
        () =>
          ensureKanbanRunning(`http://127.0.0.1:${port}`, {
            waitMs: 3000,
            onSpawn: (ch) => {
              spawned = ch;
              // detached: true → child 是进程组组长，拉起即刻负 pid 可探测到组
              try {
                process.kill(-ch.pid!, 0);
                groupAliveAtSpawn = true;
              } catch {
                groupAliveAtSpawn = false;
              }
            },
          }),
        /等待 helios-kanban 就绪超时/,
      );
      assert.ok(spawned, 'onSpawn 必须在等待就绪前回调');
      assert.ok(typeof spawned.pid === 'number' && groupAliveAtSpawn, 'child 应为独立进程组组长');
      // 超时路径 ensure 内部调 stopKanbanChild：组杀后不留孤儿
      assert.throws(() => process.kill(-spawned!.pid!, 0));
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  // ---------- hk.sh：tasks list --limit 非纯数字直接拒绝（jq 注入防护） ----------
  await checkAsync('hk.sh：tasks list --limit 注入串在 API 调用前报错退出', async () => {
    let jqOk = true;
    try {
      execFileSync('jq', ['--version'], { stdio: 'ignore' });
    } catch {
      jqOk = false;
    }
    assert.ok(jqOk, '本测试需要 jq（hk.sh 依赖）');
    const hk = path.resolve(__dirname, '..', 'skills', 'helios-kanban-remote', 'scripts', 'hk.sh');
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', [hk, 'tasks', 'list', '--limit', '1] + [env.X] | .[0:99'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HELIOS_KANBAN_PROJECT_ID: 'p-test', // 先过 project_id 检查；校验发生在 API 调用之前，无需真实看板
          HELIOS_KANBAN_URL: 'http://127.0.0.1:1',
        },
      });
    } catch (err) {
      const e = err as { status?: number | null; stderr?: string };
      code = e.status ?? -1;
      stderr = String(e.stderr || '');
    }
    assert.notEqual(code, 0, '非法 --limit 应非零退出');
    assert.match(stderr, /invalid --limit/);
  });

  // ---------- npx 包规格：kanban 与 ocr 均钉版本，env 均可覆盖 ----------
  check('npx 包规格默认值且 env 可覆盖', (() => {
    return (
      /^helios-kanban@\d+\.\d+\.\d+$/.test(kanbanPackageSpec({})) &&
      kanbanPackageSpec({ HELIOS_KANBAN_PACKAGE: 'helios-kanban@0.1.36' }) === 'helios-kanban@0.1.36' &&
      ocrPackageSpec({}).includes('open-code-review@') &&
      !ocrPackageSpec({}).endsWith('@latest') &&
      ocrPackageSpec({ OCR_PACKAGE: 'x@1' }) === 'x@1'
    );
  })());

  // ---------- deps：lark-cli 三态与 hk 降级链依赖探测（临时 PATH 注入假二进制，不依赖本机真实环境） ----------
  await checkAsync('deps：checkLarkCliStatus 三态 / probeLarkCliAuth 保守判失败 / checkHkDeps 缺失项', async () => {
    // 本环境直接 exec 新建 shebang 脚本会挂起，假命令一律用系统二进制的符号链接：
    // true = 退出 0 无输出（模拟「已安装但 auth status 输出异常」），false = 命令失败，
    // node 符号链接 + NODE_OPTIONS --require 让 auth status 输出指定 JSON（模拟已授权）。
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-deps-'));
    const prevPath = process.env.PATH;
    const prevNodeOptions = process.env.NODE_OPTIONS;
    const link = (name: string, target: string) => {
      const p = path.join(bin, name);
      if (fs.existsSync(p)) fs.rmSync(p);
      fs.symlinkSync(target, p);
    };
    try {
      // 空 PATH：全部 missing
      process.env.PATH = bin;
      assert.equal(checkLarkCli(), false);
      assert.equal(checkLarkCliStatus(), 'missing');
      assert.equal(checkJq(), false);
      assert.equal(checkCurl(), false);
      assert.deepEqual(checkHkDeps(), ['jq', 'curl']);
      // 已安装但 auth status 输出为空 → 保守判未授权（不误报可用）
      link('lark-cli', '/usr/bin/true');
      assert.equal(checkLarkCli(), true);
      assert.equal(checkLarkCliStatus(), 'unauthorized');
      // auth status 命令失败 → 同样保守判未授权
      link('lark-cli', '/usr/bin/false');
      assert.equal(probeLarkCliAuth(), 'unauthorized');
      // 已授权：auth status 输出 identities.available=true 的 JSON
      const probeJs = path.join(bin, 'probe.js');
      fs.writeFileSync(
        probeJs,
        'process.stdout.write(JSON.stringify({identities:{user:{available:true}}})+"\\n");process.exit(0);\n',
      );
      link('lark-cli', process.execPath);
      process.env.NODE_OPTIONS = `--require ${probeJs}`;
      assert.equal(checkLarkCliStatus(), 'ok');
      delete process.env.NODE_OPTIONS;
      // jq 装了、curl 没装 → 缺 curl
      link('jq', '/usr/bin/true');
      assert.equal(checkJq(), true);
      assert.deepEqual(checkHkDeps(), ['curl']);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prevNodeOptions;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  // ---------- banner：lark 三态与 hk 降级链状态写进文案 ----------
  await checkAsync('printBanner：lark 未授权/未安装与 hk 缺失（jq/curl）体现在文案', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-banner-'));
    const prevPath = process.env.PATH;
    const capture = (fn: () => void): string => {
      const out: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => out.push(args.map(String).join(' '));
      try {
        fn();
      } finally {
        console.log = origLog;
      }
      return out.join('\n');
    };
    const base = { version: '0.0.0', model: 'm', baseUrl: 'https://x', kanbanUrl: 'http://localhost:7964' };
    try {
      // lark 已安装未授权（true：--version 退出 0，auth status 无输出 → 保守判未授权）+ jq/curl 缺失 + MCP 掉线
      fs.symlinkSync('/usr/bin/true', path.join(bin, 'lark-cli'));
      process.env.PATH = bin;
      const unauth = capture(() => printBanner({ ...base, mcp: 'fail', mcpToolCount: 0, larkOk: true }));
      // banner 行内联精简指引（不重复 LARK_CLI_AUTH_HINT 全句，避免「未授权」出现两次）
      assert.ok(unauth.includes('lark-cli') && unauth.includes('未授权') && unauth.includes('lark-cli auth login'));
      assert.ok(unauth.includes('缺少 jq、curl') && unauth.includes('降级链不可用'));
      // lark 未安装（larkOk=false）→ 不探测授权，直接「未找到」
      const missing = capture(() => printBanner({ ...base, mcp: 'ok', mcpToolCount: 3, larkOk: false }));
      assert.ok(missing.includes('未找到') && !missing.includes('未授权'));
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  // ---------- /status 状态行：lark 三态与 hk 降级链 ----------
  await checkAsync('buildStatusLines：lark 未授权/未安装/ok 与 hk 缺失写入状态行', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-status-'));
    const prevPath = process.env.PATH;
    const prevNodeOptions = process.env.NODE_OPTIONS;
    const opts = { model: 'm', kanbanUrl: 'http://127.0.0.1:1', mcpOk: false, mcpToolCount: 0, mcpDownNote: 'MCP 不可用' };
    try {
      // 未授权：lark-cli = true（--version 退出 0；auth status 无输出 → 保守判未授权），PATH 无 jq/curl
      fs.symlinkSync('/usr/bin/true', path.join(bin, 'lark-cli'));
      process.env.PATH = bin;
      const unauth = (await buildStatusLines({ ...opts, larkOk: true }, plainPaint)).join('\n');
      assert.ok(unauth.includes('lark-cli: 未授权') && unauth.includes(LARK_CLI_AUTH_HINT));
      assert.ok(unauth.includes('hk_cli: 缺少 jq、curl'));
      assert.ok(unauth.includes('降级链不可用')); // MCP 掉线且 hk 缺依赖时必须警示
      const missing = (await buildStatusLines({ ...opts, larkOk: false }, plainPaint)).join('\n');
      assert.ok(missing.includes('lark-cli: 未安装'));
      // 已授权：node 符号链接 + NODE_OPTIONS --require 输出 available=true
      const probeJs = path.join(bin, 'probe.js');
      fs.writeFileSync(
        probeJs,
        'process.stdout.write(JSON.stringify({identities:{user:{available:true}}})+"\\n");process.exit(0);\n',
      );
      fs.rmSync(path.join(bin, 'lark-cli'));
      fs.symlinkSync(process.execPath, path.join(bin, 'lark-cli'));
      process.env.NODE_OPTIONS = `--require ${probeJs}`;
      const okLines = (await buildStatusLines({ ...opts, larkOk: true }, plainPaint)).join('\n');
      assert.ok(okLines.includes('lark-cli: ok'));
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prevNodeOptions;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  // ---------- 技能机制：frontmatter 解析 / 摘要 / 按需读取 / 契约校验 ----------
  await checkAsync('parseFrontmatter：标量 / 折叠块 / 列表', async () => {
    const { data, body } = parseFrontmatter(
      '---\nname: demo\ndescription: >-\n  first line\n  second line\nflags: |\n  a\n  b\ndigest_sections:\n  - Quick workflow\n  - Safety rules\n---\n\n# Body\n',
    );
    assert.equal(data.name, 'demo');
    assert.equal(data.description, 'first line second line');
    assert.equal(data.flags, 'a\nb');
    assert.deepEqual(data.digest_sections, ['Quick workflow', 'Safety rules']);
    assert.equal(body.trim(), '# Body');
    // 无 frontmatter 时原样返回
    const plain = parseFrontmatter('# just body\n');
    assert.deepEqual(plain.data, {});
    assert.equal(plain.body, '# just body\n');
  });

  await checkAsync('技能加载：description + digest_sections 声明的章节进入摘要', async () => {
    const digests = loadSkillDigests();
    assert.equal(digests.length >= 1, true);
    const hk = digests.find((s) => s.name === 'helios-kanban-remote');
    assert.ok(hk, 'helios-kanban-remote 应被扫描到');
    assert.ok(hk.description.includes('Helios Kanban'), 'description 应来自 frontmatter');
    assert.ok(hk.digest.includes('Quick workflow'), '摘要应含声明的章节');
    assert.ok(hk.digest.includes('Safety rules'), '摘要应含 Safety rules');
    assert.ok(!hk.digest.includes('Prerequisites'), '未声明的章节不进摘要');
  });

  await checkAsync('renderSkillsBlock：含指引与完整文档路径；readSkillDoc 按需读取', async () => {
    const block = renderSkillsBlock();
    assert.ok(block.includes('skill_doc'), '提示词应指引用 skill_doc 按需读取');
    assert.ok(block.includes('helios-kanban-remote'), '应包含已安装技能');
    const list = readSkillDoc('');
    assert.ok(list.includes('helios-kanban-remote'), '空 name 应列出技能');
    const full = readSkillDoc('helios-kanban-remote');
    assert.ok(full.includes('Prerequisites'), '全文读取应包含未注入摘要的章节');
    assert.ok(!full.includes('digest_sections'), '全文读取应剥离 frontmatter');
    assert.ok(readSkillDoc('no-such-skill').includes('未找到技能'));
    assert.ok(readSkillDoc('../etc').includes('非法技能名'), '路径穿越应被拒绝');
  });

  await checkAsync('validateSkills：包内技能契约全部健康', async () => {
    assert.deepEqual(validateSkills(), []);
  });

  await checkAsync('skill_doc 工具：注册且只读（无确认闸门）', async () => {
    const { openAiTools, handlers } = buildTools({
      mcp: null,
      kanbanUrl: 'http://127.0.0.1:1',
      // 不传 confirm：写操作应被阻止，但 skill_doc 是只读，不受影响
    });
    assert.ok(openAiTools.some((t) => t.function.name === 'skill_doc'), 'skill_doc 应注册');
    const out = await handlers.get('skill_doc')!({}, undefined);
    assert.ok(out.includes('helios-kanban-remote'), '省略 name 应返回技能清单');
  });

  // ---------- 批量判定唯一来源：归档/合并/推送/执行类永不批量 ----------
  check('isBatchable：delete/archive/merge/push/execute 等不批量，create/update 可批量', (() => {
    return (
      !isBatchable('archive_task') &&
      !isBatchable('merge_workspace') &&
      !isBatchable('push_changes') &&
      !isBatchable('execute_command') &&
      !isBatchable('delete_task') &&
      !isBatchable('stop_workspace') &&
      !isBatchable('approve') &&
      isBatchable('create_task') &&
      isBatchable('update_task')
    );
  })());

  await checkAsync('闸门 batchKey：kanban_archive_* 不产生 batchKey（同类免问不适用）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-nobatch-'));
    const fakeMcp = {
      connected: true,
      tools: [
        { name: 'archive_task', description: '', inputSchema: { type: 'object', properties: {} } },
        { name: 'create_task', description: '', inputSchema: { type: 'object', properties: {} } },
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
    await handlers.get('kanban_archive_task')!({ task_id: 'x' });
    await handlers.get('kanban_create_task')!({ title: 't' });
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.deepEqual(seen, [undefined, 'kanban:create_task']);
  });

  // ---------- 确认应答词表：两端共用同一份（并集） ----------
  check('确认词表：批准/免问/拒绝关键词条在列，随口应答不算批准', (() => {
    return (
      CONFIRM_YES_RE.test('确认') &&
      CONFIRM_YES_RE.test('批准') && // 原 CLI 缺这个词
      CONFIRM_YES_RE.test('执行') &&
      CONFIRM_YES_RE.test('y') &&
      CONFIRM_BATCH_RE.test('同类免问') &&
      CONFIRM_BATCH_RE.test('批量允许') &&
      CONFIRM_BATCH_RE.test('都允许') &&
      CONFIRM_BATCH_RE.test('以后都') &&
      !CONFIRM_BATCH_RE.test('都') && // 单字「都」随口误批准 10 分钟免问，已移除
      CONFIRM_BATCH_RE.test('免问') &&
      !CONFIRM_BATCH_RE.test('b') && // 单字母「b」随口误批准 10 分钟免问，已移除
      CONFIRM_NO_RE.test('取消') &&
      CONFIRM_NO_RE.test('拒绝') &&
      !CONFIRM_YES_RE.test('好') &&
      !CONFIRM_YES_RE.test('可以') &&
      !CONFIRM_YES_RE.test('批准一下') // 必须整词匹配
    );
  })());

  // ---------- isConfirmWord：无 pending 时的即时提示判定（排除单字母） ----------
  check('isConfirmWord：确认词命中，单字母 y/n/b 与随口应答不命中', (() => {
    return (
      isConfirmWord('确认') &&
      isConfirmWord(' 取消 ') &&
      isConfirmWord('yes') &&
      isConfirmWord('同类免问') &&
      !isConfirmWord('y') && // 单字母不排除会误伤正常对话
      !isConfirmWord('n') &&
      !isConfirmWord('b') &&
      !isConfirmWord('好') &&
      !isConfirmWord('帮我看看任务') &&
      !isConfirmWord('')
    );
  })());

  await checkAsync('确认管理器：bot 文本「批准」/「批量允许」同样生效', async () => {
    const mgr = new ConfirmationManager(async () => undefined);
    const p1 = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd' });
    assert.equal(mgr.resolveFromText('u1', '批准'), 'approved');
    assert.equal(await p1, 'once');
    const p2 = mgr.request('u1', { kind: 'kanban', summary: 's', detail: 'd', batchKey: 'k' });
    assert.equal(mgr.resolveFromText('u1', '批量允许'), 'approved_batch');
    assert.equal(await p2, 'batch');
  });

  // ---------- kind 枚举 → 用户可见中文 ----------
  check('kindLabel：hk/kanban→看板，lark→飞书，memory→记忆，未知回退原值', (() => {
    return (
      kindLabel('hk') === '看板' &&
      kindLabel('kanban') === '看板' &&
      kindLabel('lark') === '飞书' &&
      kindLabel('memory') === '记忆' &&
      kindLabel('something-else') === 'something-else'
    );
  })());

  // ---------- 报告静态服务：绑回环 / 多目录 / 远程看板不编造链接主机 ----------
  await checkAsync('report-server：默认绑回环；远程看板地址时链接主机退回绑定地址；多目录可服务', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-rsA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-rsB-'));
    fs.writeFileSync(path.join(dirB, 'work-summary-2026-07-31.html'), '<html>summary</html>');
    const local = await startReportServer(dirA, 'http://localhost:7964');
    const remote = await startReportServer([dirA, dirB], 'http://192.168.1.10:7964');
    try {
      assert.ok(local.baseUrl.startsWith('http://localhost:'), local.baseUrl);
      // 看板是远程地址而报告服务在本机：不得用看板主机名编造可达性，退回绑定地址
      assert.ok(remote.baseUrl.startsWith('http://127.0.0.1:'), remote.baseUrl);
      // 第二个目录（reports/）下的报告也可访问
      const res = await fetch(`${remote.baseUrl}/work-summary-2026-07-31.html`);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes('summary'));
      // 路径穿越仍然 404
      const bad = await fetch(`${remote.baseUrl}/../etc/passwd`);
      assert.equal(bad.status, 404);
    } finally {
      local.close();
      remote.close();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  // ---------- work_summary 摘要：bot 推 HTTP 链接，CLI 保留本机路径 ----------
  check('summarizeForChat：传 linkBaseUrl 输出 HTTP 链接，否则本机路径', (() => {
    const data = {
      scope: 'today',
      generatedAt: '2026-07-31T00:00:00Z',
      sinceLabel: '2026-07-31 今天',
      tasks: [],
      totals: { done: 1, inreview: 0, inprogress: 2, todo: 0, cancelled: 0, filesChanged: 3, additions: 10, deletions: 4 },
    } as unknown as WorkSummaryData;
    const paths = { htmlPath: '/home/u/.helios-task-agent/reports/work-summary-2026-07-31.html', mdPath: '/home/u/.helios-task-agent/reports/work-summary-2026-07-31.md' };
    const bot = summarizeForChat(data, paths, { linkBaseUrl: 'http://127.0.0.1:51234' });
    const cli = summarizeForChat(data, paths);
    return (
      bot.includes('http://127.0.0.1:51234/work-summary-2026-07-31.html') &&
      !bot.includes('/home/u/.helios-task-agent/reports/work-summary-2026-07-31.html') &&
      cli.includes(paths.htmlPath) &&
      !cli.includes('51234')
    );
  })());

  // ---------- 工作总结报告：html 文件名带 token 且 0600 ----------
  await checkAsync('writeSummaryReports：html 带 128-bit token 且 0600，md 不带 token', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-summary-'));
    try {
      const data = {
        scope: 'today',
        generatedAt: '2026-07-31T00:00:00Z',
        sinceLabel: '2026-07-31 今天',
        tasks: [],
        totals: { done: 1, inreview: 0, inprogress: 2, todo: 0, cancelled: 0, filesChanged: 3, additions: 10, deletions: 4 },
      } as unknown as WorkSummaryData;
      const paths = writeSummaryReports(data, { dir: tmp });
      assert.ok(paths.htmlPath && paths.mdPath);
      const htmlName = path.basename(paths.htmlPath!);
      // token 是访问凭证：必须符合服务端白名单正则，且md（本机路径用）不带
      assert.match(htmlName, /^work-summary-2026-07-31\.[0-9a-f]{32}\.html$/);
      assert.match(htmlName, /^[\w.-]+\.html$/);
      assert.equal(path.basename(paths.mdPath!), 'work-summary-2026-07-31.md');
      for (const f of [paths.htmlPath!, paths.mdPath!]) {
        assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 用户技能目录：数据目录优先，同名覆盖内置 ----------
  await checkAsync('技能目录：用户数据目录 skills/ 参与扫描且同名覆盖内置技能', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-skills-'));
    const prevHome = process.env.HELIOS_TASK_AGENT_HOME;
    process.env.HELIOS_TASK_AGENT_HOME = tmp;
    try {
      assert.equal(userSkillsDir(), path.join(tmp, 'skills'));
      const mk = (name: string, desc: string) => {
        fs.mkdirSync(path.join(tmp, 'skills', name), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n正文\n`);
      };
      mk('my-skill', '用户自定义技能');
      const digests = loadSkillDigests();
      assert.ok(digests.some((s) => s.name === 'my-skill' && s.description === '用户自定义技能'), '用户目录技能应被扫描到');
      assert.ok(digests.some((s) => s.name === 'helios-kanban-remote'), '内置技能仍兜底');
      // 同名覆盖：用户目录的 helios-kanban-remote 优先于包内
      mk('helios-kanban-remote', '用户覆盖版');
      const overridden = loadSkillDigests().find((s) => s.name === 'helios-kanban-remote');
      assert.equal(overridden?.description, '用户覆盖版');
      assert.ok(readSkillDoc('helios-kanban-remote').includes('正文'), 'skill_doc 也应读到用户覆盖版');
    } finally {
      if (prevHome === undefined) delete process.env.HELIOS_TASK_AGENT_HOME;
      else process.env.HELIOS_TASK_AGENT_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- skill_exec：运行技能目录内脚本（确认闸门 + 路径限定） ----------
  await checkAsync('skill_exec 工具：闸门、解释器推断与路径限定', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-skillexec-'));
    const prevHome = process.env.HELIOS_TASK_AGENT_HOME;
    process.env.HELIOS_TASK_AGENT_HOME = tmp;
    try {
      const skillDir = path.join(tmp, 'skills', 'scripted-skill');
      fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: scripted-skill\ndescription: 带脚本技能\n---\n\n# scripted-skill\n');
      fs.writeFileSync(path.join(skillDir, 'scripts', 'run.sh'), '#!/bin/sh\necho "sh:$1"\necho ran > marker.txt\n');
      fs.writeFileSync(path.join(skillDir, 'scripts', 'run.js'), 'console.log("js:" + process.argv[2]);\n');
      fs.writeFileSync(path.join(skillDir, 'scripts', 'data.txt'), 'not a script\n');
      // 技能目录外的文件：用于验证 ../ 逃逸被拒绝
      fs.writeFileSync(path.join(tmp, 'skills', 'escape.sh'), '#!/bin/sh\necho escaped\n');

      const make = (confirm?: () => Promise<boolean>) =>
        buildTools({ mcp: null, kanbanUrl: 'http://127.0.0.1:1', confirm });

      // 注册
      const { openAiTools } = make();
      assert.ok(openAiTools.some((t) => t.function.name === 'skill_exec'), 'skill_exec 应注册');

      // 无确认通道：fail closed
      const noGate = await make().handlers.get('skill_exec')!({ skill: 'scripted-skill', script: 'scripts/run.sh' }, undefined);
      assert.equal(noGate, NO_GATE_MESSAGE);

      // 用户拒绝：不执行（无副作用文件）
      const denied = await make(async () => false).handlers.get('skill_exec')!(
        { skill: 'scripted-skill', script: 'scripts/run.sh' },
        undefined,
      );
      assert.equal(denied, DENIED_MESSAGE);
      assert.ok(!fs.existsSync(path.join(skillDir, 'marker.txt')), '拒绝后脚本不应执行');

      // 确认后执行：.sh → bash，参数透传，cwd 为技能目录
      const ok = await make(async () => true).handlers.get('skill_exec')!(
        { skill: 'scripted-skill', script: 'scripts/run.sh', args: ['world'] },
        undefined,
      );
      assert.ok(ok.includes('sh:world'), `应返回脚本输出，实际：${ok}`);
      assert.ok(fs.existsSync(path.join(skillDir, 'marker.txt')), '脚本副作用（cwd=技能目录）应生效');
      assert.ok(ok.includes('UNTRUSTED'), '输出应被 UNTRUSTED 包裹');

      // .js → node
      const js = await make(async () => true).handlers.get('skill_exec')!(
        { skill: 'scripted-skill', script: 'scripts/run.js', args: ['n1'] },
        undefined,
      );
      assert.ok(js.includes('js:n1'), `.js 应走 node，实际：${js}`);

      // 路径逃逸 / 绝对路径 / 未知技能 / 未知扩展名 / 非法解释器
      const h = make(async () => true).handlers.get('skill_exec')!;
      assert.ok((await h({ skill: 'scripted-skill', script: '../escape.sh' }, undefined)).includes('越出技能目录'));
      assert.ok((await h({ skill: 'scripted-skill', script: '/etc/hosts' }, undefined)).includes('相对技能目录'));
      assert.ok((await h({ skill: 'no-such-skill', script: 'x.sh' }, undefined)).includes('未找到技能'));
      assert.ok((await h({ skill: 'scripted-skill', script: 'scripts/data.txt' }, undefined)).includes('无法按扩展名推断'));
      assert.ok(
        (await h({ skill: 'scripted-skill', script: 'scripts/run.sh', interpreter: 'ruby' }, undefined)).includes('不支持的解释器'),
      );
      assert.ok((await h({ skill: '../etc', script: 'x.sh' }, undefined)).includes('非法技能名'));
    } finally {
      if (prevHome === undefined) delete process.env.HELIOS_TASK_AGENT_HOME;
      else process.env.HELIOS_TASK_AGENT_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 更新提示附 CHANGELOG 链接 ----------
  await checkAsync('promptVersionUpdate：请示文案附 CHANGELOG 链接', async () => {
    let asked = '';
    const outcome = await promptVersionUpdate({
      info: { current: '1.0.2', latest: '1.1.0', tag: 'latest' },
      ask: async (q) => {
        asked = q;
        return '';
      },
    });
    assert.equal(outcome, 'skipped');
    assert.ok(asked.includes(CHANGELOG_URL), '应附变更记录链接');
  });

  // ---------- 共享命令模块（commands.ts） ----------
  check('parseCommand：取小写命令词，非命令为 null', (() => {
    return (
      parseCommand('/Status 现在') === '/status' &&
      parseCommand('  /stop  x') === '/stop' &&
      parseCommand('你好') === null &&
      parseCommand('') === null
    );
  })());

  check('buildToolsLines：MCP 可用列工具（描述取首行）/ 不可用输出降级说明', (() => {
    const tools = [{ name: 'create_task', description: '创建任务\n第二行', inputSchema: {} }] as unknown as Tool[];
    const ok = buildToolsLines(
      { mcpOk: true, mcpTools: tools, kanbanHeader: 'H', downNote: 'D', localHeader: 'L', bullet: '· ' },
      plainPaint,
    );
    const down = buildToolsLines(
      { mcpOk: false, mcpTools: [], kanbanHeader: 'H', downNote: 'D', localHeader: 'L', bullet: '· ' },
      plainPaint,
    );
    return (
      ok[0] === 'H' &&
      ok[1] === '· kanban_create_task  创建任务' &&
      ok.includes('L') &&
      ok.some((l) => l.includes('lark_cli')) &&
      down[0] === 'D' &&
      down.includes('L')
    );
  })());

  check('buildSkillsLines：标题 + 技能条目 + 可选脚注', (() => {
    const lines = buildSkillsLines({ header: '已安装技能', bullet: '· ', footer: 'F' }, plainPaint);
    return (
      lines[0] === '已安装技能' &&
      lines.some((l) => l.includes('helios-kanban-remote')) &&
      lines[lines.length - 1] === 'F'
    );
  })());

  check('confirmStateText / confirmRevokedText：通道差异经参数保留', (() => {
    return (
      confirmStateText(2, '输入 /confirm on 恢复逐次确认') ===
        '当前有 2 类写操作处于「同类免问」中；输入 /confirm on 恢复逐次确认。' &&
      confirmStateText(0, '') === '当前没有生效中的「同类免问」（写操作逐次确认）。' &&
      confirmRevokedText(3, '无') === '已恢复逐次确认（撤销 3 类「同类免问」授权）。' &&
      confirmRevokedText(0, '无') === '无' &&
      CLEARED_TEXT === '对话历史已清空（记忆保留）。'
    );
  })());

  check('llmFailureParts：CLI 指向 /config，bot 不提 /config；原消息 60 字截断', (() => {
    const cli = llmFailureParts('401 invalid api key', 'x'.repeat(70), 'cli');
    const bot = llmFailureParts('401 invalid api key', '短消息', 'bot');
    return (
      cli.head === '请求失败: 401 invalid api key' &&
      cli.friendly !== null &&
      cli.tail.includes('/config') &&
      cli.tail.includes('…') &&
      !bot.tail.includes('/config') &&
      bot.tail.includes('你的上一条消息未处理') &&
      !bot.tail.includes('…')
    );
  })());

  check('降级口径统一：诊断提示使用 hk_cli（看板 HTTP 接口）表述', (() => {
    const hint = diagnoseMcpFailure('Reading port from "/x/vibe-kanban.port"\nError: No such file or directory');
    return hint !== null && hint.includes(MCP_FALLBACK_TEXT) && MCP_FALLBACK_TEXT === '已自动切换为 hk_cli（看板 HTTP 接口）';
  })());

  // ---------- SessionRouter：同用户串行、跨用户并行 ----------
  await checkAsync('SessionRouter.enqueue：同一用户严格串行，不同用户可并行', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-serial-'));
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
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const work = (tag: string, ms: number) => async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, ms));
      order.push(tag);
      concurrent--;
    };
    await Promise.all([
      router.enqueue('u1', work('a1', 40)),
      router.enqueue('u1', work('a2', 5)),
      router.enqueue('u2', work('b1', 10)),
    ]);
    assert.ok(order.indexOf('a1') < order.indexOf('a2'), '同用户必须按入队顺序执行');
    assert.equal(maxConcurrent, 2, '不同用户应并行执行');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ---------- accessChecker.unclaim：fail-closed 撤销认领 ----------
  check('accessChecker.unclaim：撤销认领后名额恢复，他人可重新认领', (() => {
    const a = createAccessChecker([]);
    const claimed = a.check('u1') === 'claim';
    a.unclaim('u1');
    a.unclaim('nobody'); // 幂等：撤销未认领的用户无效果
    const reclaim = a.check('u2') === 'claim' && a.check('u1') === 'deny';
    return claimed && reclaim && a.list().join(',') === 'u2';
  })());

  // ---------- FeishuChannel：白名单快照与连接状态 API（卡片回调过滤共用同一 access） ----------
  check('FeishuChannel：allowedOpenIds/lastEventAt/connectionState 初始态', (() => {
    const ch = new FeishuChannel({ appId: 'cli_x', appSecret: 's', allowedOpenIds: ['ou_owner'] });
    // 卡片回调按 access.list() 过滤：allowedOpenIds() 即该名单的对外快照
    return (
      ch.allowedOpenIds().join(',') === 'ou_owner' &&
      !ch.allowedOpenIds().includes('ou_stranger') &&
      ch.lastEventAt() === 0 &&
      ch.connectionState() === null // 未 start()
    );
  })());

  // ---------- audit.log 轮转 ----------
  check('auditLog：超过 5MB 轮转为 audit.log.1，新记录写入新文件且不再次轮转', (() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-audit-'));
    const file = path.join(tmp, 'audit.log');
    fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 16, 0x78));
    auditLog({ user: 'u1', kind: 'kanban', summary: 's', detail: 'd', decision: 'approved' }, tmp);
    const rotated = fs.existsSync(`${file}.1`) && fs.statSync(`${file}.1`).size > 5 * 1024 * 1024;
    const fresh = fs.statSync(file).size < 1000 && fs.readFileSync(file, 'utf8').includes('"user":"u1"');
    // 未超阈值时不轮转
    auditLog({ user: 'u1', kind: 'kanban', summary: 's2', detail: 'd', decision: 'denied' }, tmp);
    const noExtraRotate = fs.readFileSync(file, 'utf8').includes('"summary":"s2"');
    fs.rmSync(tmp, { recursive: true, force: true });
    return rotated && fresh && noExtraRotate;
  })());

  // ---------- 读路径审计：lark_cli 读命令记 lark_read，不记读回内容 ----------
  await checkAsync('读审计：lark_cli 读路径记 lark_read（只记命令，不写 resultSnippet）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-larkaudit-'));
    try {
      const { handlers } = buildTools({
        mcp: null,
        kanbanUrl: 'http://localhost:1',
        userId: 'u1',
        registry: new SourceRegistry(tmp),
        auditHome: tmp,
      });
      // lark-cli 不存在/输出异常 run 也不抛异常，读审计必须照常落盘
      await handlers.get('lark_cli')!({ args: ['--help'] });
      const recs = fs
        .readFileSync(path.join(tmp, 'audit.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const rec = recs.find((r) => r.kind === 'lark_read');
      assert.ok(rec, '应有 lark_read 审计记录');
      assert.equal(rec.user, 'u1');
      assert.equal(rec.decision, 'approved');
      assert.ok(String(rec.summary).includes('lark-cli'));
      assert.equal(rec.resultSnippet, undefined, '读审计不得记录读回内容');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 读路径审计：repo_fs 记 repo_fs_read；敏感文件 denylist 拒绝记 denied ----------
  await checkAsync('读审计：repo_fs 读记 repo_fs_read，denylist 拒绝记 denied 且审计文件不含读回内容', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-fsaudit-'));
    const auditTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-fsaudit-log-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(repo, '.env'), 'LLM_API_KEY=sk-should-not-leak');
    const server = http.createServer((req, res) => {
      if (req.url === '/api/repos') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: [{ path: repo }] }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { handlers } = buildTools({
        mcp: null,
        kanbanUrl: base,
        userId: 'u1',
        registry: new SourceRegistry(auditTmp),
        auditHome: auditTmp,
      });
      const okOut = await handlers.get('repo_fs')!({ action: 'read', root: repo, path: 'a.txt' });
      assert.ok(okOut.includes('hello'));
      const denyOut = await handlers.get('repo_fs')!({ action: 'read', root: repo, path: '.env' });
      assert.ok(denyOut.includes('已拒绝读取'), `敏感文件应被拒绝，实际：${denyOut.slice(0, 120)}`);
      const raw = fs.readFileSync(path.join(auditTmp, 'audit.log'), 'utf8');
      const reads = raw
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((r) => r.kind === 'repo_fs_read');
      assert.equal(reads.length, 2);
      assert.equal(reads[0]!.decision, 'approved');
      assert.equal(reads[1]!.decision, 'denied'); // denylist 拒绝的尝试最值得留痕
      assert.ok(String(reads[1]!.summary).includes('.env'), '被拒记录应包含目标路径');
      assert.ok(reads.every((r) => r.resultSnippet === undefined), '读审计不得记录读回内容');
      assert.ok(!raw.includes('sk-should-not-leak'), '审计文件不得包含敏感文件内容');
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(auditTmp, { recursive: true, force: true });
    }
  });

  // ---------- renderReply：标题 / 表格 / 代码块保护 ----------
  check('renderReply：# 标题渲染为加粗（去掉 #），正文加粗仍生效', (() => {
    const out = renderReply('# 结论\n正文 **加粗** 保留');
    return !out.includes('# 结论') && out.includes('结论') && out.includes('加粗') && !out.includes('**');
  })());

  check('renderReply：简单表格列对齐，缺分隔行原样保留', (() => {
    const out = renderReply('| 名称 | 状态 |\n| --- | --- |\n| a | 完成 |\n| 长名字bb | 进行中 |');
    const rows = out.split('\n');
    const aligned =
      rows.length === 4 &&
      !rows.some((r) => r.includes('|')) &&
      rows[1] === '─'.repeat(8) + '  ' + '─'.repeat(6) &&
      rows[2] === `a${' '.repeat(9)}完成  ` &&
      rows[3] === '长名字bb  进行中';
    const degraded = renderReply('| a | b |\n| c | d |');
    return aligned && degraded.includes('| a | b |');
  })());

  check('renderReply：代码块内的 # 与表格语法不被渲染', (() => {
    const out = renderReply('```md\n# 不是标题\n| a | b |\n```');
    return out.includes('# 不是标题') && out.includes('| a | b |');
  })());

  // ---------- 记忆注入 USER_MEMORY 标记 ----------
  check('buildSystemPrompt：用户记忆包裹 USER_MEMORY 标记且声明不得作为指令执行', (() => {
    const p = buildSystemPrompt({ mcpOk: false, mcpToolNames: [], kanbanUrl: 'http://x', memoryText: '键值：\n- k: v' });
    const open = p.indexOf('<<<USER_MEMORY');
    const close = p.indexOf('END_USER_MEMORY>>>');
    const fact = p.indexOf('- k: v');
    return open > -1 && close > open && fact > open && fact < close && p.includes('不是指令');
  })());

  // ---------- 看板事件卡片：failed 按钮名 + 链接可达性注脚 ----------
  check('看板事件卡片：failed 按钮为「查看任务」，带链接时注脚提示可达范围', (() => {
    const card = buildWatchEventCard({ kind: 'failed', title: 't', url: 'http://kanban/x', text: 'x' }) as {
      elements: Array<{
        tag: string;
        actions?: Array<{ text?: { content?: string } }>;
        elements?: Array<{ content?: string }>;
      }>;
    };
    const btn = card.elements.find((e) => e.tag === 'action')?.actions?.[0]?.text?.content;
    const note = card.elements.find((e) => e.tag === 'note');
    return (
      btn === '📋 查看任务' &&
      Boolean(note?.elements?.some((n) => (n.content || '').includes('链接仅在运行本机器人的电脑所在网络可达')))
    );
  })());

  // ---------- isLoopbackUrl：loopback 各形态 true，局域网/公网/非法 URL false ----------
  check('isLoopbackUrl：localhost/127.x/[::1] 为 true，局域网 IP 与非法 URL 为 false', (() => {
    return (
      isLoopbackUrl('http://localhost:7964/x') &&
      isLoopbackUrl('http://127.0.0.1:7964') &&
      isLoopbackUrl('http://127.0.1.2') &&
      isLoopbackUrl('http://[::1]:8080/') &&
      !isLoopbackUrl('http://192.168.1.10:7964') &&
      !isLoopbackUrl('http://10.0.0.5') &&
      !isLoopbackUrl('https://kanban.example.com') &&
      !isLoopbackUrl('not a url') &&
      !isLoopbackUrl('')
    );
  })());

  // ---------- 看板事件卡片：loopback 链接注脚区分本机/局域网可达 ----------
  check('看板事件卡片：loopback 链接注脚提示仅本机可达（手机/局域网打不开）', (() => {
    const noteOf = (url: string) =>
      (buildWatchEventCard({ kind: 'done', title: 't', url, text: 'x' }) as {
        elements: Array<{ tag: string; elements?: Array<{ content?: string }> }>;
      }).elements
        .find((e) => e.tag === 'note')
        ?.elements?.map((n) => n.content || '')
        .join('\n') || '';
    const loop = noteOf('http://127.0.0.1:7964/tasks/1');
    const lan = noteOf('http://192.168.1.10:7964/tasks/1');
    return (
      loop.includes('链接仅在运行本机器人的电脑上可达') &&
      loop.includes('手机/局域网打不开') &&
      !loop.includes('所在网络可达') &&
      lan.includes('链接仅在运行本机器人的电脑所在网络可达') &&
      !lan.includes('手机/局域网打不开')
    );
  })());

  // ---------- 更新提示使用独立确认词表（UPDATE_YES_RE） ----------
  await checkAsync('promptVersionUpdate：回复「确认」同样执行更新（更新专用词表）', async () => {
    const outcome = await promptVersionUpdate({
      info: { current: '1.0.2', latest: '1.1.0', tag: 'latest' },
      ask: async () => '确认',
      runUpdate: async () => true,
    });
    assert.equal(outcome, 'updated');
  });

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}

void main();
