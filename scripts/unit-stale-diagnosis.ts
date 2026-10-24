// 停滞任务提醒（stale nudge）与失败 AI 诊断/重试的单测：
// - 停滞判定边界：恰好 N 小时 / 未到期 / 状态流转重置 / 24h 再提醒 / 重启不重复
// - 诊断按钮 action 路由、同一 attempt 防重复诊断、重试 follow-up 指令含诊断结论、重试防重
// - 进行中作业落盘（受理即写/完结摘除）与机器人重启后的中断补通知（聚合、出路、失败保留补投、
//   文本定位回填）
// - 诊断组合 signal（调用方中断/超时兜底，不依赖 AbortSignal.any）、重试会话按 created_at 取最新、
//   LLM 失败路径中文化。仅用本地 mock server 与注入执行器，无外部网络。
// Run: npx tsx scripts/unit-stale-diagnosis.ts

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { parseStaleNudgeHours, StaleNudgeTracker } from '../src/kanban/stale-nudge';
import { KanbanWatcher, WATCH_HINT_STALE, type WatchEvent } from '../src/kanban/watcher';
import { KanbanHttpError } from '../src/kanban/http';
import {
  resolveDiagnosisLlm,
  collectFailureContext,
  buildDiagnosisPrompt,
  runFailureDiagnosis,
  sendDiagnosisFollowUp,
  buildRetryPrompt,
  DIAGNOSIS_CARD_MAX_CHARS,
} from '../src/kanban/failure-diagnosis';
import { buildWatchEventCard, buildDiagnosisCard } from '../src/bot/cards';
import { createBotHandlers } from '../src/bot/handler';
import { SessionRouter } from '../src/agent/session-router';
import { ConfirmationManager } from '../src/agent/confirm';
import { MemoryStore } from '../src/agent/memory';
import { McpSupervisor } from '../src/bot/supervisor';
import type { KanbanMcp } from '../src/kanban/mcp';
import type { FeishuCardAction, FeishuChannel, FeishuInboundMessage } from '../src/channels/feishu';
import type { AgentConfig } from '../src/types';
import { check, checkAsync, finish, modeOk } from './testkit';

async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

/** 轮询等待条件成立（诊断/重试是 onCardAction 里 void 出去的异步流程）。 */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** mock 看板：tasks 行可变（status/updated_at），驱动 watcher 产出 stale 事件。 */
async function startStaleMockKanban(state: { status: string; updatedAt: string }) {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (data: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    };
    if (url.startsWith('/api/tasks?')) {
      return json([{ id: 't1', title: '任务1', status: state.status, updated_at: state.updatedAt }]);
    }
    if (url.startsWith('/api/task-attempts')) return json([]);
    if (url.startsWith('/api/approvals')) return json([]);
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const tickOf = (w: KanbanWatcher) => (w as unknown as { tick: () => Promise<void> }).tick.bind(w);

// --- fake channel：诊断/重试链路发 notifyOpenId / notifyCardOpenId / updateCard ---
// （sendCard 为进度占位链路的接口面，本套件不触发，占位满足 ProgressChannel 收窄后的类型）
class FakeChannel {
  notifies: { openId: string; text: string }[] = [];
  replies: { openId: string; text: string }[] = [];
  cards: { openId: string; card: Record<string, unknown> }[] = [];
  updatedCards: { messageId: string; card: Record<string, unknown> }[] = [];
  /** 置 true 时 notifyOpenId 抛错（中断通知投递失败补投用例用）。 */
  notifyFails = false;
  private seq = 0;
  async notifyOpenId(openId: string, text: string): Promise<void> {
    if (this.notifyFails) throw new Error('network down');
    this.notifies.push({ openId, text });
  }
  async reply(msg: { senderId: string }, text: string): Promise<void> {
    this.replies.push({ openId: msg.senderId, text });
  }
  async notifyCardOpenId(openId: string, card: Record<string, unknown>): Promise<string | undefined> {
    this.cards.push({ openId, card });
    return `card-${++this.seq}`;
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.updatedCards.push({ messageId, card });
  }
  async sendCard(_chatId: string, _card: Record<string, unknown>): Promise<string | undefined> {
    return undefined;
  }
}

function makeCfg(kanbanUrl: string): AgentConfig {
  return {
    llmBaseUrl: 'http://127.0.0.1:1/v1',
    llmApiKey: 'sk-x',
    llmModel: 'm',
    mcpCommand: 'npx',
    mcpArgs: [],
    kanbanUrl,
    kanbanProjectId: '',
    kanbanRepoId: '',
    kanbanIteration: '',
  };
}

/** 从卡片 JSON 里收集全部回调按钮的 value（2.0：按钮平铺 body.elements，value 在 behaviors callback 里）。 */
function buttonValues(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const elements = ((card.body as { elements?: Array<Record<string, unknown>> } | undefined)?.elements ??
    (card.elements as Array<Record<string, unknown>>) ??
    []) as Array<Record<string, unknown>>;
  for (const el of elements) {
    if (el.tag === 'button') {
      for (const b of (el.behaviors as Array<Record<string, unknown>>) ?? []) {
        if (b.type === 'callback' && b.value && typeof b.value === 'object') out.push(b.value as Record<string, unknown>);
      }
    }
    if (el.tag === 'action') {
      for (const a of (el.actions as Array<Record<string, unknown>>) ?? []) {
        if (a.value && typeof a.value === 'object') out.push(a.value as Record<string, unknown>);
      }
    }
  }
  return out;
}

function cardElements(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return ((card.body as { elements?: Array<Record<string, unknown>> } | undefined)?.elements ?? []) as Array<
    Record<string, unknown>
  >;
}

function cardButtons(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return cardElements(card).filter((el) => el.tag === 'button');
}

function hasPrimaryCount(card: Record<string, unknown>, expected: number): boolean {
  return cardButtons(card).filter((el) => el.type === 'primary_filled').length === expected;
}

async function main(): Promise<void> {
  // ---------- parseStaleNudgeHours：opt-in 解析 ----------
  check('parseStaleNudgeHours：未设置/空串 = 关闭（null）', parseStaleNudgeHours(undefined) === null && parseStaleNudgeHours('') === null && parseStaleNudgeHours('  ') === null);
  check('parseStaleNudgeHours：合法小时数通过', parseStaleNudgeHours('8') === 8 && parseStaleNudgeHours('0.5') === 0.5);
  check('parseStaleNudgeHours：非法值抛错（由调用方告警并关闭）', (() => {
    for (const bad of ['abc', '-1', '0', '8h']) {
      try {
        parseStaleNudgeHours(bad);
        return false;
      } catch {
        /* 期望抛错 */
      }
    }
    return true;
  })());

  // ---------- StaleNudgeTracker：判定边界与防骚扰 ----------
  await checkAsync('StaleNudgeTracker：未到期不提醒，恰好到阈值即提醒', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-edge-'));
    try {
      const tracker = new StaleNudgeTracker({ statePath: path.join(tmp, 's.json'), thresholdMs: 8 * 3600_000 });
      const t0 = 1_000_000_000_000;
      // 差 1ms 未到期
      assert.deepEqual(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: t0 - 8 * 3600_000 + 1 }], t0), []);
      // 恰好 8 小时（>= 判定）→ 提醒
      assert.deepEqual(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: t0 - 8 * 3600_000 }], t0), [
        { id: 't1', updatedAtMs: t0 - 8 * 3600_000 },
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('StaleNudgeTracker：同一阶段 24h 内不重复、满 24h 再提醒；状态流转/有更新后重置', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-remind-'));
    try {
      const tracker = new StaleNudgeTracker({
        statePath: path.join(tmp, 's.json'),
        thresholdMs: 8 * 3600_000,
        remindIntervalMs: 24 * 3600_000,
      });
      const staleAt = 1_000_000_000_000;
      const t1 = staleAt + 10 * 3600_000; // 已停滞 10h
      assert.equal(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], t1).length, 1, '首次到期应提醒');
      assert.equal(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], t1 + 3600_000).length, 0, '24h 内不重复');
      assert.equal(
        tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], t1 + 24 * 3600_000).length,
        1,
        '满 24h 再提醒一次',
      );
      // 状态流转（离开进行中）→ 条目清除；再回来重新计（updatedAt 未变且仍过期，会立刻再提醒——新阶段）
      assert.equal(tracker.due([{ id: 't1', status: 'done', updatedAtMs: staleAt }], t1 + 25 * 3600_000).length, 0, '非进行中不提醒');
      assert.equal(
        tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], t1 + 26 * 3600_000).length,
        1,
        '状态流转后重置：重新进入进行中按新阶段提醒',
      );
      // 任务有更新（updated_at 变化且未到期）→ 不再提醒
      const freshAt = t1 + 30 * 3600_000;
      assert.equal(tracker.due([{ id: 't1', status: 'inprogress', updatedAtMs: freshAt }], freshAt + 3600_000).length, 0, '有更新后未到期不提醒');
      // updated_at 无法解析：无数据不判定
      assert.equal(tracker.due([{ id: 't2', status: 'inprogress', updatedAtMs: null }], freshAt + 20 * 3600_000).length, 0, 'updated_at 缺失不判定');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('StaleNudgeTracker：提醒状态落盘，新实例（进程重启）不重复轰炸', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-persist-'));
    try {
      const statePath = path.join(tmp, 's.json');
      const staleAt = 1_000_000_000_000;
      const now = staleAt + 10 * 3600_000;
      const t1 = new StaleNudgeTracker({ statePath, thresholdMs: 8 * 3600_000 });
      assert.equal(t1.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], now).length, 1);
      assert.ok(fs.existsSync(statePath), '提醒状态应落盘');
      assert.ok(modeOk(statePath, 0o600), 'state 文件应为 0600');
      // 模拟进程重启：新实例从盘上恢复，同一阶段 24h 内不再提醒
      const t2 = new StaleNudgeTracker({ statePath, thresholdMs: 8 * 3600_000 });
      assert.equal(t2.due([{ id: 't1', status: 'inprogress', updatedAtMs: staleAt }], now + 3600_000).length, 0, '重启后不得重复提醒');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- KanbanWatcher 集成：stale 事件走推送管线 ----------
  await checkAsync('KanbanWatcher：进行中任务 updated_at 超阈值产出 stale 事件一次，下轮不重复', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-watch-'));
    const staleAt = new Date(Date.now() - 10 * 3600_000).toISOString();
    const kanbanState = { status: 'inprogress', updatedAt: staleAt };
    const { server, base } = await startStaleMockKanban(kanbanState);
    try {
      const sent: WatchEvent[] = [];
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        staleNudge: {
          thresholdMs: 8 * 3600_000,
          statePath: path.join(tmp, 'stale-state.json'),
        },
        notify: async (e) => {
          sent.push(e);
        },
      });
      const tick = tickOf(watcher);
      await tick(); // 基线：不打扰
      assert.equal(sent.length, 0, '首轮基线不应提醒');
      await tick(); // 第二轮：停滞 10h > 8h → stale 事件
      assert.equal(sent.length, 1);
      const e = sent[0]!;
      assert.equal(e.kind, 'stale');
      assert.equal(e.taskId, 't1');
      assert.ok(e.text.includes('久未更新'), `文案口径应为「无更新」而非「停滞/卡死」：${e.text}`);
      assert.ok(!e.text.includes('卡死') && !e.text.includes('停滞'), `文案不得过强：${e.text}`);
      assert.ok(e.extra?.includes('小时无更新'), `extra 应含停滞时长：${e.extra}`);
      await tick(); // 同一阶段不重复
      assert.equal(sent.length, 1, '同一停滞阶段不得重复推送');
      // 卡片渲染：stale kind 不崩、含标题与时长说明
      const card = buildWatchEventCard(e) as { header: { title: { content: string } } };
      assert.ok(card.header.title.content.includes('久未更新'));
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- KanbanWatcher：stop 后在途推送逐条跳过 ----------
  await checkAsync('KanbanWatcher：stop 后 deliverPending 跳过剩余推送，未送达组合保留待重投', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-stop-'));
    try {
      const sent: string[] = [];
      const logs: string[] = [];
      const watcher = new KanbanWatcher({
        kanbanUrl: 'http://127.0.0.1:1',
        statePath: path.join(tmp, 'watch-state.json'),
        owners: () => ['o1', 'o2'],
        notify: async () => {},
        notifyOwner: async (_e, owner) => {
          sent.push(owner);
          if (owner === 'o1') await watcher.stop(); // 第一条送达后即停：后续推送应全部跳过
        },
        log: (msg) => logs.push(msg),
      });
      const deliver = (
        watcher as unknown as {
          deliverPending: (
            events: Array<{ id: string; event: WatchEvent }>,
            prev: undefined,
          ) => Promise<{ pending: Record<string, { delivered: string[] }>; failed: number }>;
        }
      ).deliverPending.bind(watcher);
      const mk = (id: string): { id: string; event: WatchEvent } => ({ id, event: { kind: 'done', title: id, text: id } });
      const r = await deliver([mk('e1'), mk('e2')], undefined);
      assert.deepEqual(sent, ['o1'], `stop 后不应再有推送，实际：${sent.join(',')}`);
      assert.deepEqual(r.pending.e1?.delivered, ['o1'], '已送达进度应保留');
      assert.ok(r.pending.e2, '未送达事件应保留待重投');
      assert.ok(
        logs.some((l) => l.includes('已停止')),
        `跳过剩余推送应记日志，实际：${logs.join(' | ')}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- resolveDiagnosisLlm：OCR_LLM_* 逐项优先，回退主配置 ----------
  check('resolveDiagnosisLlm：OCR_LLM_* 逐项优先，缺项回退机器人主配置', (() => {
    const fallback = { baseUrl: 'https://main.example/v1', apiKey: 'sk-main', model: 'main-model' };
    // 未设置：全部回退
    const d1 = resolveDiagnosisLlm(fallback, {});
    if (d1.baseUrl !== fallback.baseUrl || d1.apiKey !== 'sk-main' || d1.model !== 'main-model') return false;
    // OCR_LLM_URL 是 ocr 的完整端点：SDK baseURL 要剥掉 /chat/completions
    const d2 = resolveDiagnosisLlm(fallback, {
      OCR_LLM_URL: 'https://ocr.example/v1/chat/completions',
      OCR_LLM_TOKEN: 'sk-ocr',
      OCR_LLM_MODEL: 'ocr-model',
    });
    if (d2.baseUrl !== 'https://ocr.example/v1' || d2.apiKey !== 'sk-ocr' || d2.model !== 'ocr-model') return false;
    // 只隔离 key：URL/模型仍回退主配置（与 buildOcrEnv 逐项回退口径一致）
    const d3 = resolveDiagnosisLlm(fallback, { OCR_LLM_TOKEN: 'sk-ocr' });
    return d3.baseUrl === fallback.baseUrl && d3.apiKey === 'sk-ocr' && d3.model === 'main-model';
  })());

  // ---------- collectFailureContext / buildDiagnosisPrompt ----------
  await checkAsync('collectFailureContext：任务详情 + 最新 attempt + diff 统计组装进诊断材料', async () => {
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url === '/api/tasks/t1') {
        return json({ title: '修复登录', description: '登录接口偶发 500', last_attempt_summary: '执行失败：npm test 有 2 个用例未通过' });
      }
      if (url === '/api/task-attempts?task_id=t1') {
        return json([
          { id: 'att-1', created_at: '2026-01-01' },
          { id: 'att-2', created_at: '2026-01-02' },
        ]);
      }
      if (url === '/api/task-attempts/summary' && req.method === 'POST') {
        return json([{ workspace_id: 'att-2', files_changed: 3, additions: 42, deletions: 7 }]);
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ctx = await collectFailureContext(base, 't1');
      assert.equal(ctx.title, '修复登录');
      assert.equal(ctx.description, '登录接口偶发 500');
      assert.ok(ctx.attemptSummary.includes('npm test'), `摘要不符：${ctx.attemptSummary}`);
      assert.equal(ctx.attemptId, 'att-2', '应取最新 attempt');
      assert.deepEqual(ctx.diffStats, { filesChanged: 3, additions: 42, deletions: 7 });
      const prompt = buildDiagnosisPrompt(ctx, ctx.title);
      for (const want of ['失败原因归类', '关键证据摘要', '建议修复方向', '登录接口偶发 500', 'npm test', '改动 3 个文件']) {
        assert.ok(prompt.includes(want), `prompt 缺「${want}」`);
      }
    } finally {
      await stopServer(server);
    }
  });

  // ---------- runFailureDiagnosis：成功路径与 LLM 失败路径中文化 ----------
  await checkAsync('runFailureDiagnosis：成功返回诊断文本与 attemptId；LLM 失败给中文错误', async () => {
    const base = 'http://127.0.0.1:1';
    const llm = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm' };
    const ctxInject = async () => ({
      taskId: 't1',
      title: '修复登录',
      description: 'desc',
      attemptSummary: 'summary',
      attemptId: 'att-2' as string | undefined,
      diffStats: undefined,
    });
    const ok = await runFailureDiagnosis({
      kanbanUrl: base,
      taskId: 't1',
      llm,
      collectContext: ctxInject,
      complete: async (prompt) => {
        assert.ok(prompt.includes('修复登录'), 'prompt 应含任务标题');
        return '一、失败原因归类：测试失败\n二、关键证据摘要：…\n三、建议修复方向：…';
      },
    });
    assert.equal(ok.attemptId, 'att-2');
    assert.ok(ok.text.includes('测试失败'));
    // 超时 → 中文超时文案
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: base,
          taskId: 't1',
          llm,
          timeoutMs: 5 * 60_000,
          collectContext: ctxInject,
          complete: async () => {
            throw new Error('The operation timed out');
          },
        }),
      /AI 诊断超时（5 分钟），已终止。/,
    );
    // 其他 LLM 错误 → 通用中文定性 + 文本可达的重试出路，不透英文原文
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: base,
          taskId: 't1',
          llm,
          collectContext: ctxInject,
          complete: async () => {
            throw new Error('mock HTTP 500 internal error');
          },
        }),
      /模型调用失败，可回复「为什么失败」重新发起诊断/,
    );
  });

  // ---------- runFailureDiagnosis：组合 signal（复用 http.ts 手写组合，不依赖 Node 20.3+ 的 AbortSignal.any） ----------
  await checkAsync('runFailureDiagnosis：调用方 signal 中断与超时兜底都经组合 signal 生效', async () => {
    const base = 'http://127.0.0.1:1';
    const llm = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm' };
    const ctxInject = async () => ({ taskId: 't1', title: 'x', description: '', attemptSummary: '' });
    // 调用方 signal 中断：传入 complete 的组合 signal 同步触发，文案归「已中断」
    const controller = new AbortController();
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: base,
          taskId: 't1',
          llm,
          collectContext: ctxInject,
          signal: controller.signal,
          complete: async (_p, _l, signal) => {
            controller.abort();
            assert.ok(signal?.aborted, '组合 signal 应随调用方 signal 中断而触发');
            throw new Error('The operation was aborted');
          },
        }),
      /已中断/,
    );
    // 超时兜底：complete 只监听 signal，到点被组合 signal 终止并按超时收尾
    //（AbortSignal.timeout 的定时器不挂事件循环：backup 定时器保活进程，
    //  组合 signal 若失效则由 backup 报错让用例失败而非静默跳过）
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: base,
          taskId: 't1',
          llm,
          timeoutMs: 50,
          collectContext: ctxInject,
          complete: (_p, _l, signal) =>
            new Promise<string>((_resolve, reject) => {
              const backup = setTimeout(() => reject(new Error('组合 signal 未在超时兜底到点前触发')), 500);
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(backup);
                  reject(new Error('aborted'));
                },
                { once: true },
              );
            }),
        }),
      /AI 诊断超时/,
    );
  });

  // ---------- sendDiagnosisFollowUp / buildRetryPrompt ----------
  await checkAsync('sendDiagnosisFollowUp：会话按 created_at 取最新，不依赖 /sessions 返回顺序', async () => {
    const posted: string[] = [];
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url.startsWith('/api/sessions?workspace_id=')) {
        // 最新会话排在前面：旧逻辑 .pop() 取末元素会错取 sess-old
        return json([
          { id: 'sess-new', created_at: '2026-01-02T10:00:00Z' },
          { id: 'sess-old', created_at: '2026-01-01T10:00:00Z' },
        ]);
      }
      if (req.method === 'POST' && url.startsWith('/api/sessions/')) {
        posted.push(url);
        return json({});
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await sendDiagnosisFollowUp(base, 'att-1', 'p');
      assert.deepEqual(posted, ['/api/sessions/sess-new/follow-up'], `应发到 created_at 最新的会话，实际：${posted.join(',')}`);
    } finally {
      await stopServer(server);
    }
  });

  await checkAsync('sendDiagnosisFollowUp：定位最新会话并 POST follow-up；无会话给中文错误', async () => {
    const posted: Array<{ url: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (data: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
      };
      if (url.startsWith('/api/sessions?workspace_id=')) return json([{ id: 'sess-1' }, { id: 'sess-2' }]);
      if (req.method === 'POST' && url.startsWith('/api/sessions/')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          posted.push({ url, body });
          json({});
        });
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const prompt = buildRetryPrompt('修复登录', '一、失败原因归类：测试失败\n三、建议修复方向：补 mock');
      assert.ok(prompt.includes('测试失败') && prompt.includes('修复登录'), 'follow-up 指令应含诊断结论与任务标题');
      await sendDiagnosisFollowUp(base, 'att-2', prompt);
      assert.equal(posted.length, 1);
      assert.ok(posted[0]!.url.startsWith('/api/sessions/sess-2/follow-up'), `应 POST 到最新会话：${posted[0]!.url}`);
      assert.equal(JSON.parse(posted[0]!.body).prompt, prompt);
    } finally {
      await stopServer(server);
    }
    // 无会话：中文错误 + 手动出路
    const empty = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [] }));
    });
    await new Promise<void>((r) => empty.listen(0, '127.0.0.1', r));
    try {
      const base2 = `http://127.0.0.1:${(empty.address() as AddressInfo).port}`;
      await assert.rejects(() => sendDiagnosisFollowUp(base2, 'att-x', 'p'), /找不到该任务的执行会话/);
    } finally {
      await stopServer(empty);
    }
  });

  await checkAsync('sendDiagnosisFollowUp：预先取消不发请求，POST 在途取消经 signal 中断', async () => {
    let requests = 0;
    let posts = 0;
    const server = http.createServer((req, res) => {
      requests++;
      if (req.method === 'POST') {
        posts++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"success":true,"data":');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: [{ id: 'sess-1', created_at: '2026-01-01' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const pre = new AbortController();
      pre.abort();
      await assert.rejects(() => sendDiagnosisFollowUp(base, 'att-1', 'p', pre.signal), /已中断/);
      assert.equal(requests, 0, 'POST 前检查与入口检查必须挡住已取消请求');
      const ctl = new AbortController();
      const pending = sendDiagnosisFollowUp(base, 'att-1', 'p', ctl.signal);
      await waitFor(() => posts === 1, 'POST 在途');
      ctl.abort();
      await assert.rejects(() => pending);
      assert.equal(posts, 1, '已开始的 POST 只发送一次，不重试');
    } finally {
      await stopServer(server);
    }
  });

  // ---------- buildDiagnosisCard：重试按钮与终态 ----------
  check('buildDiagnosisCard：重试唯一主按钮、长标题入正文、value 不变；settledAt 后回传按钮消失', (() => {
    const title = '超长诊断任务标题'.repeat(10);
    const card = buildDiagnosisCard(title, '一、…', 'task-1', {
      diagnosisId: 'diag-1',
      owner: 'u1',
      url: 'http://kb.local/t/1',
    });
    const vals = buttonValues(card);
    assert.deepEqual(vals, [
      {
        hta_retry: 'task-1',
        diagnosisId: 'diag-1',
        owner: 'u1',
        title: `${title.slice(0, 50)}…`,
        url: 'http://kb.local/t/1',
      },
    ]);
    const header = (card.header as { title: { content: string } }).title.content;
    if (!header.includes('AI 失败诊断') || header.includes(title)) return false;
    if (cardElements(card)[0]?.content !== `**《${title}》**`) return false;
    if (!hasPrimaryCount(card, 1)) return false;
    assert.deepEqual(cardButtons(card).map((el) => el.type), ['primary_filled', 'default']);
    const settled = buildDiagnosisCard('任务X', '一、…', 'task-1', { settledAt: '2026-09-04 10:00:00' });
    if (buttonValues(settled).length !== 0 || cardButtons(settled).length !== 0) return false; // 无 url 时终态无按钮
    const settledHeader = (settled.header as { title: { content: string } }).title.content;
    if (!settledHeader.includes('已按诊断结论重试')) return false;
    // 有 url 的终态只保留次按钮，回传按钮仍消失
    const settledUrl = buildDiagnosisCard('任务X', '一、…', 'task-1', { settledAt: '2026-09-04 10:00:00', url: 'http://kb.local/t/1' });
    const flat = JSON.stringify(settledUrl);
    if (!flat.includes('📋 查看任务') || !flat.includes('http://kb.local/t/1')) return false;
    return buttonValues(settledUrl).length === 0 && hasPrimaryCount(settledUrl, 0) && cardButtons(settledUrl)[0]?.type === 'default';
  })());

  check('buildWatchEventCard：AI 诊断唯一主按钮、查看任务次按钮，长标题与 value 结构不变', (() => {
    const title = '超长失败任务标题'.repeat(10);
    const card = buildWatchEventCard({
      kind: 'failed',
      title,
      url: 'http://localhost:7964/x',
      taskId: 'task-1',
      attemptId: 'att-9',
      text: '…',
    }, 'u1');
    const vals = buttonValues(card);
    assert.deepEqual(vals, [
      {
        hta_diagnose: 'task-1',
        attempt: 'att-9',
        title: `${title.slice(0, 50)}…`,
        url: 'http://localhost:7964/x',
        owner: 'u1',
      },
    ]);
    const header = (card.header as { title: { content: string } }).title.content;
    return (
      !header.includes(title) &&
      cardElements(card)[0]?.content === `**《${title}》**` &&
      hasPrimaryCount(card, 1) &&
      cardButtons(card).map((el) => el.type).join(',') === 'primary_filled,default'
    );
  })());

  check('buildWatchEventCard：AI 审查为主按钮，查看任务为次按钮，owner payload 不变', (() => {
    const card = buildWatchEventCard({
      kind: 'review',
      title: '任务X',
      url: 'http://kb.local/t/1',
      attemptId: 'att-1',
      text: '…',
    }, 'u1');
    assert.deepEqual(buttonValues(card), [{ hta_review: 'att-1', title: '任务X', url: 'http://kb.local/t/1', owner: 'u1' }]);
    return hasPrimaryCount(card, 1) && cardButtons(card).map((el) => el.type).join(',') === 'primary_filled,default';
  })());

  // ---------- handler 集成：hta_diagnose / hta_retry 路由、防重、follow-up 内容、失败路径 ----------
  await checkAsync('hta_diagnose/hta_retry：路由 → 诊断卡片 → 重试 follow-up 含诊断结论，全程防重复', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-diag-handler-'));
    try {
      const cfg = makeCfg('http://127.0.0.1:1');
      const router = new SessionRouter(cfg, null, false, { memory: new MemoryStore(tmp) });
      const confirmations = new ConfirmationManager(async () => undefined, { timeoutMs: 1000 });
      const channel = new FakeChannel();
      const fakeMcp = { tools: [] } as unknown as KanbanMcp;
      const supervisor = new McpSupervisor({ mcp: fakeMcp, initiallyAlive: false });
      const diagnosisCalls: Array<{ taskId: string }> = [];
      const followUps: Array<{ attemptId: string; prompt: string }> = [];
      const handlers = createBotHandlers({
        channel: channel as unknown as FeishuChannel,
        router,
        confirmations,
        cfg,
        mcp: fakeMcp,
        supervisor,
        reportServer: null,
        helpText: 'HELP',
        diagnosisRunner: async (opts) => {
          diagnosisCalls.push({ taskId: opts.taskId });
          return { text: '一、失败原因归类：测试失败\n三、建议修复方向：补依赖', attemptId: 'att-2' };
        },
        followUpSender: async (_kanbanUrl, attemptId, prompt) => {
          followUps.push({ attemptId, prompt });
        },
      });
      const clickDiagnose = () =>
        handlers.onCardAction({
          operator: { open_id: 'u1' },
          action: { value: { owner: 'u1', hta_diagnose: 'task-1', attempt: 'att-2', title: '修复登录' } },
        });
      const clickRetry = () =>
        handlers.onCardAction({
          operator: { open_id: 'u1' },
          action: { value: buttonValues(channel.cards[0]!.card).find((v) => v.hta_retry)! },
        } as FeishuCardAction);

      clickDiagnose();
      await waitFor(() => channel.cards.length === 1, '诊断结果卡片');
      assert.equal(diagnosisCalls.length, 1);
      assert.ok(
        !channel.notifies.some((n) => n.text.includes('AI 诊断已开始')),
        '开始反馈由 toast + 进行中卡片承担，不再重复发文本通知',
      );
      const diagCard = channel.cards[0]!.card;
      const retryBtn = buttonValues(diagCard).find((v) => v.hta_retry === 'task-1');
      assert.ok(retryBtn, '诊断卡片应带「按诊断结论重试」按钮');
      // 会话注入：追问有上下文
      const notes = (router.getOrCreate('u1') as unknown as { pendingNotes: Array<{ text: string }> }).pendingNotes;
      assert.ok(notes.some((n) => n.text.includes('AI 失败诊断完成') && n.text.includes('测试失败')), '诊断结论应注入会话');

      // 同一 attempt 重复点诊断：不再调 LLM，提示已诊断
      clickDiagnose();
      await waitFor(() => channel.notifies.some((n) => n.text.includes('已诊断过')), '重复诊断提示');
      assert.equal(diagnosisCalls.length, 1, '同一 attempt 不得重复诊断');

      // 重试：follow-up 指令含诊断结论；诊断卡片原地置终态
      clickRetry();
      await waitFor(() => followUps.length === 1, 'follow-up 发起');
      assert.equal(followUps[0]!.attemptId, 'att-2');
      assert.ok(followUps[0]!.prompt.includes('测试失败'), 'follow-up 应含失败原因');
      assert.ok(followUps[0]!.prompt.includes('补依赖'), 'follow-up 应含修复建议');
      await waitFor(() => channel.updatedCards.length === 1, '诊断卡片置终态');
      assert.equal(channel.updatedCards[0]!.messageId, 'card-1');
      assert.equal(buttonValues(channel.updatedCards[0]!.card).length, 0, '终态卡片不得再有按钮');
      await waitFor(() => channel.notifies.some((n) => n.text.includes('已按诊断结论发起重试')), '重试回执');

      // 重复点重试：不再发起
      clickRetry();
      await waitFor(() => channel.notifies.some((n) => n.text.includes('重试已发起过')), '重复重试提示');
      assert.equal(followUps.length, 1, '重试发起后不得重复发起');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('hta_diagnose：LLM 失败推中文提示；hta_retry 无诊断结论时给明确指引', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-diag-fail-'));
    try {
      const cfg = makeCfg('http://127.0.0.1:1');
      const router = new SessionRouter(cfg, null, false, { memory: new MemoryStore(tmp) });
      const confirmations = new ConfirmationManager(async () => undefined, { timeoutMs: 1000 });
      const channel = new FakeChannel();
      const fakeMcp = { tools: [] } as unknown as KanbanMcp;
      const supervisor = new McpSupervisor({ mcp: fakeMcp, initiallyAlive: false });
      const handlers = createBotHandlers({
        channel: channel as unknown as FeishuChannel,
        router,
        confirmations,
        cfg,
        mcp: fakeMcp,
        supervisor,
        reportServer: null,
        helpText: 'HELP',
        diagnosisRunner: async () => {
          throw new Error('AI 诊断超时（6 分钟），已终止。');
        },
      });
      // 先点重试（无诊断结论）：明确指引重新诊断，不沉默
      handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { hta_retry: 'task-9', diagnosisId: 'missing', owner: 'u1', title: '任务Y' } } });
      await waitFor(() => channel.notifies.some((n) => n.text.includes('找不到') && n.text.includes('诊断结论')), '无结论指引');
      // 诊断 LLM 失败：中文失败提示，不留沉默
      handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { owner: 'u1', hta_diagnose: 'task-1', attempt: 'att-1', title: '任务X' } } });
      await waitFor(() => channel.notifies.some((n) => n.text.includes('⚠️ AI 诊断失败')), '诊断失败提示');
      const fail = channel.notifies.find((n) => n.text.includes('⚠️ AI 诊断失败'))!;
      assert.ok(fail.text.includes('AI 诊断超时（6 分钟）'), `失败原因应中文化：${fail.text}`);
      assert.equal(channel.cards.length, 0, '诊断失败不得推结果卡片');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 第十轮复查：停滞时长口径 / 诊断与重试链路文案 ----------
  await checkAsync('KanbanWatcher：停滞时长向下取整（8.55 小时报 8 小时，只少报不多报）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-floor-'));
    const staleAt = new Date(Date.now() - 8.55 * 3600_000).toISOString();
    const { server, base } = await startStaleMockKanban({ status: 'inprogress', updatedAt: staleAt });
    try {
      const sent: WatchEvent[] = [];
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        staleNudge: { thresholdMs: 8 * 3600_000, statePath: path.join(tmp, 'stale-state.json') },
        notify: async (e) => {
          sent.push(e);
        },
      });
      const tick = tickOf(watcher);
      await tick();
      await tick();
      assert.equal(sent.length, 1);
      assert.ok(sent[0]!.extra?.includes('已超过 8 小时无更新'), `8.55 小时应报 8 小时：${sent[0]!.extra}`);
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('KanbanWatcher：阈值允许小数小时，不足 1 小时按分钟描述（不谎称已超过 1 小时）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stale-min-'));
    const staleAt = new Date(Date.now() - 40 * 60_000).toISOString(); // 停滞 40 分钟
    const { server, base } = await startStaleMockKanban({ status: 'inprogress', updatedAt: staleAt });
    try {
      const sent: WatchEvent[] = [];
      const watcher = new KanbanWatcher({
        kanbanUrl: base,
        projectId: 'p1',
        statePath: path.join(tmp, 'watch-state.json'),
        staleNudge: { thresholdMs: 0.5 * 3600_000, statePath: path.join(tmp, 'stale-state.json') },
        notify: async (e) => {
          sent.push(e);
        },
      });
      const tick = tickOf(watcher);
      await tick();
      await tick();
      assert.equal(sent.length, 1);
      const extra = sent[0]!.extra ?? '';
      assert.ok(extra.includes('分钟无更新'), `不足 1 小时应按分钟描述：${extra}`);
      assert.ok(!extra.includes('1 小时'), `不得谎称已超过 1 小时：${extra}`);
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  check('buildDiagnosisPrompt：标题缺失时用「该任务」指代，不塞裸任务 id', (() => {
    const prompt = buildDiagnosisPrompt(
      { taskId: '7f3a9c2e-1111-2222-3333-444455556666', title: '', description: '', attemptSummary: '' },
      '',
    );
    return prompt.includes('该任务') && !prompt.includes('7f3a9c2e');
  })());

  await checkAsync('runFailureDiagnosis：模型配置缺项给「配置不完整」中文定性，不暴露环境变量名', async () => {
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: 'http://127.0.0.1:1',
          taskId: 't1',
          llm: { baseUrl: '', apiKey: '', model: '' },
          env: {},
          collectContext: async () => ({ taskId: 't1', title: 'x', description: '', attemptSummary: '' }),
        }),
      (err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        return m.includes('模型配置不完整，请联系部署者检查模型配置') && !m.includes('LLM_BASE_URL');
      },
    );
  });

  await checkAsync('runFailureDiagnosis：采集阶段失败中文化，英文原文与裸 HTTP 码不直达', async () => {
    const llm = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm' };
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: 'http://127.0.0.1:1',
          taskId: 't1',
          llm,
          collectContext: async () => {
            throw new TypeError('fetch failed');
          },
        }),
      (err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        // 网络错误文案统一走 config/net-error 的 friendlyNetError 口径（「网络请求失败（请检查网络/代理）」），
        // 英文原文（fetch failed）收 HTA_DEBUG，不落用户面；括号不嵌套（文案内已有一对括号）
        return (
          m.startsWith('无法获取该任务的失败信息') &&
          m.includes('网络请求失败') &&
          m.includes('请检查网络/代理') &&
          !m.includes('fetch failed') &&
          !/（[^（）]*（/.test(m)
        );
      },
    );
    await assert.rejects(
      () =>
        runFailureDiagnosis({
          kanbanUrl: 'http://127.0.0.1:1',
          taskId: 't1',
          llm,
          collectContext: async () => {
            throw new KanbanHttpError(404);
          },
        }),
      (err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        // 404 是确定性终态：出路为看板确认 + 重新发起，不得带「重试」字样（重试必败；
        // 「重新发起」同时命中 review-jobs 抑制词，避免被追加必败的重试后缀）
        return (
          m.includes('已不存在') &&
          m.includes('请到看板确认任务状态') &&
          m.includes('重新发起') &&
          !m.includes('重试') &&
          !m.includes('HTTP 404')
        );
      },
    );
  });

  await checkAsync('sendDiagnosisFollowUp：看板 404 单独定性「已被看板清理」，裸状态码不直达', async () => {
    const server404 = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => server404.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server404.address() as AddressInfo).port}`;
      await assert.rejects(
        () => sendDiagnosisFollowUp(base, 'att-x', 'p'),
        (err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          return m.includes('已被看板清理') && m.includes('手动重新发起') && !m.includes('HTTP');
        },
      );
    } finally {
      await stopServer(server404);
    }
    const server500 = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('{}');
    });
    await new Promise<void>((r) => server500.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server500.address() as AddressInfo).port}`;
      await assert.rejects(() => sendDiagnosisFollowUp(base, 'att-x', 'p'), /看板接口暂时异常/);
    } finally {
      await stopServer(server500);
    }
  });

  check('buildDiagnosisCard：LLM 输出最小中和（标签/删除线），截断注记给出路，注脚称「任务执行方」', (() => {
    // 2.0：首项为加粗任务标题，第二项为诊断正文，注脚为 markdown + text_size:notation
    type Card2 = { body: { elements: Array<{ tag: string; content?: string; text_size?: string }> } };
    const card = buildDiagnosisCard('任务X', '一、<font color="red">警告</font> ~~伪造~~ **保留加粗**', 'task-1') as Card2;
    const body = card.body.elements[1]!.content ?? '';
    const note = card.body.elements
      .filter((e) => e.tag === 'markdown' && e.text_size === 'notation')
      .map((n) => n.content || '')
      .join('\n');
    if (body.includes('<font') || body.includes('~~') || body.includes('</')) return false;
    if (!body.includes('＜font') || !body.includes('～～') || !body.includes('**保留加粗**')) return false;
    if (!note.includes('任务执行方') || note.includes('执行 Agent')) return false;
    const long = buildDiagnosisCard('任务X', 'x'.repeat(DIAGNOSIS_CARD_MAX_CHARS + 10), 'task-1') as Card2;
    return (long.body.elements[1]!.content ?? '').includes('过长已截断，完整结论可直接追问');
  })());

  check('buildWatchEventCard：失败注脚主推「AI 诊断」按钮；stale 注脚复用 WATCH_HINT_STALE', (() => {
    // 2.0：注脚为若干 markdown + text_size:notation
    type Card2 = { body: { elements: Array<{ tag: string; content?: string; text_size?: string }> } };
    const noteOf = (e: WatchEvent): string =>
      (buildWatchEventCard(e) as Card2).body.elements
        .filter((el) => el.tag === 'markdown' && el.text_size === 'notation')
        .map((n) => n.content || '')
        .join('\n');
    const failed = noteOf({ kind: 'failed', title: 't', url: 'http://kanban/x', taskId: 't1', text: 'x' });
    if (!failed.includes('点上方「AI 诊断」自动分析失败原因') || !failed.includes('也可回复「为什么失败」')) return false;
    const stale = noteOf({
      kind: 'stale',
      title: 't',
      url: 'http://kanban/x',
      taskId: 't1',
      extra: '状态「进行中」，已超过 9 小时无更新（最后更新：x）',
      text: 'x',
    });
    return stale.includes(WATCH_HINT_STALE);
  })());

  // ---------- 进行中作业落盘与重启中断通知 ----------
  const mkJobsHandlers = (
    channel: FakeChannel,
    tmp: string,
    statePath: string,
    runners: {
      diagnosisRunner?: () => Promise<{ text: string; attemptId: string }>;
      aiReviewRunner?: () => Promise<string>;
    } = {},
  ) => {
    const cfg = makeCfg('http://127.0.0.1:1');
    const router = new SessionRouter(cfg, null, false, { memory: new MemoryStore(tmp) });
    const confirmations = new ConfirmationManager(async () => undefined, { timeoutMs: 1000 });
    const fakeMcp = { tools: [] } as unknown as KanbanMcp;
    const supervisor = new McpSupervisor({ mcp: fakeMcp, initiallyAlive: false });
    return createBotHandlers({
      channel: channel as unknown as FeishuChannel,
      router,
      confirmations,
      cfg,
      mcp: fakeMcp,
      supervisor,
      reportServer: null,
      helpText: 'HELP',
      diagnosisRunner: runners.diagnosisRunner,
      aiReviewRunner: runners.aiReviewRunner,
      reviewJobsStatePath: statePath,
    });
  };
  const readJobsFile = (statePath: string): Array<Record<string, unknown>> =>
    JSON.parse(fs.readFileSync(statePath, 'utf8')) as Array<Record<string, unknown>>;
  let jobMsgSeq = 0;
  const mkJobMsg = (senderId: string, text: string): FeishuInboundMessage => ({
    sessionId: `chat-${senderId}`,
    senderId,
    text,
    messageId: `jm-${++jobMsgSeq}`,
    messageType: 'text',
  });

  await checkAsync('进行中作业落盘：受理即写记录、完结摘除（重启补通知的数据源）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-jobs-'));
    try {
      const statePath = path.join(tmp, 'review-jobs.json');
      let release!: (v: { text: string; attemptId: string }) => void;
      const gate = new Promise<{ text: string; attemptId: string }>((r) => {
        release = r;
      });
      const handlers = mkJobsHandlers(new FakeChannel(), tmp, statePath, { diagnosisRunner: async () => gate });
      handlers.onCardAction({ operator: { open_id: 'u1' }, action: { value: { owner: 'u1', hta_diagnose: 'task-1', attempt: 'att-1', title: '修复登录' } } });
      await waitFor(() => fs.existsSync(statePath), '受理后落盘');
      const running = readJobsFile(statePath);
      assert.equal(running.length, 1);
      assert.equal(running[0]!.kind, 'diagnosis');
      assert.equal(running[0]!.openId, 'u1');
      assert.equal(typeof running[0]!.key, 'string', '作业键应为稳定 diagnosisId');
      assert.notEqual(running[0]!.key, 'task-1');
      assert.equal(running[0]!.taskId, 'task-1');
      assert.equal(running[0]!.title, '修复登录');
      release({ text: '诊断结论', attemptId: 'att-1' });
      await waitFor(() => readJobsFile(statePath).length === 0, '完结后摘除记录');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('重启后补发作业中断通知（按用户聚合、含文本可达出路）并清档；文本定位回填', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-jobs-'));
    try {
      const statePath = path.join(tmp, 'review-jobs.json');
      const never = new Promise<never>(() => {});
      // 上次进程：一项诊断 + 一项审查进行中时进程消亡（runner 永不返回，记录留在盘上）
      const dead = mkJobsHandlers(new FakeChannel(), tmp, statePath, {
        diagnosisRunner: () => never,
        aiReviewRunner: () => never,
      });
      dead.onCardAction({ operator: { open_id: 'u1' }, action: { value: { owner: 'u1', hta_diagnose: 'task-1', attempt: 'att-1', title: '修复登录' } } });
      dead.onCardAction({ operator: { open_id: 'u1' }, action: { value: { owner: 'u1', hta_review: 'att-9', title: '任务X' } } });
      await waitFor(() => fs.existsSync(statePath) && readJobsFile(statePath).length === 2, '两条进行中记录落盘');

      // 重启：新实例加载遗留记录
      const channel2 = new FakeChannel();
      const alive = mkJobsHandlers(channel2, tmp, statePath, { aiReviewRunner: async () => '审查结论：无问题' });
      await alive.notifyInterruptedJobs();
      assert.equal(channel2.notifies.length, 1, '按用户聚合为一条通知');
      const notice = channel2.notifies[0]!.text;
      assert.ok(notice.includes('机器人重启'), `应如实定性: ${notice}`);
      assert.ok(notice.includes('AI 诊断《修复登录》') && notice.includes('AI 审查《任务X》'), `应列清两条作业: ${notice}`);
      assert.ok(notice.includes('为什么失败') && notice.includes('重新审查这个任务'), `出路须文本可达: ${notice}`);
      assert.ok(notice.includes('原推送卡片上的按钮'), `应保留卡片出路: ${notice}`);
      assert.equal(readJobsFile(statePath).length, 0, '投递成功后遗留记录清档');

      // 文本定位回填：重启后「重新审查这个任务」仍能定位到被中断的审查（确定性分支，不经模型）
      await alive.handle(mkJobMsg('u1', '重新审查这个任务'));
      assert.ok(
        channel2.replies.some((r) => r.text.includes('正在重新发起 AI 审查：《任务X》')),
        `回填后文本分支应能重新发起，实际：${channel2.replies.map((r) => r.text).join(' | ')}`,
      );
      // 诊断回填：「重试这个任务」能定位任务但诊断结论未持久化，如实引导重新诊断
      await alive.handle(mkJobMsg('u1', '重试这个任务'));
      await waitFor(
        () => channel2.notifies.some((n) => n.text.includes('找不到《修复登录》的诊断结论')),
        '回填后重试应给出带任务名的如实指引',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('中断通知投递失败的记录保留到下次启动补投（重复优于丢失）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-jobs-'));
    try {
      const statePath = path.join(tmp, 'review-jobs.json');
      fs.writeFileSync(
        statePath,
        JSON.stringify([{ kind: 'diagnosis', openId: 'u1', key: 'task-1', title: '修复登录', startedAt: '2026-10-13T09:00:00' }]),
      );
      const failing = new FakeChannel();
      failing.notifyFails = true;
      const h1 = mkJobsHandlers(failing, tmp, statePath);
      await h1.notifyInterruptedJobs();
      assert.equal(failing.notifies.length, 0);
      assert.equal(readJobsFile(statePath).length, 1, '投递失败不得清档');
      // 下次启动（网络恢复）：新实例读到保留的记录并补投成功
      const channel2 = new FakeChannel();
      const h2 = mkJobsHandlers(channel2, tmp, statePath);
      await h2.notifyInterruptedJobs();
      assert.equal(channel2.notifies.length, 1, '恢复后应补投');
      assert.ok(channel2.notifies[0]!.text.includes('修复登录'));
      assert.equal(readJobsFile(statePath).length, 0, '补投成功后清档');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const mkSecurityHandlers = (
    channel: FakeChannel,
    tmp: string,
    extra: Partial<Pick<Parameters<typeof createBotHandlers>[0], 'diagnosisRunner' | 'followUpSender' | 'attemptIdFetcher' | 'aiReviewRunner'>> = {},
  ) => {
    const cfg = makeCfg('http://127.0.0.1:1');
    const router = new SessionRouter(cfg, null, false, { memory: new MemoryStore(tmp) });
    const confirmations = new ConfirmationManager(async () => undefined, { timeoutMs: 1000 });
    const fakeMcp = { tools: [] } as unknown as KanbanMcp;
    const supervisor = new McpSupervisor({ mcp: fakeMcp, initiallyAlive: false });
    return createBotHandlers({
      channel: channel as unknown as FeishuChannel,
      router,
      confirmations,
      cfg,
      mcp: fakeMcp,
      supervisor,
      reportServer: null,
      helpText: 'HELP',
      ...extra,
    });
  };
  const clickValue = (handlers: ReturnType<typeof createBotHandlers>, openId: string, value: Record<string, unknown>) =>
    handlers.onCardAction({ operator: { open_id: openId }, action: { value } } as FeishuCardAction);

  await checkAsync('诊断归属：旧卡片只重试自己的 diagnosisId，跨用户与旧 payload 安全拒绝，文本取最近诊断', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-diag-owner-'));
    const followUps: Array<{ attemptId: string; prompt: string }> = [];
    try {
      const channel = new FakeChannel();
      const handlers = mkSecurityHandlers(channel, tmp, {
        diagnosisRunner: async (opts) => ({
          text: opts.taskId === 'task-1' && diagnosisCount++ === 0 ? '诊断 A' : '诊断 B',
          attemptId: opts.taskId === 'task-1' && diagnosisCount === 1 ? 'att-A' : 'att-B',
        }),
        followUpSender: async (_url, attemptId, prompt) => {
          followUps.push({ attemptId, prompt });
        },
      });
      let diagnosisCount = 0;
      clickValue(handlers, 'u1', { hta_diagnose: 'task-1', attempt: 'att-A', owner: 'u1', title: '任务X' });
      await waitFor(() => channel.cards.length === 1, '诊断 A 卡片');
      clickValue(handlers, 'u1', { hta_diagnose: 'task-1', attempt: 'att-B', owner: 'u1', title: '任务X' });
      await waitFor(() => channel.cards.length === 2, '诊断 B 卡片');
      const retryA = buttonValues(channel.cards[0]!.card).find((v) => v.hta_retry)!;
      const retryB = buttonValues(channel.cards[1]!.card).find((v) => v.hta_retry)!;
      assert.equal(typeof retryA.diagnosisId, 'string', '重试按钮必须携带稳定 diagnosisId');
      assert.equal(retryA.owner, 'u1', '重试按钮必须绑定发起人');
      assert.notEqual(retryA.diagnosisId, retryB.diagnosisId, '两次诊断必须有不同 diagnosisId');

      const foreign = clickValue(handlers, 'u2', retryA);
      assert.ok(foreign?.toast?.content.includes('只有发起人'), '其他白名单用户不得操作他人的诊断卡片');
      assert.equal(followUps.length, 0, '跨用户点击不得读取或重试');
      const legacy = { ...retryA };
      delete legacy.diagnosisId;
      const stale = clickValue(handlers, 'u1', legacy);
      assert.ok(stale?.toast, '无 diagnosisId 的旧卡片必须有同步安全回执');
      assert.equal(followUps.length, 0, '无归属旧卡片不得重试');

      clickValue(handlers, 'u1', retryA);
      await waitFor(() => followUps.length === 1, '旧诊断 A 重试');
      assert.equal(followUps[0]!.attemptId, 'att-A', '旧诊断 A 不得读取最新 B 的 attemptId');
      assert.ok(followUps[0]!.prompt.includes('诊断 A') && !followUps[0]!.prompt.includes('诊断 B'), '旧卡片不得读取最新诊断文本');
      await handlers.handle(mkJobMsg('u1', '重试这个任务'));
      await waitFor(() => followUps.length === 2, '文本重试最近诊断 B');
      assert.equal(followUps[1]!.attemptId, 'att-B', '文本重试必须走该用户最近 diagnosisId');
      assert.ok(followUps[1]!.prompt.includes('诊断 B'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('诊断/审查按钮归属：旧或无 owner、他人 owner 均拒绝，仅发卡对象可启动', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-job-owner-'));
    let diagnoses = 0;
    let reviews = 0;
    try {
      const channel = new FakeChannel();
      const handlers = mkSecurityHandlers(channel, tmp, {
        diagnosisRunner: async () => {
          diagnoses++;
          return { text: '诊断', attemptId: 'att-1' };
        },
        aiReviewRunner: async () => {
          reviews++;
          return '审查';
        },
      });
      for (const owner of [undefined, 'u2']) {
        clickValue(handlers, 'u1', { hta_diagnose: 'task-1', attempt: 'att-1', owner, title: '任务X' });
        clickValue(handlers, 'u1', { hta_review: 'att-1', owner, title: '任务X' });
      }
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(diagnoses, 0, '无归属或他人诊断按钮不得启动');
      assert.equal(reviews, 0, '无归属或他人审查按钮不得启动');
      clickValue(handlers, 'u1', { hta_diagnose: 'task-1', attempt: 'att-1', owner: 'u1', title: '任务X' });
      clickValue(handlers, 'u1', { hta_review: 'att-1', owner: 'u1', title: '任务X' });
      await waitFor(() => diagnoses === 1 && reviews === 1, '仅归属用户可启动作业');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('/stop 中断重试：signal 贯穿 follow-up，计入回执；请求已发出时诚实提示不可撤回', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-retry-stop-'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let retrySignal: AbortSignal | undefined;
    let followUpStarted = false;
    try {
      const channel = new FakeChannel();
      const handlers = mkSecurityHandlers(channel, tmp, {
        diagnosisRunner: async () => ({ text: '诊断 A', attemptId: 'att-A' }),
        followUpSender: async (_url, _attempt, _prompt, signal) => {
          followUpStarted = true;
          retrySignal = signal;
          await gate;
        },
      });
      clickValue(handlers, 'u1', { hta_diagnose: 'task-1', attempt: 'att-A', owner: 'u1', title: '任务X' });
      await waitFor(() => channel.cards.length === 1, '诊断卡片');
      clickValue(handlers, 'u1', buttonValues(channel.cards[0]!.card).find((v) => v.hta_retry)!);
      await waitFor(() => followUpStarted, 'follow-up 已发起');
      await handlers.handle(mkJobMsg('u1', '/stop'));
      assert.ok(retrySignal?.aborted, '/stop 必须中断重试 AbortController');
      assert.ok(channel.replies.some((r) => r.text.includes('重试')), '/stop 回执必须计入重试');
      release();
      await waitFor(() => channel.notifies.some((n) => n.text.includes('无法撤回')), '已发出请求的诚实收尾');
      assert.ok(!channel.notifies.some((n) => n.text.includes('重试发起失败')), '中断不得误报为普通失败');
    } finally {
      release();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('/stop 在 attemptId 补拉阶段中断重试，signal 生效且不再发送 follow-up', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-retry-fetch-stop-'));
    let followUps = 0;
    let fetchStarted = false;
    let fetchSignal: AbortSignal | undefined;
    try {
      const channel = new FakeChannel();
      const handlers = mkSecurityHandlers(channel, tmp, {
        diagnosisRunner: async () => ({ text: '诊断 A' }),
        attemptIdFetcher: async (_url, _taskId, signal) => {
          fetchStarted = true;
          fetchSignal = signal;
          return new Promise<string | undefined>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
        followUpSender: async () => {
          followUps++;
        },
      });
      clickValue(handlers, 'u1', { hta_diagnose: 'task-1', owner: 'u1', title: '任务X' });
      await waitFor(() => channel.cards.length === 1, '诊断卡片');
      clickValue(handlers, 'u1', buttonValues(channel.cards[0]!.card).find((v) => v.hta_retry)!);
      await waitFor(() => fetchStarted, 'attemptId 补拉开始');
      await handlers.handle(mkJobMsg('u1', '/stop'));
      assert.ok(fetchSignal?.aborted, '/stop 必须贯穿 latestAttemptId 的 signal');
      await waitFor(() => channel.notifies.some((n) => n.text.includes('重试指令未发出')), '补拉阶段中断收尾');
      assert.equal(followUps, 0, '补拉被中断后不得发送 follow-up');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('stopAll 中断全部用户的诊断/审查/重试作业', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-stop-all-'));
    const signals: AbortSignal[] = [];
    const never = new Promise<never>(() => {});
    try {
      const channel = new FakeChannel();
      const handlers = mkSecurityHandlers(channel, tmp, {
        diagnosisRunner: async (opts) => {
          if (opts.taskId === 'task-1') {
            signals.push(opts.signal!);
            return never;
          }
          return { text: '诊断', attemptId: 'att-3' };
        },
        aiReviewRunner: async (opts) => {
          signals.push(opts.signal!);
          return never;
        },
        followUpSender: async (_url, _attempt, _prompt, signal) => {
          signals.push(signal!);
          return never;
        },
      });
      clickValue(handlers, 'u1', { hta_diagnose: 'task-1', attempt: 'att-1', owner: 'u1', title: '任务1' });
      clickValue(handlers, 'u2', { hta_review: 'att-2', owner: 'u2', title: '任务2' });
      await waitFor(() => signals.length === 2, '两个用户作业启动');
      clickValue(handlers, 'u2', { hta_diagnose: 'task-3', attempt: 'att-3', owner: 'u2', title: '任务3' });
      await waitFor(() => channel.cards.length === 1, '用于重试的诊断卡片');
      clickValue(handlers, 'u2', buttonValues(channel.cards[0]!.card).find((v) => v.hta_retry)!);
      await waitFor(() => signals.length === 3, '重试作业启动');
      handlers.stopAll();
      assert.ok(signals.every((s) => s.aborted), 'stopAll 必须中断全部已登记控制器');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
