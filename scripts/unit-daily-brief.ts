/**
 * 定时晨报（src/bot/daily-brief.ts）单测：
 * - HH:MM 解析（合法/非法/边界）
 * - 到点触发、当天只推一次（注入假时钟与假推送函数）
 * - 看板不可达的降级路径（跳过不推、不标记，恢复后当天补推）
 * - 推送部分失败的补投（下一 tick 只补未送达 owner）
 * - 重启不重复推（落盘状态再加载）
 * 以 tsx 直接运行：tsx scripts/unit-daily-brief.ts
 */

import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkAsync, finish } from './testkit';
import {
  DailyBrief,
  buildDailyBriefText,
  parseDailyBriefTime,
} from '../src/bot/daily-brief';
import type { WorkSummaryData, WorkSummaryTask } from '../src/kanban/summary';

/** 与 unit-resilience.ts 相同的私有 tick 驱动方式（不走真实定时器）。 */
const tickOf = (b: DailyBrief) => (b as unknown as { tick: () => Promise<void> }).tick.bind(b);

function fakeTask(over: Partial<WorkSummaryTask>): WorkSummaryTask {
  return {
    id: 't1',
    title: '任务',
    status: 'todo',
    iteration: '260717',
    projectName: 'demo',
    updatedAt: '2026-08-10T01:00:00Z',
    diffUrl: 'http://localhost:7964/x',
    ...over,
  };
}

function fakeSummary(tasks: WorkSummaryTask[]): WorkSummaryData {
  return {
    scope: 'iteration',
    iteration: '260717',
    generatedAt: '2026-08-10T01:30:00Z',
    sinceLabel: '迭代 260717',
    tasks,
    totals: { done: 0, inreview: 0, inprogress: 0, todo: 0, cancelled: 0, filesChanged: 0, additions: 0, deletions: 0 },
  };
}

/** 本地时间假时钟（晨报判定用本地时区，不能用 UTC 构造）。 */
const at = (h: number, m: number, day = 10) => new Date(2026, 7, day, h, m);

async function main(): Promise<void> {
  // ---------- HH:MM 解析 ----------
  await checkAsync('parseDailyBriefTime：未设置/空串返回 null（功能关闭）', () => {
    assert.equal(parseDailyBriefTime(undefined), null);
    assert.equal(parseDailyBriefTime(''), null);
    assert.equal(parseDailyBriefTime('   '), null);
  });

  await checkAsync('parseDailyBriefTime：合法值与边界（00:00 / 23:59 / 单位数小时）', () => {
    assert.deepEqual(parseDailyBriefTime('09:30'), { hour: 9, minute: 30 });
    assert.deepEqual(parseDailyBriefTime('9:05'), { hour: 9, minute: 5 });
    assert.deepEqual(parseDailyBriefTime('00:00'), { hour: 0, minute: 0 });
    assert.deepEqual(parseDailyBriefTime('23:59'), { hour: 23, minute: 59 });
    assert.deepEqual(parseDailyBriefTime(' 08:00 '), { hour: 8, minute: 0 }); // 容忍首尾空白
  });

  await checkAsync('parseDailyBriefTime：非法值抛错（启动时 console.warn 提示并关闭）', () => {
    for (const bad of ['24:00', '09:60', '9:5', '9:30:00', 'abc', '12', '-1:30']) {
      assert.throws(() => parseDailyBriefTime(bad), /HTA_DAILY_BRIEF 值非法/, `应拒绝 ${bad}`);
    }
  });

  // ---------- 晨报文本 ----------
  await checkAsync('buildDailyBriefText：按状态分组计数与标题清单，失败按 failed 标记独立分组', () => {
    const data = fakeSummary([
      fakeTask({ id: 'a', title: '修复登录页', status: 'inprogress' }),
      fakeTask({ id: 'b', title: '写 **加粗** 标题', status: 'inprogress', failed: true }),
      fakeTask({ id: 'c', title: '审查这个 diff', status: 'inreview' }),
      fakeTask({ id: 'd', title: '完成的事', status: 'done' }),
    ]);
    const text = buildDailyBriefText(data, at(9, 30));
    assert.ok(text.includes('☀️ 看板晨报 · 迭代 260717'), '头部含范围');
    assert.ok(text.includes('进行中 2 · 待审阅 1 · 已完成 1 · 失败 1'), `计数行: ${text.split('\n')[1]}`);
    assert.ok(text.includes('【进行中】2 个') && text.includes('· 《修复登录页》'));
    assert.ok(text.includes('【待审阅】1 个') && text.includes('【已完成】1 个') && text.includes('【失败】1 个'));
    // 纯文本消息不做 markdown 解析：含 markdown 字符的标题原样保留
    assert.ok(text.includes('《写 **加粗** 标题》'), '标题原样输出');
  });

  await checkAsync('buildDailyBriefText：空范围给兜底文案', () => {
    const text = buildDailyBriefText(fakeSummary([]), at(9, 30));
    assert.ok(text.includes('当前范围内还没有任务。'));
  });

  // ---------- 到点触发 / 当天只推一次 ----------
  await checkAsync('DailyBrief：到点触发推送，当天后续 tick 不重复推；未到点不推', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-brief-'));
    try {
      const sent: string[] = [];
      let now = at(9, 29); // 未到点
      const brief = new DailyBrief({
        time: { hour: 9, minute: 30 },
        statePath: path.join(tmp, 'daily-brief-state.json'),
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
      await tick(); // 09:29 未到点
      assert.equal(sent.length, 0);
      now = at(9, 30); // 正好到点
      await tick();
      assert.equal(sent.length, 1);
      assert.ok(sent[0]!.includes('☀️ 看板晨报'));
      now = at(9, 31);
      await tick(); // 当天已推，不重复
      await tick();
      assert.equal(sent.length, 1);
      now = at(9, 30, 11); // 第二天到点再推
      await tick();
      assert.equal(sent.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('DailyBrief：owner 未认领（白名单为空）不推也不标记，认领后当天仍可补推', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-brief-'));
    try {
      const sent: string[] = [];
      let owners: string[] = [];
      const brief = new DailyBrief({
        time: { hour: 9, minute: 30 },
        statePath: path.join(tmp, 'daily-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => owners,
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => at(10, 0),
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
  await checkAsync('DailyBrief：看板不可达跳过本次（不推、不标记），恢复后当天下一 tick 补推', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-brief-'));
    try {
      const sent: string[] = [];
      const logs: string[] = [];
      let healthy = false;
      const brief = new DailyBrief({
        time: { hour: 9, minute: 30 },
        statePath: path.join(tmp, 'daily-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => at(9, 35),
        healthCheck: async () => healthy,
        collect: async () => fakeSummary([]),
        log: (m) => logs.push(m),
      });
      const tick = tickOf(brief);
      await tick(); // 不可达：跳过并记日志
      assert.equal(sent.length, 0);
      assert.ok(logs.some((l) => l.includes('看板不可达')), `应有跳过日志: ${logs}`);
      assert.equal(fs.existsSync(path.join(tmp, 'daily-brief-state.json')), false, '不可达时不得落盘标记');
      healthy = true; // 恢复后当天下一 tick 补推
      await tick();
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('DailyBrief：采集抛错同样跳过不标记（看板假死等健康检查未覆盖的场景）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-brief-'));
    try {
      const sent: string[] = [];
      let fail = true;
      const brief = new DailyBrief({
        time: { hour: 9, minute: 30 },
        statePath: path.join(tmp, 'daily-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => at(9, 35),
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
      await tick();
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 推送失败补投 ----------
  await checkAsync('DailyBrief：部分 owner 推送失败，下一 tick 只补投未送达的（不刷屏已送达的）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-brief-'));
    try {
      const sent: string[] = [];
      let o2Down = true;
      const brief = new DailyBrief({
        time: { hour: 9, minute: 30 },
        statePath: path.join(tmp, 'daily-brief-state.json'),
        kanbanUrl: 'http://unused',
        owners: () => ['o1', 'o2'],
        notifyOwner: async (o, text) => {
          if (o === 'o2' && o2Down) throw new Error('o2 unreachable');
          sent.push(`${o}:${text.split('\n')[0]}`);
        },
        now: () => at(9, 40),
        healthCheck: async () => true,
        collect: async () => fakeSummary([]),
      });
      const tick = tickOf(brief);
      await tick(); // o1 送达，o2 失败
      assert.deepEqual(sent, ['o1:☀️ 看板晨报 · 迭代 260717（2026-08-10）']);
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'daily-brief-state.json'), 'utf8')) as {
        date: string;
        delivered: string[];
      };
      assert.equal(onDisk.date, '2026-08-10');
      assert.deepEqual(onDisk.delivered, ['o1']);
      o2Down = false;
      await tick(); // 只补投 o2
      assert.deepEqual(sent, [
        'o1:☀️ 看板晨报 · 迭代 260717（2026-08-10）',
        'o2:☀️ 看板晨报 · 迭代 260717（2026-08-10）',
      ]);
      await tick(); // 全员送达后当天不再推
      assert.equal(sent.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 重启不重复推 ----------
  await checkAsync('DailyBrief：落盘状态再加载，重启当天不重复推（新实例从 state 文件恢复）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-brief-'));
    const statePath = path.join(tmp, 'daily-brief-state.json');
    try {
      const sent: string[] = [];
      const mk = () =>
        new DailyBrief({
          time: { hour: 9, minute: 30 },
          statePath,
          kanbanUrl: 'http://unused',
          owners: () => ['o1'],
          notifyOwner: async (_o, text) => {
            sent.push(text);
          },
          now: () => at(9, 50),
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

  await checkAsync('DailyBrief：损坏的 state 文件按无状态处理（不崩，当天可重推）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hta-brief-'));
    const statePath = path.join(tmp, 'daily-brief-state.json');
    try {
      fs.writeFileSync(statePath, '{not json');
      const sent: string[] = [];
      const brief = new DailyBrief({
        time: { hour: 9, minute: 30 },
        statePath,
        kanbanUrl: 'http://unused',
        owners: () => ['o1'],
        notifyOwner: async (_o, text) => {
          sent.push(text);
        },
        now: () => at(9, 50),
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
