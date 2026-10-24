import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { makeGatedWriter } from '../src/agent/tools/gated-write';
import { SourceRegistry } from '../src/agent/source-registry';
import { collectDailyData, collectWorkSummary, type WorkSummaryData } from '../src/kanban/summary';
import { renderHtml, renderMarkdown, summarizeForChat } from '../src/report/report';
import { buildDailyMaterial, renderDailyHtml } from '../src/report/daily-report';
import { buildRetroModel, buildRetroSummary, renderRetroHtml } from '../src/report/retro';
import { buildDailyBriefText } from '../src/bot/daily-brief';
import { buildWeeklyBriefText } from '../src/bot/weekly-brief';
import { checkAsync, finish } from './testkit';

const TASK_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SOURCE_URL = 'https://example.feishu.cn/docx/source';
const INCOMPLETE = { projectsTotal: 2, projectsSucceeded: 1, projectsFailed: 1 };
const INCOMPLETE_NOTE = '数据不完整：2 个项目中任务采集成功 1 个、失败 1 个；统计仅覆盖成功项目。';

async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function startKanban(projects: Array<{ id: string; name: string }>, failedProjects: Set<string>) {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (data: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    };
    if (url === '/api/projects') return json(projects);
    if (url === '/api/task-attempts/summary' && req.method === 'POST') return json([]);
    const tasks = /^\/api\/tasks\?project_id=([^&]+)$/.exec(url);
    if (tasks) {
      const projectId = tasks[1]!;
      if (failedProjects.has(projectId)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'project unavailable' }));
        return;
      }
      return json([
        {
          id: `task-${projectId}`,
          title: `任务 ${projectId}`,
          status: 'done',
          iteration: 'iter-1',
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    const detail = /^\/api\/tasks\/([^/?]+)$/.exec(url);
    if (detail) return json({});
    if (url.startsWith('/api/task-attempts?')) return json([]);
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function summaryFixture(): WorkSummaryData {
  return {
    scope: 'iteration',
    iteration: 'iter-1',
    generatedAt: new Date().toISOString(),
    sinceLabel: '迭代 iter-1',
    tasks: [
      {
        id: 'task-p1',
        title: '任务 p1',
        status: 'done',
        iteration: 'iter-1',
        projectName: '项目一',
        updatedAt: new Date().toISOString(),
        diffUrl: '',
      },
    ],
    totals: {
      done: 1,
      inreview: 0,
      inprogress: 0,
      todo: 0,
      cancelled: 0,
      failed: 0,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    },
    scopedTotal: 1,
    incomplete: INCOMPLETE,
  };
}

async function main(): Promise<void> {
  await checkAsync('create-and-start：创建成功但工作区未就绪仍记录来源和配额，审计保留警告；真正失败不记录', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-create-consistency-'));
    const server = http.createServer((req, res) => {
      if (req.url === `/api/task-attempts/${WORKSPACE_ID}`) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'missing' }));
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const registry = new SourceRegistry(tmp);
      const createCounter = { count: 0 };
      const write = makeGatedWriter({
        uid: 'u1',
        registry,
        kanbanUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        confirm: async () => 'once',
        auditHome: tmp,
        createCounter,
      });
      const params = {
        kind: 'hk' as const,
        summary: '创建并启动任务',
        detail: () => 'hk create-and-start',
        isCreate: true,
        isStart: true,
        urls: [SOURCE_URL],
        title: '任务',
        batchKey: 'hk:create-and-start',
        batchScope: 'kind' as const,
        destructive: false,
      };
      const output = await write({
        ...params,
        execute: async () => JSON.stringify({ task_id: TASK_ID, workspace_id: WORKSPACE_ID }),
      });
      assert.ok(output.includes('工作区初始化未完成'), output);
      assert.equal(createCounter.count, 1, '创建已产生任务 ID，工作区警告不得绕过会话配额');
      assert.equal(registry.lookup('u1', SOURCE_URL)?.taskId, TASK_ID, '创建成功后来源映射必须防重复创建');
      const audits = fs
        .readFileSync(path.join(tmp, 'audit.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { ok?: boolean; resultSnippet?: string });
      assert.equal(audits.at(-1)?.ok, false, '审计应能区分工作区未就绪');
      assert.ok(audits.at(-1)?.resultSnippet?.includes('工作区初始化未完成'));

      const failed = await write({
        ...params,
        urls: ['https://example.feishu.cn/docx/failed'],
        execute: async () => `命令执行失败：创建未执行 ${TASK_ID}`,
      });
      assert.ok(failed.includes('命令执行失败'));
      assert.equal(createCounter.count, 1, '真正创建失败不得增加配额计数');
      assert.equal(registry.lookup('u1', 'https://example.feishu.cn/docx/failed'), undefined);
    } finally {
      await stopServer(server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('项目任务全部采集失败：work summary 与 daily 均抛错，不生成全零报告', async () => {
    const projects = [
      { id: 'p1', name: '项目一' },
      { id: 'p2', name: '项目二' },
    ];
    const kanban = await startKanban(projects, new Set(['p1', 'p2']));
    try {
      await assert.rejects(collectWorkSummary({ kanbanUrl: kanban.url, scope: 'all' }), /2 个项目任务均采集失败/);
      await assert.rejects(collectDailyData({ kanbanUrl: kanban.url }), /2 个项目任务均采集失败/);
    } finally {
      await stopServer(kanban.server);
    }
  });

  await checkAsync('项目任务部分采集失败：work summary/daily 透传成功失败统计', async () => {
    const projects = [
      { id: 'p1', name: '项目一' },
      { id: 'p2', name: '项目二' },
    ];
    const kanban = await startKanban(projects, new Set(['p2']));
    try {
      const summary = await collectWorkSummary({ kanbanUrl: kanban.url, scope: 'all' });
      assert.deepEqual(summary.incomplete, INCOMPLETE);
      assert.deepEqual(summary.tasks.map((task) => task.id), ['task-p1']);
      const daily = await collectDailyData({ kanbanUrl: kanban.url });
      assert.deepEqual(daily.incomplete, INCOMPLETE);
      assert.equal(daily.counts.doneToday, 1);
    } finally {
      await stopServer(kanban.server);
    }
  });

  await checkAsync('部分采集失败提示覆盖 work summary/daily/retro 的 HTML 与文本输出', () => {
    const data = summaryFixture();
    for (const output of [renderMarkdown(data), renderHtml(data), summarizeForChat(data, {})]) {
      assert.ok(output.includes(INCOMPLETE_NOTE), output);
    }

    const daily = {
      date: '2026-10-24',
      isToday: true,
      generatedAt: data.generatedAt,
      iteration: 'iter-1',
      sinceLabel: '2026-10-24 今天 · 迭代 iter-1',
      counts: { doneToday: 1, inProgress: 0, failedToday: 0, inReviewToday: 0 },
      diff: null,
      tasks: data.tasks,
      truncated: false,
      incomplete: INCOMPLETE,
    };
    for (const output of [renderDailyHtml(daily), buildDailyMaterial(daily)]) {
      assert.ok(output.includes(INCOMPLETE_NOTE), output);
    }

    const retro = buildRetroModel(data);
    assert.deepEqual(retro.incomplete, INCOMPLETE);
    for (const output of [renderRetroHtml(retro), buildRetroSummary(retro)]) {
      assert.ok(output.includes(INCOMPLETE_NOTE), output);
    }
  });

  await checkAsync('部分采集失败提示覆盖晨报与周报，空清单也不得谎称看板无任务', () => {
    const data = summaryFixture();
    const daily = buildDailyBriefText(data, new Date(2026, 9, 24, 9, 30));
    const weekly = buildWeeklyBriefText(data, new Date(2026, 9, 23, 18, 0));
    assert.ok(daily.includes(INCOMPLETE_NOTE), daily);
    assert.ok(weekly.includes(INCOMPLETE_NOTE), weekly);

    const empty = { ...data, tasks: [], totals: { ...data.totals, done: 0 }, scopedTotal: 0 };
    const emptyDaily = buildDailyBriefText(empty, new Date(2026, 9, 24, 9, 30));
    const emptyWeekly = buildWeeklyBriefText(empty, new Date(2026, 9, 23, 18, 0));
    assert.ok(emptyDaily.includes(INCOMPLETE_NOTE), emptyDaily);
    assert.ok(emptyWeekly.includes(INCOMPLETE_NOTE), emptyWeekly);
  });

  finish();
}

void main();
