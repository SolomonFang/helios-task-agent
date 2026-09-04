/**
 * 定时提醒（src/agent/reminder.ts + tools/reminder-tools.ts）单测：
 * - 时间解析：相对分钟数 / HH:mm（已过顺延次日）/ 今天·明天·后天 / 口语「9 点·9 点半」/
 *   YYYY-MM-DD HH:mm / 带时区标准串；非法输入、过去时间、超 30 天期限、双参数互斥一律拒绝
 * - 存储：按用户分桶隔离、活跃上限 20 条、内容截断、落盘重载、按序号/id 取消
 * - 到点判定边界：triggerAt == now 到期、未来不到期、已取消/已投递不再到期、退避窗口内不投递
 * - Runner：到点投递、投递后不重复、投递失败指数退避补投、重启补投不重复
 * - 闸门行为：reminder_set / reminder_cancel 未确认不创建/不取消（与 memory_* 同口径过闸）
 * 以 tsx 直接运行：tsx scripts/unit-reminder.ts
 */

import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkAsync, finish } from './testkit';
import {
  MAX_ACTIVE_PER_USER,
  ReminderRunner,
  ReminderStore,
  buildReminderText,
  formatLocal,
  parseTriggerAt,
  remainingText,
} from '../src/agent/reminder';
import { buildTools } from '../src/agent/tools';
import type { ConfirmFn } from '../src/agent/guard';
import { DENIED_MESSAGE, NO_GATE_MESSAGE } from '../src/agent/guard';
import type { ToolHandlers } from '../src/types';

/** 固定本地时钟：2026-09-04 10:00（周五）。 */
const NOW = new Date(2026, 8, 4, 10, 0, 0);
const NOW_MS = NOW.getTime();

function tmpHome(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hta-unit-reminder-${tag}-`));
}

const tickOf = (r: ReminderRunner) => (r as unknown as { tick: () => Promise<void> }).tick.bind(r);

const approveAll: ConfirmFn = async () => 'once';
const denyAll: ConfirmFn = async () => false;

function makeToolEnv(home: string, confirm?: ConfirmFn): { store: ReminderStore; handlers: ToolHandlers } {
  const store = new ReminderStore(home);
  const { handlers } = buildTools({
    mcp: null,
    kanbanUrl: 'http://localhost:1',
    reminders: store,
    userId: 'u1',
    confirm,
  });
  return { store, handlers };
}

async function main(): Promise<void> {
  // ---------- 时间解析：相对分钟数 ----------
  await checkAsync('parseTriggerAt：in_minutes 相对分钟数；非法值（0/负数/NaN）拒绝', () => {
    assert.equal(parseTriggerAt({ inMinutes: 30 }, NOW), NOW_MS + 30 * 60000);
    assert.equal(parseTriggerAt({ inMinutes: 0.5 }, NOW), NOW_MS + 30000); // 半分钟合法
    for (const bad of [0, -5, NaN, Infinity]) {
      assert.throws(() => parseTriggerAt({ inMinutes: bad }, NOW), /in_minutes/, `应拒绝 ${bad}`);
    }
  });

  await checkAsync('parseTriggerAt：超 30 天期限拒绝（相对与绝对同口径）', () => {
    assert.throws(() => parseTriggerAt({ inMinutes: 31 * 24 * 60 }, NOW), /30 天/);
    assert.throws(() => parseTriggerAt({ at: '2026-10-10 09:00' }, NOW), /30 天/);
    // 恰好 30 天边界内放行
    assert.equal(parseTriggerAt({ inMinutes: 30 * 24 * 60 }, NOW), NOW_MS + 30 * 24 * 3600 * 1000);
  });

  await checkAsync('parseTriggerAt：双参数互斥与缺参拒绝', () => {
    assert.throws(() => parseTriggerAt({ at: '11:00', inMinutes: 30 }, NOW), /只能传一个/);
    assert.throws(() => parseTriggerAt({}, NOW), /之一/);
  });

  // ---------- 时间解析：绝对时刻 ----------
  await checkAsync('parseTriggerAt：「HH:mm」当天未到点取当天，已过顺延次日', () => {
    assert.equal(parseTriggerAt({ at: '11:30' }, NOW), new Date(2026, 8, 4, 11, 30).getTime());
    assert.equal(parseTriggerAt({ at: '09:00' }, NOW), new Date(2026, 8, 5, 9, 0).getTime()); // 10 点说「9 点」→ 明早
    assert.equal(parseTriggerAt({ at: '10:00' }, NOW), new Date(2026, 8, 5, 10, 0).getTime()); // 恰等于现在也顺延
  });

  await checkAsync('parseTriggerAt：「今天/明天/后天 HH:mm」与口语「9 点/9 点半/9 点 5 分」', () => {
    assert.equal(parseTriggerAt({ at: '今天 23:00' }, NOW), new Date(2026, 8, 4, 23, 0).getTime());
    assert.equal(parseTriggerAt({ at: '明天 09:00' }, NOW), new Date(2026, 8, 5, 9, 0).getTime());
    assert.equal(parseTriggerAt({ at: '明天早上 9:00' }, NOW), new Date(2026, 8, 5, 9, 0).getTime());
    assert.equal(parseTriggerAt({ at: '明天下午 3:00' }, NOW), new Date(2026, 8, 5, 15, 0).getTime());
    assert.equal(parseTriggerAt({ at: '明晚 9 点' }, NOW), new Date(2026, 8, 5, 21, 0).getTime());
    assert.equal(parseTriggerAt({ at: '今晚 8 点' }, NOW), new Date(2026, 8, 4, 20, 0).getTime());
    assert.equal(parseTriggerAt({ at: '后天 9:00' }, NOW), new Date(2026, 8, 6, 9, 0).getTime());
    assert.equal(parseTriggerAt({ at: '明天 9 点' }, NOW), new Date(2026, 8, 5, 9, 0).getTime());
    assert.equal(parseTriggerAt({ at: '明天 9 点半' }, NOW), new Date(2026, 8, 5, 9, 30).getTime());
    assert.equal(parseTriggerAt({ at: '明天 21 点 5 分' }, NOW), new Date(2026, 8, 5, 21, 5).getTime());
  });

  await checkAsync('parseTriggerAt：「YYYY-MM-DD HH:mm」与带时区标准串；非法日期拒绝', () => {
    assert.equal(parseTriggerAt({ at: '2026-09-20 09:00' }, NOW), new Date(2026, 8, 20, 9, 0).getTime());
    assert.equal(parseTriggerAt({ at: '2026-09-20T09:00' }, NOW), new Date(2026, 8, 20, 9, 0).getTime());
    const iso = parseTriggerAt({ at: '2026-09-05T09:00:00+08:00' }, NOW);
    assert.equal(iso, Date.parse('2026-09-05T09:00:00+08:00'));
    // 2 月 30 日等溢出日期必须拒绝（Date 会自动进位，回环校验拦截）
    assert.throws(() => parseTriggerAt({ at: '2026-02-30 10:00' }, NOW), /非法/);
    assert.throws(() => parseTriggerAt({ at: '2026-09-05 25:00' }, NOW), /非法/);
    assert.throws(() => parseTriggerAt({ at: '随便什么时候' }, NOW), /无法识别/);
  });

  await checkAsync('parseTriggerAt：过去时间拒绝（报错含解析出的时刻与当前时刻）', () => {
    assert.throws(() => parseTriggerAt({ at: '2026-09-04 09:00' }, NOW), /已过/);
    assert.throws(() => parseTriggerAt({ at: '2020-01-01 00:00' }, NOW), /已过/);
    // 「今天 HH:mm」已过时不得顺延（顺延只适用裸 HH:mm）
    assert.throws(() => parseTriggerAt({ at: '今天 09:00' }, NOW), /已过/);
  });

  // ---------- 存储：分桶 / 上限 / 取消 / 持久化 ----------
  await checkAsync('ReminderStore：按用户分桶隔离，list 按触发时刻升序', () => {
    const tmp = tmpHome('bucket');
    try {
      const store = new ReminderStore(tmp);
      store.add('u1', 'u1 的晚些', NOW_MS + 2 * 3600_000);
      store.add('u1', 'u1 的早些', NOW_MS + 3600_000);
      store.add('u2', 'u2 的提醒', NOW_MS + 1800_000);
      const l1 = store.list('u1');
      assert.deepEqual(l1.map((r) => r.text), ['u1 的早些', 'u1 的晚些']);
      assert.deepEqual(store.list('u2').map((r) => r.text), ['u2 的提醒']);
      assert.equal(store.list('u3').length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('ReminderStore：活跃上限 20 条（已取消不占额度）；空内容与超长内容处理', () => {
    const tmp = tmpHome('cap');
    try {
      const store = new ReminderStore(tmp);
      for (let i = 0; i < MAX_ACTIVE_PER_USER; i++) store.add('u1', `提醒 ${i}`, NOW_MS + (i + 1) * 60000);
      assert.throws(() => store.add('u1', '第 21 条', NOW_MS + 3600_000), new RegExp(`上限（${MAX_ACTIVE_PER_USER} 条）`));
      store.cancel('u1', '1'); // 取消一条后额度释放
      store.add('u1', '补上', NOW_MS + 3600_000);
      assert.equal(store.list('u1').length, MAX_ACTIVE_PER_USER);
      assert.throws(() => store.add('u1', '   ', NOW_MS + 60000), /不能为空/);
      const long = store.add('u2', 'x'.repeat(600), NOW_MS + 60000);
      assert.ok(long.text.length < 600 && long.text.endsWith('（已截断）'), '超长内容应截断');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('ReminderStore：按序号与 id 取消；重复取消/未知引用返回 null；落盘可重载', () => {
    const tmp = tmpHome('cancel');
    try {
      const store = new ReminderStore(tmp);
      const a = store.add('u1', '第一条', NOW_MS + 60000);
      store.add('u1', '第二条', NOW_MS + 120000);
      const cancelled = store.cancel('u1', '1'); // 序号取消
      assert.equal(cancelled?.id, a.id);
      // 取消后序号重排：此时序号 1 指向「第二条」
      const second = store.cancel('u1', '1');
      assert.equal(second?.text, '第二条');
      assert.equal(store.list('u1').length, 0);
      assert.equal(store.cancel('u1', 'r_nonexist'), null);
      assert.equal(store.cancel('u1', '9'), null);
      // id 取消 + 重载：另一个实例（模拟另一进程/重启）能读到
      store.add('u1', '第三条', NOW_MS + 60000);
      const reloaded = new ReminderStore(tmp);
      const third = reloaded.list('u1')[0]!;
      assert.equal(third.text, '第三条');
      assert.equal(reloaded.cancel('u1', third.id)?.text, '第三条');
      assert.equal(new ReminderStore(tmp).list('u1').length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('ReminderStore：损坏文件按空文件回退并备份（不崩）', () => {
    const tmp = tmpHome('corrupt');
    try {
      fs.writeFileSync(path.join(tmp, 'reminders.json'), '{not json');
      const store = new ReminderStore(tmp);
      assert.equal(store.list('u1').length, 0);
      store.add('u1', '重建', NOW_MS + 60000);
      assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('reminders.json.corrupt-')), '应有损坏备份');
      assert.equal(new ReminderStore(tmp).list('u1').length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 到点判定边界 ----------
  await checkAsync('due：triggerAt == now 到期、未来不到期、终结状态与退避窗口不再到期', () => {
    const tmp = tmpHome('due');
    try {
      const store = new ReminderStore(tmp);
      const hit = store.add('u1', '正好到点', NOW_MS);
      store.add('u1', '未来', NOW_MS + 60000);
      const cancelled = store.add('u1', '已取消', NOW_MS);
      store.cancel('u1', cancelled.id);
      const delivered = store.add('u2', '已投递', NOW_MS);
      store.markDelivered('u2', delivered.id, NOW_MS);
      const backing = store.add('u2', '退避中', NOW_MS);
      store.markFailed('u2', backing.id, NOW_MS); // 退避 1 分钟
      const due = store.due(NOW_MS);
      assert.deepEqual(due.map((d) => d.reminder.id), [hit.id]);
      assert.equal(due[0]!.userId, 'u1');
      // 退避窗口过后再次到期；「未来」（+60s）此刻也已到点，排在两条 triggerAt 更早的之后
      const later = store.due(NOW_MS + 61000);
      assert.deepEqual(later.map((d) => d.reminder.text), ['正好到点', '退避中', '未来']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- Runner：投递 / 不重复 / 退避补投 / 重启补投 ----------
  await checkAsync('ReminderRunner：到点投递且不再重复；文案含提醒内容与设定时间', async () => {
    const tmp = tmpHome('run');
    try {
      const store = new ReminderStore(tmp);
      store.add('u1', '站会', NOW_MS - 1000); // 已到点
      store.add('u1', '未来的', NOW_MS + 3600_000);
      const sent: string[] = [];
      const runner = new ReminderRunner({
        store,
        deliver: async (_u, text) => {
          sent.push(text);
        },
        now: () => new Date(NOW_MS),
      });
      await tickOf(runner)();
      assert.equal(sent.length, 1);
      assert.ok(sent[0]!.includes('⏰ 提醒时间到') && sent[0]!.includes('站会'), `文案：${sent[0]}`);
      assert.ok(sent[0]!.includes('设定于') && sent[0]!.includes('定于'), `应含设定时间：${sent[0]}`);
      await tickOf(runner)(); // 已投递不重复
      await tickOf(runner)();
      assert.equal(sent.length, 1);
      assert.equal(store.list('u1').length, 1, '已投递后只剩未来的那条待触发');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('ReminderRunner：投递失败指数退避（1→2 分钟），窗口内不重试、窗口后补投', async () => {
    const tmp = tmpHome('backoff');
    try {
      const store = new ReminderStore(tmp);
      store.add('u1', '会失败的', NOW_MS);
      let nowMs = NOW_MS;
      let down = true;
      let calls = 0;
      const sent: string[] = [];
      const runner = new ReminderRunner({
        store,
        deliver: async (_u, text) => {
          calls++;
          if (down) throw new Error('channel down');
          sent.push(text);
        },
        now: () => new Date(nowMs),
      });
      const tick = tickOf(runner);
      await tick(); // 第 1 次失败 → 退避 1 分钟
      assert.equal(calls, 1);
      await tick(); // 窗口内不重试
      assert.equal(calls, 1);
      nowMs += 61000;
      await tick(); // 第 2 次失败 → 退避 2 分钟
      assert.equal(calls, 2);
      nowMs += 61000;
      await tick(); // 2 分钟窗口内不重试
      assert.equal(calls, 2);
      nowMs += 61000;
      down = false;
      await tick(); // 窗口后补投成功
      assert.equal(calls, 3);
      assert.equal(sent.length, 1);
      await tick(); // 投递成功后不再重复
      assert.equal(calls, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('ReminderRunner：重启补投——到点未投的补投、已投的不重复（新实例从磁盘恢复）', async () => {
    const tmp = tmpHome('restart');
    try {
      const sent: string[] = [];
      const mk = () => {
        const store = new ReminderStore(tmp);
        return new ReminderRunner({
          store,
          deliver: async (_u, text) => {
            sent.push(text);
          },
          now: () => new Date(NOW_MS + 3600_000), // 拉起时已过两个提醒的到点时刻
        });
      };
      const store = new ReminderStore(tmp);
      store.add('u1', '到点未投的', NOW_MS);
      const done = store.add('u1', '到点已投的', NOW_MS);
      store.markDelivered('u1', done.id, NOW_MS); // 崩溃前已投递落盘
      await tickOf(mk())(); // 模拟重启：新 store + runner
      assert.deepEqual(sent.map((s) => s.includes('到点未投的')), [true], `只补投未投的：${JSON.stringify(sent)}`);
      await tickOf(mk())(); // 再重启一次：已投的不重复
      assert.equal(sent.length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 工具层：闸门行为（与 memory_* 同口径过闸） ----------
  await checkAsync('reminder_set：确认闸门拒绝时不创建（返回拒绝口径），批准后创建并回执确认时刻', async () => {
    const tmp = tmpHome('gate');
    try {
      // 拒绝：不创建
      let env = makeToolEnv(tmp, denyAll);
      const denied = await env.handlers.get('reminder_set')!({ text: '站会', in_minutes: 30 });
      assert.equal(denied, DENIED_MESSAGE);
      assert.equal(env.store.list('u1').length, 0);
      // 无闸门通道：fail-closed
      env = makeToolEnv(tmp, undefined);
      const noGate = await env.handlers.get('reminder_set')!({ text: '站会', in_minutes: 30 });
      assert.equal(noGate, NO_GATE_MESSAGE);
      assert.equal(env.store.list('u1').length, 0);
      // 批准：创建成功，返回触发时刻与剩余时间供模型复述
      env = makeToolEnv(tmp, approveAll);
      const okRaw = await env.handlers.get('reminder_set')!({ text: '站会', in_minutes: 30 });
      const ok = JSON.parse(okRaw) as { ok: boolean; id: string; triggerAt: string; remaining: string };
      assert.equal(ok.ok, true);
      assert.ok(ok.triggerAt && ok.remaining.includes('分钟后'), `回执：${okRaw}`);
      assert.equal(env.store.list('u1').length, 1);
      // 参数错误不过闸（缺时间参数）
      const badRaw = await env.handlers.get('reminder_set')!({ text: '站会' });
      assert.ok(badRaw.includes('参数错误'), `实际：${badRaw}`);
      assert.equal(env.store.list('u1').length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await checkAsync('reminder_list / reminder_cancel：只读不过闸；取消过闸且拒绝时不取消', async () => {
    const tmp = tmpHome('gate2');
    try {
      const env = makeToolEnv(tmp, approveAll);
      env.store.add('u1', '第一条', Date.now() + 3600_000);
      env.store.add('u1', '第二条', Date.now() + 7200_000);
      const listRaw = await env.handlers.get('reminder_list')!({});
      const list = JSON.parse(listRaw) as { count: number; reminders: Array<{ 序号: number; text: string; remaining: string }> };
      assert.equal(list.count, 2);
      assert.equal(list.reminders[0]!.序号, 1);
      assert.ok(list.reminders[0]!.remaining.includes('小时后'), `剩余时间：${listRaw}`);
      // 拒绝取消：提醒仍在
      const denyEnv = makeToolEnv(tmp, denyAll);
      const denied = await denyEnv.handlers.get('reminder_cancel')!({ ref: '1' });
      assert.equal(denied, DENIED_MESSAGE);
      assert.equal(env.store.list('u1').length, 2);
      // 批准取消：按序号生效
      const okRaw = await env.handlers.get('reminder_cancel')!({ ref: '1' });
      assert.equal((JSON.parse(okRaw) as { ok: boolean }).ok, true);
      assert.deepEqual(env.store.list('u1').map((r) => r.text), ['第二条']);
      // 未知引用：不过闸直接报未找到
      const missing = await env.handlers.get('reminder_cancel')!({ ref: '9' });
      assert.ok(missing.includes('未找到'), `实际：${missing}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------- 展示辅助 ----------
  await checkAsync('formatLocal / remainingText / buildReminderText 口径', () => {
    assert.equal(formatLocal(NOW_MS), '2026-09-04 10:00');
    assert.equal(remainingText(NOW_MS + 30 * 60000, NOW_MS), '30 分钟后');
    assert.equal(remainingText(NOW_MS + 90 * 60000, NOW_MS), '1 小时 30 分钟后');
    assert.equal(remainingText(NOW_MS + 26 * 3600_000, NOW_MS), '1 天 2 小时后');
    assert.equal(remainingText(NOW_MS - 1000, NOW_MS), '已到点');
    const text = buildReminderText({
      id: 'r1',
      text: '盯一下构建',
      triggerAt: NOW_MS,
      createdAt: NOW_MS - 1800_000,
      status: 'pending',
    });
    assert.ok(text.includes('盯一下构建') && text.includes('2026-09-04 09:30') && text.includes('2026-09-04 10:00'));
  });

  // ---------- 存储：写盘失败留痕 ----------
  await checkAsync('ReminderStore：mutate 写盘失败时 console.error 留痕且不谎报成功', () => {
    const tmp = tmpHome('writefail');
    try {
      // home 占位为常规文件：reminders.json 的所在目录创建必失败，走 mutate 的 catch 路径
      const blocker = path.join(tmp, 'not-a-dir');
      fs.writeFileSync(blocker, 'x');
      const origErr = console.error;
      const errLogs: string[] = [];
      console.error = (...args: unknown[]) => errLogs.push(args.map(String).join(' '));
      try {
        const store = new ReminderStore(blocker);
        assert.throws(() => store.add('u1', '写不进去', NOW_MS), /提醒保存失败/);
        assert.ok(errLogs.some((m) => m.includes('[reminder] 提醒存储写入失败')), `应留痕，实际日志：${errLogs.join(' | ')}`);
      } finally {
        console.error = origErr;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  finish();
}

void main();
