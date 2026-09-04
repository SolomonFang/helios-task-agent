/**
 * 按需报告单测（个人工作日报 daily_report + 迭代复盘 iteration_retro）：
 * 1. 日期解析（今天/昨天/YYYY-MM-DD/非法值）与日界边界（恰好 00:00 计入、次日 00:00 不计入）
 * 2. collectDailyData 采集：日界过滤、进行中不受日期限制、失败/待审阅当日口径、diff 汇总与无数据 null
 * 3. 无数据时的诚实文案（空看板 / 无 diff 数据均不编造）
 * 4. classifyFailure 规则命中、首中优先与未命中归「其他」
 * 5. buildRetroModel：完成率、本周完成周界（恰好周一 00:00 计入）、失败归类、截断标记
 * 6. HTML 生成与 token 文件名、链接可达性提示
 * 7. 工具注册（handlers/openAiTools/LOCAL_TOOL_SUMMARY）与两个 handler 全链路（loopback mock 看板）
 * 8. diffUrl scheme 校验（javascript: 等按无链接处理）、日报截断注记与入口一致、
 *    bot 无链接基地址时省略本机路径、日报页本地时区口径注记
 * 仅用 loopback mock 服务，离线可跑。Run: npx tsx scripts/unit-reports.ts
 */

import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import {
  collectDailyData,
  isWithinDate,
  localDate,
  type DailyReportData,
  type WorkSummaryData,
  type WorkSummaryTask,
} from '../src/kanban/summary';
import { renderHtml, renderMarkdown } from '../src/report/report';
import { safeHttpUrl } from '../src/report/report-utils';
import {
  buildDailyMaterial,
  partitionDaily,
  renderDailyHtml,
  resolveReportDate,
  writeDailyReport,
} from '../src/report/daily-report';
import {
  buildRetroModel,
  buildRetroSummary,
  classifyFailure,
  renderRetroHtml,
  writeRetroReport,
} from '../src/report/retro';
import { buildTools, LOCAL_TOOL_SUMMARY } from '../src/agent/tools';
import { check, checkAsync, finish } from './testkit';

async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

/** 本地时间构造 → ISO（mock 数据时间戳统一走这里，避免时区歧义）。 */
function at(y: number, m: number, d: number, hh = 0, mm = 0, ss = 0): string {
  return new Date(y, m - 1, d, hh, mm, ss).toISOString();
}

/** 启动一个返回固定任务集的 mock 看板；tasks/stats 由调用方给定。 */
async function startMockKanban(handlers: {
  tasks: Array<Record<string, unknown>>;
  attemptStats?: unknown;
  taskDetails?: Record<string, unknown>;
  taskAttempts?: Record<string, unknown>;
}): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (data: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    };
    if (url === '/api/projects') return json([{ id: 'p1', name: 'Alpha' }]);
    if (url === '/api/task-attempts/summary' && req.method === 'POST') return json(handlers.attemptStats ?? []);
    if (url.startsWith('/api/tasks?')) return json(handlers.tasks);
    const detail = /^\/api\/tasks\/([^/?]+)$/.exec(url);
    if (detail) return json(handlers.taskDetails?.[detail[1]!] ?? {});
    const attempts = /^\/api\/task-attempts\?task_id=([^&]+)$/.exec(url);
    if (attempts) return json(handlers.taskAttempts?.[attempts[1]!] ?? []);
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function main(): Promise<void> {
  // 保活（同其它 unit 脚本）：避免无 ref'd handle 时进程提前退出、后续用例被静默跳过
  const keepAlive = setInterval(() => undefined, 60_000);
  try {
    await run();
  } finally {
    clearInterval(keepAlive);
  }
}

async function run(): Promise<void> {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const todayStr = localDate(now);
  const yesterday = new Date(y, m - 1, d - 1);
  const yesterdayStr = localDate(yesterday);

  // ================= 1. 日期解析与日界边界 =================

  check('resolveReportDate：缺省/今天/today 均为今天', (() => {
    const fixed = new Date(2026, 8, 4, 15, 30); // 2026-09-04 15:30
    return (
      resolveReportDate(undefined, fixed) === '2026-09-04' &&
      resolveReportDate('', fixed) === '2026-09-04' &&
      resolveReportDate('今天', fixed) === '2026-09-04' &&
      resolveReportDate('today', fixed) === '2026-09-04'
    );
  })());

  check('resolveReportDate：昨天/yesterday 与显式日期', (() => {
    const fixed = new Date(2026, 8, 4, 15, 30);
    return (
      resolveReportDate('昨天', fixed) === '2026-09-03' &&
      resolveReportDate('yesterday', fixed) === '2026-09-03' &&
      resolveReportDate('2026-08-01', fixed) === '2026-08-01'
    );
  })());

  check('resolveReportDate：跨月昨天与非法值（2026-02-31 / 乱文）拒绝', (() => {
    const monthStart = new Date(2026, 8, 1, 9, 0); // 2026-09-01 → 昨天为 2026-08-31
    return (
      resolveReportDate('昨天', monthStart) === '2026-08-31' &&
      resolveReportDate('2026-02-31') === null &&
      resolveReportDate('2026-13-01') === null &&
      resolveReportDate('大后天') === null
    );
  })());

  check('isWithinDate：恰好当日 00:00 计入，恰好次日 00:00 不计入', (() => {
    const date = '2026-09-04';
    return (
      isWithinDate(at(2026, 9, 4, 0, 0, 0), date) &&
      isWithinDate(at(2026, 9, 4, 23, 59, 59), date) &&
      !isWithinDate(at(2026, 9, 5, 0, 0, 0), date) &&
      !isWithinDate(at(2026, 9, 3, 23, 59, 59), date) &&
      !isWithinDate('not-a-date', date)
    );
  })());

  // ================= 2. collectDailyData 采集 =================

  await checkAsync('日报采集：日界过滤、进行中不限日期、四类计数与 diff 汇总', async () => {
    const kanban = await startMockKanban({
      tasks: [
        // 恰好今日 00:00 完成 → 计入今日完成
        { id: 't1', title: '零点完成', status: 'done', updated_at: at(y, m, d, 0, 0, 0) },
        // 恰好的次日 00:00 完成 → 不计入今日
        { id: 't2', title: '明日边界', status: 'done', updated_at: at(y, m, d + 1, 0, 0, 0) },
        // 三天前更新的进行中 → 计入进行中（不受日期限制），清单也包含
        { id: 't3', title: '存量进行中', status: 'inprogress', updated_at: at(y, m, d - 3, 12) },
        // 今日中午转入待审阅 → 计入新待审阅
        { id: 't4', title: '今日送审', status: 'inreview', updated_at: at(y, m, d, 12) },
        // 今日更新的失败进行中 → 同时计入进行中与今日失败（正交）
        { id: 't5', title: '今日失败', status: 'inprogress', updated_at: at(y, m, d, 10), last_attempt_failed: true },
        // 昨天完成的 → 不计入今日完成
        { id: 't6', title: '昨日完成', status: 'done', updated_at: at(y, m, d - 1, 18) },
      ],
      attemptStats: [{ workspace_id: 'att-1', files_changed: 3, additions: 10, deletions: 4 }],
      taskDetails: { t5: { last_attempt_summary: '2 tests failed in auth.spec.ts' } },
      taskAttempts: {
        t1: [{ id: 'att-1', created_at: '2026-01-01' }],
        t2: [{ id: 'att-2', created_at: '2026-01-01' }],
        t3: [{ id: 'att-3', created_at: '2026-01-01' }],
        t4: [{ id: 'att-4', created_at: '2026-01-01' }],
        t5: [{ id: 'att-5', created_at: '2026-01-01' }],
        t6: [{ id: 'att-6', created_at: '2026-01-01' }],
      },
    });
    try {
      const data = await collectDailyData({ kanbanUrl: kanban.url, date: todayStr });
      assert.equal(data.date, todayStr);
      assert.equal(data.isToday, true);
      assert.ok(data.sinceLabel.includes('今天'), `sinceLabel 实际：${data.sinceLabel}`);
      assert.ok(data.sinceLabel.includes('全部任务'), `未配置迭代应标注全部任务：${data.sinceLabel}`);
      assert.deepEqual(data.counts, { doneToday: 1, inProgress: 2, failedToday: 1, inReviewToday: 1 });
      // 清单 = 当日更新 ∪ 进行中：t1/t3/t4/t5（t2 明日边界、t6 昨日完成均出局）
      assert.deepEqual(
        data.tasks.map((t) => t.id).sort(),
        ['t1', 't3', 't4', 't5'],
        `清单实际：${data.tasks.map((t) => t.id).join(',')}`,
      );
      // diff 仅汇总当日更新任务（t1 有统计，t5 无）
      assert.deepEqual(data.diff, { filesChanged: 3, additions: 10, deletions: 4 });
      assert.equal(data.truncated, false);
      const part = partitionDaily(data);
      assert.deepEqual(part.doneToday.map((t) => t.id), ['t1']);
      assert.deepEqual(part.inProgress.map((t) => t.id).sort(), ['t3', 't5']);
      assert.deepEqual(part.failedToday.map((t) => t.id), ['t5']);
      assert.deepEqual(part.inReviewToday.map((t) => t.id), ['t4']);
      assert.equal(part.failedToday[0]!.attemptSummary, '2 tests failed in auth.spec.ts');
    } finally {
      await stopServer(kanban.server);
    }
  });

  await checkAsync('日报采集：目标昨天时，恰好今日 00:00 的任务不计入（跨天边界）', async () => {
    const kanban = await startMockKanban({
      tasks: [
        { id: 't1', title: '今日零点', status: 'done', updated_at: at(y, m, d, 0, 0, 0) },
        { id: 't2', title: '昨日傍晚', status: 'done', updated_at: at(y, m, d - 1, 18) },
      ],
    });
    try {
      const data = await collectDailyData({ kanbanUrl: kanban.url, date: yesterdayStr });
      assert.equal(data.isToday, false);
      assert.ok(!data.sinceLabel.includes('今天'), `昨天不应标「今天」：${data.sinceLabel}`);
      assert.equal(data.counts.doneToday, 1);
      assert.deepEqual(data.tasks.map((t) => t.id), ['t2']);
      // 昨日任务无 diff 统计 → null（不拿 0 冒充）
      assert.equal(data.diff, null);
    } finally {
      await stopServer(kanban.server);
    }
  });

  await checkAsync('日报采集：迭代过滤与素材文案', async () => {
    const kanban = await startMockKanban({
      tasks: [
        { id: 't1', title: '迭代内任务', status: 'done', iteration: '260717', updated_at: at(y, m, d, 9) },
        { id: 't2', title: '迭代外任务', status: 'done', iteration: '260700', updated_at: at(y, m, d, 9) },
      ],
    });
    try {
      const data = await collectDailyData({ kanbanUrl: kanban.url, date: todayStr, iteration: '260717' });
      assert.equal(data.counts.doneToday, 1);
      assert.ok(data.sinceLabel.includes('迭代 260717'), `sinceLabel 实际：${data.sinceLabel}`);
      const material = buildDailyMaterial(data, {});
      assert.ok(material.includes('日报素材已生成'));
      assert.ok(material.includes('今日完成 1'));
      assert.ok(material.includes('《迭代内任务》'));
      assert.ok(!material.includes('《迭代外任务》'));
      assert.ok(material.includes('看板未提供当日任务的改动数据'), `无 diff 时应如实说明：${material}`);
    } finally {
      await stopServer(kanban.server);
    }
  });

  // ================= 3. 无数据诚实文案 =================

  await checkAsync('日报素材：空看板时如实说明无数据、提示不要编造', async () => {
    const kanban = await startMockKanban({ tasks: [] });
    try {
      const data = await collectDailyData({ kanbanUrl: kanban.url, date: todayStr });
      assert.equal(data.tasks.length, 0);
      const material = buildDailyMaterial(data, {});
      assert.ok(material.includes('没有任何看板活动记录'), `空看板文案缺失：${material}`);
      assert.ok(material.includes('不要编造'), `应提示不要编造：${material}`);
      const html = renderDailyHtml(data);
      assert.ok(html.includes('当日没有看板活动记录'), `HTML 空态文案缺失`);
    } finally {
      await stopServer(kanban.server);
    }
  });

  // ================= 4. classifyFailure 规则 =================

  check('classifyFailure：各类关键词命中与首中优先', (() => {
    return (
      classifyFailure('Merge conflict in src/a.ts, please rebase') === '合并冲突' &&
      classifyFailure('2 tests failed in auth.spec.ts (jest)') === '测试失败' &&
      classifyFailure('测试未通过：登录用例断言失败') === '测试失败' &&
      classifyFailure('tsc: Type error TS2345 in build') === '构建错误' &&
      classifyFailure('Error: request timed out after 10m') === '执行超时' &&
      classifyFailure('npm ERR! code ECONNREFUSED during install') === '环境或依赖' &&
      // 首中优先：冲突与测试同时出现 → 归合并冲突
      classifyFailure('tests failed after merge conflict') === '合并冲突' &&
      // 未命中与无摘要 → 其他
      classifyFailure('实现到一半发现需求描述不清') === '其他' &&
      classifyFailure('') === '其他' &&
      classifyFailure(undefined) === '其他'
    );
  })());

  // ================= 5. buildRetroModel =================

  await checkAsync('复盘模型：完成率、本周完成周界、失败归类与截断标记', async () => {
    // 注入固定 now，算出本周一 00:00（与 retro 内 startOfWeek 同口径推导期望值）
    const retroNow = new Date(y, m - 1, d, 15, 0, 0);
    const monday = new Date(y, m - 1, d);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const tasks = [
      // 恰好周一 00:00 完成 → 计入本周完成
      { id: 'a', title: '周一零点完成', status: 'done', updatedAt: monday.toISOString(), iteration: '', projectName: 'Alpha', diffUrl: '' },
      // 上周日 23:59:59 完成 → 不计入本周
      {
        id: 'b',
        title: '上周完成',
        status: 'done',
        updatedAt: new Date(monday.getTime() - 1000).toISOString(),
        iteration: '',
        projectName: 'Alpha',
        diffUrl: '',
      },
      {
        id: 'c',
        title: '失败-测试',
        status: 'inprogress',
        updatedAt: retroNow.toISOString(),
        iteration: '',
        projectName: 'Alpha',
        diffUrl: '',
        failed: true,
        attemptSummary: 'jest: 3 tests failed',
      },
      {
        id: 'd',
        title: '失败-无摘要',
        status: 'todo',
        updatedAt: retroNow.toISOString(),
        iteration: '',
        projectName: 'Alpha',
        diffUrl: '',
        failed: true,
      },
      { id: 'e', title: '进行中', status: 'inprogress', updatedAt: retroNow.toISOString(), iteration: '', projectName: 'Alpha', diffUrl: '' },
    ];
    const data: WorkSummaryData = {
      scope: 'iteration',
      iteration: '260717',
      generatedAt: retroNow.toISOString(),
      sinceLabel: '迭代 260717',
      tasks,
      totals: {
        done: 2,
        inreview: 0,
        inprogress: 2,
        todo: 1,
        cancelled: 0,
        failed: 2,
        filesChanged: 5,
        additions: 20,
        deletions: 8,
      },
    };
    const model = buildRetroModel(data, retroNow);
    assert.equal(model.total, 5);
    assert.equal(model.completionRate, 2 / 5);
    assert.equal(model.doneThisWeek, 1, '恰周一 00:00 计入、上周日 23:59 不计入');
    assert.equal(model.doneTotal, 2);
    assert.equal(model.failedTotal, 2);
    assert.deepEqual(
      model.failureGroups.map((g) => [g.category, g.tasks.length]),
      [['测试失败', 1], ['其他', 1]],
      `失败归类实际：${JSON.stringify(model.failureGroups.map((g) => [g.category, g.tasks.map((t) => t.id)]))}`,
    );
    assert.deepEqual(model.diff, { filesChanged: 5, additions: 20, deletions: 8 });
    assert.equal(model.truncated, false);

    // 空范围：完成率 null（不显示 0% 冒充）
    const empty = buildRetroModel(
      { ...data, tasks: [], totals: { done: 0, inreview: 0, inprogress: 0, todo: 0, cancelled: 0, failed: 0, filesChanged: 0, additions: 0, deletions: 0 } },
      retroNow,
    );
    assert.equal(empty.completionRate, null);
    assert.equal(empty.total, 0);
    const summary = buildRetroSummary(empty, {});
    assert.ok(summary.includes('没有任务'), `空范围摘要应如实说明：${summary}`);

    // 截断：概览全量、样本口径标注
    const truncated = buildRetroModel({ ...data, totals: { ...data.totals, done: 40 } }, retroNow);
    assert.equal(truncated.truncated, true);
    assert.ok(buildRetroSummary(truncated, {}).includes('样本口径'), '截断时摘要应注明样本口径');
  });

  // ================= 6. HTML 生成与 token 文件名 =================

  await checkAsync('报告写盘：token 文件名、自包含 HTML 与链接可达性提示', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-reports-'));
    const prevHome = process.env.HELIOS_TASK_AGENT_HOME;
    process.env.HELIOS_TASK_AGENT_HOME = tmp;
    try {
      const kanban = await startMockKanban({
        tasks: [
          { id: 't1', title: '今日完成的任务', status: 'done', iteration: '260717', updated_at: at(y, m, d, 9) },
          { id: 't2', title: '失败任务', status: 'inprogress', iteration: '260717', updated_at: at(y, m, d, 10), last_attempt_failed: true },
        ],
        taskDetails: { t2: { last_attempt_summary: 'Merge conflict in src/a.ts' } },
      });
      try {
        const daily = await collectDailyData({ kanbanUrl: kanban.url, date: todayStr, iteration: '260717' });
        const dailyPath = writeDailyReport(daily);
        assert.ok(
          /daily-report-\d{4}-\d{2}-\d{2}\.[0-9a-f]{32}\.html$/.test(dailyPath),
          `日报文件名应带 128-bit token：${dailyPath}`,
        );
        const dailyHtml = fs.readFileSync(dailyPath, 'utf8');
        assert.ok(dailyHtml.includes('工作日报') && dailyHtml.includes('今日完成的任务'), '日报 HTML 缺内容');
        assert.ok(!dailyHtml.includes('<script'), '日报 HTML 应为无 JS 自包含页面');

        const material = buildDailyMaterial(daily, { htmlPath: dailyPath, linkBaseUrl: 'http://localhost:51234' });
        assert.ok(material.includes(`http://localhost:51234/${path.basename(dailyPath)}`), '素材应含 HTTP 链接');
        assert.ok(material.includes('仅本机可达'), '回环链接应附可达性提示');

        // 复盘：复用 work-summary 采集（经 handler 同款路径外的直接调用，覆盖渲染与写盘）
        const { collectWorkSummary } = await import('../src/kanban/summary');
        const wsData = await collectWorkSummary({ kanbanUrl: kanban.url, scope: 'iteration', iteration: '260717' });
        const model = buildRetroModel(wsData);
        const retroPath = writeRetroReport(model);
        assert.ok(
          /iteration-retro-.+\.[0-9a-f]{32}\.html$/.test(retroPath),
          `复盘文件名应带 128-bit token：${retroPath}`,
        );
        const retroHtml = fs.readFileSync(retroPath, 'utf8');
        assert.ok(retroHtml.includes('迭代复盘') && retroHtml.includes('合并冲突'), '复盘 HTML 缺失败归类');
        assert.ok(retroHtml.includes('口径') || retroHtml.includes('规则归类'), '复盘 HTML 缺口径说明');
        const retroSummary = buildRetroSummary(model, { htmlPath: retroPath, linkBaseUrl: 'http://localhost:51234' });
        assert.ok(retroSummary.includes('迭代复盘报告已生成'));
        assert.ok(retroSummary.includes('合并冲突 1 个'), `复盘摘要缺归类计数：${retroSummary}`);
        assert.ok(retroSummary.includes('仅本机可达'));
      } finally {
        await stopServer(kanban.server);
      }
    } finally {
      if (prevHome === undefined) delete process.env.HELIOS_TASK_AGENT_HOME;
      else process.env.HELIOS_TASK_AGENT_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ================= 7. 工具注册与 handler 全链路 =================

  await checkAsync('工具注册：daily_report 与 iteration_retro 进入 handlers/openAiTools/摘要', async () => {
    const { openAiTools, handlers } = buildTools({ mcp: null, kanbanUrl: 'http://localhost:1' });
    const names = openAiTools.map((t) => t.function.name);
    assert.ok(names.includes('daily_report') && names.includes('iteration_retro'), `openAiTools 缺新工具：${names.join(',')}`);
    assert.ok(handlers.has('daily_report') && handlers.has('iteration_retro'), 'handlers 缺新工具');
    assert.ok(
      LOCAL_TOOL_SUMMARY.some((t) => t.name === 'daily_report') && LOCAL_TOOL_SUMMARY.some((t) => t.name === 'iteration_retro'),
      'LOCAL_TOOL_SUMMARY 缺新工具',
    );
  });

  await checkAsync('daily_report handler：全链路生成素材与 HTTP 链接，不触发确认闸门', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-reports-h-'));
    const prevHome = process.env.HELIOS_TASK_AGENT_HOME;
    process.env.HELIOS_TASK_AGENT_HOME = tmp;
    try {
      const kanban = await startMockKanban({
        tasks: [{ id: 't1', title: '今日完成', status: 'done', updated_at: at(y, m, d, 9) }],
      });
      try {
        const { handlers } = buildTools({
          mcp: null,
          kanbanUrl: kanban.url,
          reportLinkBaseUrl: 'http://localhost:51234',
          confirm: async () => {
            throw new Error('只读报告工具不应触发确认闸门');
          },
        });
        const out = await handlers.get('daily_report')!({});
        assert.ok(out.includes('日报素材已生成'), `输出缺素材头：${out}`);
        assert.ok(out.includes('今日完成 1'), `输出缺计数：${out}`);
        assert.ok(out.includes('http://localhost:51234/daily-report-'), `输出缺报告链接：${out}`);
        assert.ok(out.includes('仅本机可达'), '输出缺可达性提示');

        // 非法日期 → 中文提示，不发请求
        const bad = await handlers.get('daily_report')!({ date: '大后天' });
        assert.ok(bad.includes('日期参数无法识别'), `非法日期提示缺失：${bad}`);

        // html:false → 不生成链接，素材仍在
        const noHtml = await handlers.get('daily_report')!({ html: false });
        assert.ok(!noHtml.includes('http://localhost:51234/'), `html:false 不应给链接：${noHtml}`);
        assert.ok(noHtml.includes('日报素材已生成'));

        // 指定昨天 → 计数为空口径但正常生成
        const yd = await handlers.get('daily_report')!({ date: '昨天' });
        assert.ok(yd.includes('今日完成 0'), `昨天口径应为空：${yd}`);
      } finally {
        await stopServer(kanban.server);
      }
    } finally {
      if (prevHome === undefined) delete process.env.HELIOS_TASK_AGENT_HOME;
      else process.env.HELIOS_TASK_AGENT_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('iteration_retro handler：全链路生成复盘与 HTTP 链接，不触发确认闸门', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-unit-reports-r-'));
    const prevHome = process.env.HELIOS_TASK_AGENT_HOME;
    process.env.HELIOS_TASK_AGENT_HOME = tmp;
    try {
      const kanban = await startMockKanban({
        tasks: [
          { id: 't1', title: '迭代内完成', status: 'done', iteration: '260717', updated_at: at(y, m, d, 9) },
          { id: 't2', title: '迭代内失败', status: 'inprogress', iteration: '260717', updated_at: at(y, m, d, 10), last_attempt_failed: true },
          { id: 't3', title: '迭代外任务', status: 'todo', iteration: '260700', updated_at: at(y, m, d, 11) },
        ],
        taskDetails: { t2: { last_attempt_summary: 'Error: timed out after 10m' } },
      });
      try {
        const { handlers } = buildTools({
          mcp: null,
          kanbanUrl: kanban.url,
          kanbanIteration: '260717',
          reportLinkBaseUrl: 'http://localhost:51234',
          confirm: async () => {
            throw new Error('只读报告工具不应触发确认闸门');
          },
        });
        const out = await handlers.get('iteration_retro')!({});
        assert.ok(out.includes('迭代复盘报告已生成（迭代 260717）'), `输出缺标题：${out}`);
        assert.ok(out.includes('任务总数 2'), `迭代过滤后总数应为 2：${out}`);
        assert.ok(out.includes('执行超时 1 个'), `输出缺失败归类：${out}`);
        assert.ok(!out.includes('迭代外任务'), '迭代外任务不应进入复盘');
        assert.ok(out.includes('http://localhost:51234/iteration-retro-'), `输出缺报告链接：${out}`);

        // 无默认迭代且未指定 → 全部任务口径
        const { handlers: h2 } = buildTools({ mcp: null, kanbanUrl: kanban.url, reportLinkBaseUrl: 'http://localhost:51234' });
        const out2 = await h2.get('iteration_retro')!({});
        assert.ok(out2.includes('（全部任务）'), `无迭代时应标注全部任务口径：${out2}`);
        assert.ok(out2.includes('任务总数 3'), `全部任务口径总数应为 3：${out2}`);
      } finally {
        await stopServer(kanban.server);
      }
    } finally {
      if (prevHome === undefined) delete process.env.HELIOS_TASK_AGENT_HOME;
      else process.env.HELIOS_TASK_AGENT_HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // renderRetroHtml 空范围不崩（零任务迭代）
  check('renderRetroHtml：零任务范围正常渲染空态', (() => {
    const model = buildRetroModel({
      scope: 'iteration',
      iteration: '260717',
      generatedAt: new Date().toISOString(),
      sinceLabel: '迭代 260717',
      tasks: [],
      totals: { done: 0, inreview: 0, inprogress: 0, todo: 0, cancelled: 0, failed: 0, filesChanged: 0, additions: 0, deletions: 0 },
    });
    const html = renderRetroHtml(model);
    return html.includes('迭代复盘') && html.includes('—') && !html.includes('<script');
  })());

  // ================= 8. diffUrl scheme 校验 / 截断注记 / bot 省略本机路径 =================

  const mkTask = (id: string, over: Partial<WorkSummaryTask> = {}): WorkSummaryTask => ({
    id,
    title: `任务${id}`,
    status: 'done',
    iteration: '',
    projectName: 'Alpha',
    updatedAt: at(y, m, d, 9),
    diffUrl: '',
    ...over,
  });
  const dailyFixture = (tasks: WorkSummaryTask[]): DailyReportData => ({
    date: todayStr,
    isToday: true,
    generatedAt: new Date().toISOString(),
    sinceLabel: `${todayStr} 今天 · 全部任务`,
    counts: { doneToday: tasks.length, inProgress: 0, failedToday: 0, inReviewToday: 0 },
    diff: null,
    tasks,
    truncated: false,
  });
  const wsFixture = (tasks: WorkSummaryTask[]): WorkSummaryData => ({
    scope: 'all',
    generatedAt: new Date().toISOString(),
    sinceLabel: '全部任务',
    tasks,
    totals: { done: tasks.length, inreview: 0, inprogress: 0, todo: 0, cancelled: 0, failed: 0, filesChanged: 0, additions: 0, deletions: 0 },
  });

  check('safeHttpUrl：仅放行 http/https，伪协议与畸形串按无链接处理', (() => {
    return (
      safeHttpUrl('https://kanban.example.com/diff/1') === 'https://kanban.example.com/diff/1' &&
      safeHttpUrl('http://127.0.0.1:7964/x') === 'http://127.0.0.1:7964/x' &&
      safeHttpUrl('javascript:alert(1)') === undefined &&
      safeHttpUrl('file:///etc/passwd') === undefined &&
      safeHttpUrl('not a url') === undefined &&
      safeHttpUrl('') === undefined &&
      safeHttpUrl(undefined) === undefined
    );
  })());

  check('diffUrl 伪协议不进报告：日报/复盘/工作总结 HTML 与 MD 均按无链接处理', (() => {
    const evil = mkTask('e1', { diffUrl: 'javascript:alert(1)' });
    const good = mkTask('e2', { diffUrl: 'https://kanban.example.com/diff/1' });
    const dailyHtml = renderDailyHtml(dailyFixture([evil, good]));
    if (dailyHtml.includes('javascript:') || !dailyHtml.includes('https://kanban.example.com/diff/1')) return false;

    const ws = wsFixture([evil, good]);
    const md = renderMarkdown(ws);
    const html = renderHtml(ws);
    if (md.includes('javascript:') || html.includes('javascript:')) return false;
    if (!md.includes('[查看 diff](<https://kanban.example.com/diff/1>)')) return false;
    if (!html.includes('href="https://kanban.example.com/diff/1"')) return false;

    const retroHtml = renderRetroHtml(
      buildRetroModel({
        ...wsFixture([{ ...evil, failed: true, attemptSummary: 'tests failed' }]),
        totals: { done: 0, inreview: 0, inprogress: 1, todo: 0, cancelled: 0, failed: 1, filesChanged: 0, additions: 0, deletions: 0 },
      }),
    );
    return !retroHtml.includes('javascript:');
  })());

  check('日报页口径注记含「当日」按部署机器本地时区日界统计（与复盘页口径对齐）', (() => {
    return renderDailyHtml(dailyFixture([mkTask('t1')])).includes('「当日」按部署机器本地时区日界统计');
  })());

  check('日报截断注记：指引与实际给出的入口一致，数量与指引间有标点', (() => {
    const data = dailyFixture(Array.from({ length: 12 }, (_, i) => mkTask(`n${i}`)));
    const withLink = buildDailyMaterial(data, { htmlPath: '/tmp/r.html', linkBaseUrl: 'http://localhost:51234' });
    const withFile = buildDailyMaterial(data, { htmlPath: '/tmp/r.html' });
    const noReport = buildDailyMaterial(data, {});
    const botNoLink = buildDailyMaterial(data, { htmlPath: '/tmp/r.html', channel: 'bot' });
    return (
      withLink.includes('· …还有 2 个，见上方报告链接') &&
      withFile.includes('· …还有 2 个，见报告文件') &&
      noReport.includes('· …还有 2 个，完整清单可直接问我') &&
      botNoLink.includes('· …还有 2 个，完整清单可直接问我')
    );
  })());

  check('bot 场景无链接基地址时省略本机路径（死链+目录泄露），CLI 保留本机路径', (() => {
    const data = dailyFixture([mkTask('b1')]);
    const daily = buildDailyMaterial(data, { htmlPath: '/home/deploy/reports/r.html', channel: 'bot' });
    const retro = buildRetroSummary(buildRetroModel(wsFixture([mkTask('b2')])), {
      htmlPath: '/home/deploy/reports/r.html',
      channel: 'bot',
    });
    const cliDaily = buildDailyMaterial(data, { htmlPath: '/home/deploy/reports/r.html', channel: 'cli' });
    const cliRetro = buildRetroSummary(buildRetroModel(wsFixture([mkTask('b3')])), {
      htmlPath: '/home/deploy/reports/r.html',
    });
    return (
      !daily.includes('/home/deploy') &&
      !retro.includes('/home/deploy') &&
      daily.includes('日报素材已生成') &&
      retro.includes('迭代复盘报告已生成') &&
      cliDaily.includes('- HTML 日报：/home/deploy/reports/r.html') &&
      cliRetro.includes('- HTML：/home/deploy/reports/r.html')
    );
  })());

  finish();
}

void main();
