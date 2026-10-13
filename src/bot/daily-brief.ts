import type { WorkSummaryData } from '../kanban/summary';
import { isKnownStatus } from '../kanban/status';
import {
  BriefScheduler,
  listSection,
  localDateStr,
  type BriefDue,
  type BriefSchedulerOptions,
} from './brief-scheduler';
// env 解析（parseDailyBriefTime / DailyBriefTime）单源在 config/flags-parsers.ts
// （config 层 runtime-flags 直接依赖），此处 re-export 保持既有导入路径不变
import { parseDailyBriefTime, type DailyBriefTime } from '../config/flags-parsers';
export { parseDailyBriefTime, type DailyBriefTime };

/**
 * 定时晨报：HTA_DAILY_BRIEF=HH:MM（本地时间）开启，默认关闭。
 * 到点且当天未推送过则给 owner 推一条当前迭代的看板任务概览（复用 work_summary 采集）。
 * 调度骨架（判重落盘 / 失败退避 / 补投 / 启停）在 brief-scheduler.ts；
 * 本文件只保留晨报的到点判定（当天口径）与文案。仅 bot 形态装配（CLI 不引本模块）。
 */

/** 晨报文本（纯函数便于单测）：数量概览 + 各状态标题清单；空迭代给一句兜底。 */
export function buildDailyBriefText(data: WorkSummaryData, now: Date): string {
  const inprogress = data.tasks.filter((t) => t.status === 'inprogress');
  const todo = data.tasks.filter((t) => t.status === 'todo');
  const inreview = data.tasks.filter((t) => t.status === 'inreview');
  const done = data.tasks.filter((t) => t.status === 'done');
  // 失败按 last_attempt_failed 标记独立分组（与状态正交：失败任务可能停在 inprogress 等任意状态）
  const failed = data.tasks.filter((t) => t.failed);
  // 头部计数全部用 totals（截断前全量）；列表仍取截断后的 data.tasks 抽样。失败与状态计数正交，
  // 非零时注明口径（零值不挂括注，减少噪音）
  const failedNote = data.totals.failed ? '（含于上方状态）' : '';
  const lines = [
    `☀️ 看板晨报 · ${data.sinceLabel}（${localDateStr(now)}）`,
    `进行中 ${data.totals.inprogress} · 待办 ${data.totals.todo} · 待审阅 ${data.totals.inreview} · 已完成 ${data.totals.done} · 失败 ${data.totals.failed}${failedNote}`,
  ];
  if (!data.tasks.length) {
    lines.push('', data.iteration ? '这个迭代还没有任务。' : '看板上还没有任务。');
  } else {
    let anySection = false;
    for (const section of [
      listSection('进行中', inprogress, { total: data.totals.inprogress }),
      listSection('待办', todo, { total: data.totals.todo }),
      listSection('待审阅', inreview, { total: data.totals.inreview }),
      listSection('已完成', done, { total: data.totals.done }),
      listSection('失败', failed, { showStatus: true, total: data.totals.failed }),
    ]) {
      if (section.length) {
        anySection = true;
        lines.push('', ...section);
      }
    }
    // 范围内任务全部是已取消/未知状态时各分组为空：兜底体现取消数（与报告侧「已取消」
    // 统计卡同口径），不输出头部全零、正文空白的空晨报
    if (!anySection) {
      const parts: string[] = [];
      if (data.totals.cancelled) parts.push(`已取消 ${data.totals.cancelled} 个`);
      // 「其他状态」与同行「已取消」同为全量口径：截断前范围内总行数 − 五状态全量和；
      // 旧采集缺 scopedTotal 时回退样本计数（只少报不谎报）
      const knownTotal =
        data.totals.done + data.totals.inreview + data.totals.inprogress + data.totals.todo + data.totals.cancelled;
      const unknown =
        data.scopedTotal !== undefined
          ? Math.max(0, data.scopedTotal - knownTotal)
          : data.tasks.filter((t) => !isKnownStatus(t.status)).length;
      if (unknown) parts.push(`其他状态 ${unknown} 个`);
      if (parts.length) lines.push('', parts.join(' · '));
    }
  }
  // 底部引导语与晨报范围匹配：配置了迭代引导「总结这个迭代」；未配置时范围为全部任务，
  // 引导语须说清「全部任务」——只说「看板进展」时 agent 默认按 today 范围总结，与晨报口径不符
  lines.push(
    '',
    data.iteration ? '回复「总结一下这个迭代做了什么」看完整报告' : '回复「总结一下全部任务的看板进展」看完整报告',
  );
  return lines.join('\n');
}

export interface DailyBriefOptions extends Omit<BriefSchedulerOptions, 'label'> {
  time: DailyBriefTime;
}

export class DailyBrief extends BriefScheduler {
  private readonly time: DailyBriefTime;

  constructor(opts: DailyBriefOptions) {
    super({ ...opts, label: '晨报' });
    this.time = opts.time;
  }

  /** 到点判定用「当前时间 ≥ 当天设定时刻」：进程在到点后拉起（或恰好错过那一分钟）当天仍可补推。 */
  protected due(now: Date): BriefDue | null {
    const { hour, minute } = this.time;
    if (now.getHours() < hour || (now.getHours() === hour && now.getMinutes() < minute)) return null;
    const today = localDateStr(now);
    return {
      // 判重口径为「当天」：当天已送达的 owner 不重复推，只补投未送达的
      inPeriod: (stateDate) => stateDate === today,
      buildText: (data) => buildDailyBriefText(data, now),
    };
  }
}
