/**
 * 定时周报（src/bot/weekly-brief.ts）单测：
 * - HH:MM 解析（合法/非法/边界）
 * - 星期解析（1-7，默认周五，非法抛错由启动告警兜底）
 * - 周报文本（「本周完成」按 updated_at 是否落在本周过滤、各分组与兜底文案）
 * - 只在设定星期触发、当天只推一次（注入假时钟与假推送函数）
 * - 看板不可达的降级路径（跳过不推、不标记，恢复后当天补推）
 * - 推送部分失败的补投（下一 tick 只补未送达 owner）
 * - 连续失败的指数退避（窗口内不重复采集/推送）
 * - 重启不重复推（落盘状态再加载）
 * 以 tsx 直接运行：tsx scripts/unit-weekly-brief.ts
 */

import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkAsync, finish } from './testkit';
import {
  WeeklyBrief,
  buildWeeklyBriefText,
  parseWeeklyBriefTime,
  parseWeeklyBriefDay,
} from '../src/bot/weekly-brief';
import type { WorkSummaryData, WorkSummaryTask } from '../src/kanban/summary';

/** 与 unit-daily-brief.ts 相同的私有 tick 驱动方式（不走真实定时器）。 */
const tickOf = (b: WeeklyBrief) => (b as unknown as { tick: () => Promise<void> }).tick.bind(b);

function fakeTask(over: Partial<WorkSummaryTask>): WorkSummaryTask {
  return {
    id: 't1',
    title: '任务',
    status: 'todo',
    iteration: '260717',
    projectName: 'demo',
    updatedAt: '2026-09-02T10:00:00', // 本地时间（无时区后缀按本地解析），落在测试当周
    diffUrl: 'http://localhost:7964/x',
    ...over,
  };
}

function fakeSummary(tasks: WorkSummaryTask[]): WorkSummaryData {
  // totals 是截断前全量计数（周报头部用）：按任务状态推导，保持与 tasks 一致
  const totals = { done: 0, inreview: 0, inprogress: 0, todo: 0, cancelled: 0, failed: 0, doneThisWeek: 0, filesChanged: 0, additions: 0, deletions: 0 };
  const weekStart = new Date(2026, 7, 31).getTime(); // 测试当周周一 00:00（与 at() 假时钟同周）
  for (const t of tasks) {
    if (t.status in totals) (totals as Record<string, number>)[t.status]!++;
    if (t.failed) totals.failed++; // 失败标记与状态正交
    const ts = Date.parse(t.updatedAt);
    if (t.status === 'done' && Number.isFinite(ts) && ts >= weekStart) totals.doneThisWeek++;
  }
  return {
    scope: 'iteration',
    iteration: '260717',
    generatedAt: '2026-09-04T10:30:00Z',
    sinceLabel: '迭代 260717',
    tasks,
    totals,
  };
}

/** 本地时间假时钟（周报判定用本地时区，不能用 UTC 构造）。2026-09-04 是周五，当周周一 08-31、周日 09-06。 */
const at = (h: number, m: number, day = 4) => new Date(2026, 8, day, h, m);

// 头部日期范围终点取推送当天（周五 09-04），不含未来的周日 09-06
const HEADER = '📅 看板周报 · 迭代 260717（2026-08-31 至 2026-09-04）';

async function main(): Promise<void> {
  // ---------- HH:MM 解析 ----------
  await checkAsync('parseWeeklyBriefTime：未设置/空串返回 null（功能关闭）', () => {
    assert.equal(parseWeeklyBriefTime(undefined), null);
    assert.equal(parseWeeklyBriefTime(''), null);
    assert.equal(parseWeeklyBriefTime('   '), null);
  });

  await checkAsync('parseWeeklyBriefTime：合法值与边界（00:00 / 23:59 / 单位数小时）', () => {
    assert.deepEqual(parseWeeklyBriefTime('18:00'), { hour: 18, minute: 0 });
    assert.deepEqual(parseWeeklyBriefTime('9:05'), { hour: 9, minute: 5 });
    assert.deepEqual(parseWeeklyBriefTime('00:00'), { hour: 0, minute: 0 });
    assert.deepEqual(parseWeeklyBriefTime('23:59'), { hour: 23, minute: 59 });
    assert.deepEqual(parseWeeklyBriefTime(' 08:00 '), { hour: 8, minute: 0 }); // 容忍首尾空白
  });

  await checkAsync('parseWeeklyBriefTime：非法值抛错（启动时 console.warn 提示并关闭）', () => {
    for (const bad of ['24:00', '09:60', '9:5', '9:30:00', 'abc', '12', '-1:30']) {
      assert.throws(() => parseWeeklyBriefTime(bad), /HTA_WEEKLY_BRIEF 值非法/, `应拒绝 ${bad}`);
    }
  });

  // ---------- 星期解析 ----------
  await checkAsync('parseWeeklyBriefDay：未设置/空串默认 5（周五）', () => {
    assert.equal(parseWeeklyBriefDay(undefined), 5);
    assert.equal(parseWeeklyBriefDay(''), 5);
    assert.equal(parseWeeklyBriefDay('   '), 5);
  });

  await checkAsync('parseWeeklyBriefDay：合法值 1-7（含首尾空白容忍）', () => {
    assert.equal(parseWeeklyBriefDay('1'), 1);
    assert.equal(parseWeeklyBriefDay('5'), 5);
    assert.equal(parseWeeklyBriefDay('7'), 7);
    assert.equal(parseWeeklyBriefDay(' 3 '), 3);
  });

  await checkAsync('parseWeeklyBriefDay：非法值抛错（启动告警并按默认周五处理，不关闭功能）', () => {
    for (const bad of ['0', '8', '10', 'x', '5.5', '-1', '周五']) {
      assert.throws(() => parseWeeklyBriefDay(bad), /HTA_WEEKLY_BRIEF_DAY 值非法/, `应拒绝 ${bad}`);
    }
  });

  // ---------- 周报文本 ----------
  await checkAsync('buildWeeklyBriefText：头部为迭代全量计数与当周日期范围，本周完成按 updated_at 落在本周过滤', () => {
    const data = fakeSummary([
      fakeTask({ id: 'a', title: '本周做完的事', status: 'done', updatedAt: '2026-09-02T10:00:00' }),
      fakeTask({ id: 'b', title: '上周做完的事', status: 'done', updatedAt: '2026-08-28T10:00:00' }), // 上周：不计入本周完成
      fakeTask({ id: 'c', title: '周一凌晨做完的事', status: 'done', updatedAt: '2026-08-31T00:00:00' }), // 周一 00:00 边界：计入
      fakeTask({ id: 'd', title: '审查这个 diff', status: 'inreview' }),
      fakeTask({ id: 'e', title: '失败的活', status: 'inprogress', failed: true }),
    ]);
    const text = buildWeeklyBriefText(data, at(18, 0));
    assert.ok(text.includes(HEADER), `头部含范围与当周日期: ${text.split('\n')[0]}`);
    assert.ok(text.includes('进行中 1 · 待办 0 · 待审阅 1 · 已完成 3（迭代累计） · 失败 1（含于上方状态）'), `计数行为迭代全量口径并标注「已完成」为累计口径: ${text.split('\n')[1]}`);
    assert.ok(text.includes('【本周完成】2 个'), `本周完成只含当周更新: ${text}`);
    assert.ok(text.includes('· 《本周做完的事》') && text.includes('· 《周一凌晨做完的事》'));
    assert.ok(!text.includes('· 《上周做完的事》'), '上周完成的不得出现在本周完成清单');
    assert.ok(text.includes('【待审阅积压】1 个') && text.includes('· 《审查这个 diff》'));
    // 失败分组与状态分组正交：标注原状态，避免「同一任务出现两次」的困惑
    assert.ok(text.includes('【失败】1 个') && text.includes('《失败的活》（进行中）'));
    // 配置了迭代：引导语指向迭代总结
    assert.ok(text.includes('总结一下这个迭代做了什么'), `迭代范围引导语: ${text}`);
  });

  await checkAsync('buildWeeklyBriefText：本周无新完成任务时如实说明（不虚构完成清单）', () => {
    const data = fakeSummary([
      fakeTask({ id: 'a', title: '还在做的活', status: 'inprogress' }),
      fakeTask({ id: 'b', title: '上周做完的事', status: 'done', updatedAt: '2026-08-20T10:00:00' }),
    ]);
    const text = buildWeeklyBriefText(data, at(18, 0));
    assert.ok(text.includes('本周暂无新完成的任务。'), `空完成兜底: ${text}`);
    assert.ok(!text.includes('【本周完成】'), '无本周完成时不输出该分组');
  });

  await checkAsync('buildWeeklyBriefText：updated_at 无法解析的已完成任务保守不计入本周完成', () => {
    const data = fakeSummary([
      fakeTask({ id: 'a', title: '时间不明的完成', status: 'done', updatedAt: 'not-a-date' }),
    ]);
    const text = buildWeeklyBriefText(data, at(18, 0));
    assert.ok(text.includes('本周暂无新完成的任务。'), `时间无法解析时宁缺毋假: ${text}`);
  });

  await checkAsync('buildWeeklyBriefText：未配置迭代时引导语明确「全部任务」（与周报范围口径一致）', () => {
    const data = fakeSummary([fakeTask({ id: 'a', title: '任务A', status: 'inprogress' })]);
    delete data.iteration; // 未配置 HELIOS_KANBAN_ITERATION：范围为全部任务
    data.sinceLabel = '全部任务';
    const text = buildWeeklyBriefText(data, at(18, 0));
    assert.ok(text.includes('📅 看板周报 · 全部任务'), `头部含全部任务: ${text.split('\n')[0]}`);
    assert.ok(text.includes('已完成 0（累计）'), `全部任务范围「已完成」标注累计口径: ${text.split('\n')[1]}`);
    assert.ok(text.includes('总结一下全部任务的看板进展'), `全量范围引导语: ${text}`);
    assert.ok(!text.includes('总结一下这个迭代做了什么'));
  });

  await checkAsync('buildWeeklyBriefText：空范围按口径给兜底文案（迭代 / 全量）', () => {
    assert.ok(buildWeeklyBriefText(fakeSummary([]), at(18, 0)).includes('这个迭代还没有任务。'));
    const all = fakeSummary([]);
    delete all.iteration;
    assert.ok(buildWeeklyBriefText(all, at(18, 0)).includes('看板上还没有任务。'));
  });

  await checkAsync('buildWeeklyBriefText：失败为 0 时不挂括注；单组超 10 个任务截断并提示剩余数量', () => {
    const tasks = Array.from({ length: 13 }, (_, i) =>
      fakeTask({ id: `t${i}`, title: `任务${i}`, status: 'done', updatedAt: '2026-09-02T10:00:00' }),
    );
    const text = buildWeeklyBriefText(fakeSummary(tasks), at(18, 0));
    assert.ok(text.includes('失败 0') && !text.includes('（含于上方状态）'), '失败为 0 不应挂括注');
    assert.ok(text.includes('【本周完成】13 个'), '计数为全量');
    assert.ok(text.includes('· 《任务9》') && !text.includes('· 《任务10》'), '只列前 10 个');
    assert.ok(text.includes('· …还有 3 个'), `应有截断提示: ${text}`);
  });

  await checkAsync('buildWeeklyBriefText：本周完成分组计数用截断前全量口径（totals.doneThisWeek），样本外任务不丢数也不报「暂无」', () => {
    // 模拟超 50 条截断：样本里只剩 1 条本周完成，全量计数为 3
    const data = fakeSummary([fakeTask({ id: 'a', title: '样本里的本周完成', status: 'done', updatedAt: '2026-09-02T10:00:00' })]);
    data.totals.doneThisWeek = 3;
    const text = buildWeeklyBriefText(data, at(18, 0));
    assert.ok(text.includes('【本周完成】3 个'), `分组计数为全量口径: ${text}`);
    assert.ok(text.includes('· …还有 2 个'), `样本外任务按全量补剩余数: ${text}`);
    assert.ok(!text.includes('本周暂无新完成的任务'), '全量口径非零时不得报「暂无」');
    // 极端场景：截断样本里一条本周完成都没有，但全量口径有——不得输出谎言「暂无」
    const none = fakeSummary([fakeTask({ id: 'b', title: '还在做的活', status: 'inprogress' })]);
    none.totals.doneThisWeek = 2;
    const noneText = buildWeeklyBriefText(none, at(18, 0));
    assert.ok(noneText.includes('【本周完成】2 个'), `样本为空时仍以全量口径计数: ${noneText}`);
    assert.ok(!noneText.includes('本周暂无新完成的任务'), '样本为空但全量非零时不得报「暂无」');
  });

  await checkAsync('buildWeeklyBriefText：头部日期范围终点取推送当天，不含未来日期', () => {
    const data = fakeSummary([fakeTask({ id: 'a', title: '任务A', status: 'inprogress' })]);
    const monday = new Date(2026, 7, 31, 9, 0); // 周一 08-31 推送（HTA_WEEKLY_BRIEF_DAY=1）
    const text = buildWeeklyBriefText(data, monday);
    assert.ok(text.includes('（2026-08-31 至 2026-08-31）'), `周一推送终点为当天: ${text.split('\n')[0]}`);
    assert.ok(!text.includes('2026-09-06'), '不得展示未来的周日');
    const friday = buildWeeklyBriefText(data, at(18, 0));
    assert.ok(friday.includes('（2026-08-31 至 2026-09-04）'), `周五推送终点为周五: ${friday.split('\n')[0]}`);
  });

  // ---------- 星期触发 / 当天只推一次 ----------
  await checkAsync('WeeklyBrief：只在设定星期到点触发，当天后续 tick 不重复推；下周同一天再推', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-weekly-'));
    try {
      const sent: string[] = [];
      let now = at(18, 0, 3); // 周四已到点：不是设定星期
      const brief = new WeeklyBrief({
        time: { hour: 18, minute: 0 },
        day: 5,
        statePath: path.join(tmp, 'weekly-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => now,
        healthCheck: async () => true,
        collect: async () => fakeSummary([fakeTask({ status: 'inprogress' })]),
      });
      const tick = tickOf(brief);
      await tick(); // 周四：不推
      assert.equal(sent.length, 0);
      now = at(17, 59, 4); // 周五未到点
      await tick();
      assert.equal(sent.length, 0);
      now = at(18, 0, 4); // 周五正好到点
      await tick();
      assert.equal(sent.length, 1);
      assert.ok(sent[0]!.includes('📅 看板周报'));
      now = at(18, 1, 4);
      await tick(); // 当天已推，不重复
      await tick();
      assert.equal(sent.length, 1);
      now = at(19, 0, 5); // 周六（若周五进程没开，错过当天本周不再补推）
      const brief2 = new WeeklyBrief({
        time: { hour: 18, minute: 0 },
        day: 5,
        statePath: path.join(tmp, 'weekly-brief-state2.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => now,
        healthCheck: async () => true,
        collect: async () => fakeSummary([]),
      });
      await tickOf(brief2)();
      assert.equal(sent.length, 1, '错过设定星期后本周其他天不推');
      now = at(18, 0, 11); // 下周五到点再推
      await tick();
      assert.equal(sent.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('WeeklyBrief：owner 未认领（白名单为空）不推也不标记，认领后当天仍可补推', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-weekly-'));
    try {
      const sent: string[] = [];
      let owners: string[] = [];
      const brief = new WeeklyBrief({
        time: { hour: 18, minute: 0 },
        day: 5,
        statePath: path.join(tmp, 'weekly-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => owners,
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => at(18, 30),
        healthCheck: async () => true,
        collect: async () => fakeSummary([]),
      });
      const tick = tickOf(brief);
      await tick(); // 无 owner：不推
      assert.equal(sent.length, 0);
      owners = ['o1']; // 当天稍后被认领
      await tick();
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 看板不可达降级 ----------
  await checkAsync('WeeklyBrief：看板不可达跳过本次（不推、不标记），恢复后退避窗口过补推', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-weekly-'));
    try {
      const sent: string[] = [];
      const logs: string[] = [];
      let healthy = false;
      let now = at(18, 5);
      const brief = new WeeklyBrief({
        time: { hour: 18, minute: 0 },
        day: 5,
        statePath: path.join(tmp, 'weekly-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => now,
        healthCheck: async () => healthy,
        collect: async () => fakeSummary([]),
        log: (m) => logs.push(m),
      });
      const tick = tickOf(brief);
      await tick(); // 不可达：跳过并记日志
      assert.equal(sent.length, 0);
      assert.ok(logs.some((l) => l.includes('看板不可达')), `应有跳过日志: ${logs}`);
      assert.equal(fs.existsSync(path.join(tmp, 'weekly-brief-state.json')), false, '不可达时不得落盘标记');
      healthy = true;
      now = at(18, 6); // 首次失败退避 1 分钟，窗口过后恢复即补推
      await tick();
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('WeeklyBrief：采集抛错同样跳过不标记（看板假死等健康检查未覆盖的场景）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-weekly-'));
    try {
      const sent: string[] = [];
      let fail = true;
      let now = at(18, 5);
      const brief = new WeeklyBrief({
        time: { hour: 18, minute: 0 },
        day: 5,
        statePath: path.join(tmp, 'weekly-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => now,
        healthCheck: async () => true,
        collect: async () => {
          if (fail) throw new Error('network reset');
          return fakeSummary([]);
        },
      });
      const tick = tickOf(brief);
      await tick();
      assert.equal(sent.length, 0);
      fail = false;
      now = at(18, 6); // 首次失败退避 1 分钟，窗口过后再试
      await tick();
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 推送失败补投 ----------
  await checkAsync('WeeklyBrief：部分 owner 推送失败，下一 tick 只补投未送达的（不刷屏已送达的）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-weekly-'));
    try {
      const sent: string[] = [];
      let o2Down = true;
      let now = at(18, 10);
      const brief = new WeeklyBrief({
        time: { hour: 18, minute: 0 },
        day: 5,
        statePath: path.join(tmp, 'weekly-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1', 'o2'],
        notifyOwner: async (o, text) => {
          if (o === 'o2' && o2Down) throw new Error('o2 unreachable');
          sent.push(`${o}:${text.split('\n')[0]}`);
        },
        now: () => now,
        healthCheck: async () => true,
        collect: async () => fakeSummary([]),
      });
      const tick = tickOf(brief);
      await tick(); // o1 送达，o2 失败
      assert.deepEqual(sent, [`o1:${HEADER}`]);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'weekly-brief-state.json'), 'utf8')) as {
        date: string;
        delivered: string[];
      };
      assert.equal(onDisk.date, '2026-09-04');
      assert.deepEqual(onDisk.delivered, ['o1']);
      o2Down = false;
      await tick(); // 退避窗口（1 分钟）未过：不重试
      assert.equal(sent.length, 1);
      now = at(18, 11);
      await tick(); // 只补投 o2
      assert.deepEqual(sent, [`o1:${HEADER}`, `o2:${HEADER}`]);
      await tick(); // 全员送达后当天不再推
      assert.equal(sent.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 失败指数退避 ----------
  await checkAsync('WeeklyBrief：连续失败按 1→2 分钟退避（退避窗口内不采集不推送）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-weekly-'));
    try {
      let now = at(18, 10);
      let healthCalls = 0;
      const brief = new WeeklyBrief({
        time: { hour: 18, minute: 0 },
        day: 5,
        statePath: path.join(tmp, 'weekly-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async () => {},
        now: () => now,
        healthCheck: async () => {
          healthCalls++;
          return false; // 看板持续不可达
        },
        collect: async () => fakeSummary([]),
      });
      const tick = tickOf(brief);
      await tick(); // 第 1 次尝试：失败，退避 1 分钟（至 18:11）
      assert.equal(healthCalls, 1);
      await tick(); // 18:10 退避窗口内：不重试
      assert.equal(healthCalls, 1);
      now = at(18, 11);
      await tick(); // 第 2 次尝试：失败，退避 2 分钟（至 18:13）
      assert.equal(healthCalls, 2);
      now = at(18, 12);
      await tick(); // 窗口内：不重试
      assert.equal(healthCalls, 2);
      now = at(18, 13);
      await tick(); // 窗口过后再试
      assert.equal(healthCalls, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 重启不重复推 ----------
  await checkAsync('WeeklyBrief：落盘状态再加载，重启当天不重复推（新实例从 state 文件恢复）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-weekly-'));
    const statePath = path.join(tmp, 'weekly-brief-state.json');
    try {
      const sent: string[] = [];
      const mk = () =>
        new WeeklyBrief({
          time: { hour: 18, minute: 0 },
          day: 5,
          statePath,
          kanbanUrl: 'http://unused',
          owners: () => ['o1'],
          notifyOwner: async (_o, text) => {
            sent.push(text);
          },
          now: () => at(18, 50),
          healthCheck: async () => true,
          collect: async () => fakeSummary([]),
        });
      await tickOf(mk())(); // 第一个实例推送并落盘
      assert.equal(sent.length, 1);
      await tickOf(mk())(); // 模拟重启：新实例从 state 文件恢复，当天不再推
      await tickOf(mk())();
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('WeeklyBrief：损坏的 state 文件按无状态处理（不崩，当天可重推）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-weekly-'));
    const statePath = path.join(tmp, 'weekly-brief-state.json');
    try {
      fs.writeFileSync(statePath, '{not json');
      const sent: string[] = [];
      const brief = new WeeklyBrief({
        time: { hour: 18, minute: 0 },
        day: 5,
        statePath,
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => at(18, 50),
        healthCheck: async () => true,
        collect: async () => fakeSummary([]),
      });
      await tickOf(brief)();
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  finish();
}

void main();
