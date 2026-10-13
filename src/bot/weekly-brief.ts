import type { WorkSummaryData } from '../kanban/summary';
import { isKnownStatus } from '../kanban/status';
import {
  BriefScheduler,
  listSection,
  localDateStr,
  type BriefDue,
  type BriefSchedulerOptions,
} from './brief-scheduler';
// env 解析（parseWeeklyBriefTime / parseWeeklyBriefDay / WeeklyBriefTime / DEFAULT_WEEKLY_BRIEF_DAY）
// 单源在 config/flags-parsers.ts（config 层 runtime-flags 直接依赖），此处 re-export 保持既有导入路径不变
import {
  DEFAULT_WEEKLY_BRIEF_DAY,
  parseWeeklyBriefDay,
  parseWeeklyBriefTime,
  type WeeklyBriefTime,
} from '../config/flags-parsers';
export { DEFAULT_WEEKLY_BRIEF_DAY, parseWeeklyBriefDay, parseWeeklyBriefTime, type WeeklyBriefTime };

/**
 * 定时周报：HTA_WEEKLY_BRIEF=HH:MM（本地时间）开启，默认关闭；
 * HTA_WEEKLY_BRIEF_DAY=1-7（1=周一…7=周日）指定周几推送，默认 5（周五），非法值告警并按默认处理。
 * 设定星期当天过了设定时刻即给 owner 推一条本周迭代进展（复用 work_summary 采集）；
 * 错过推送日（进程当天没开）时当周后续日期补推一次并在正文注明补发，跨周不补（进入新一周后等当周推送日）。
 * 调度骨架（判重落盘 / 失败退避 / 补投 / 启停）在 brief-scheduler.ts；
 * 本文件只保留周报的到点判定（当周口径 + 补推）与文案。仅 bot 形态装配（CLI 不引本模块）。
 */

/** 本地星期几，1=周一…7=周日（与 HTA_WEEKLY_BRIEF_DAY 同口径；Date.getDay 是 0=周日）。 */
function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

/** 本周周一 00:00（本地时间）：周报「本周完成」的统计起点。 */
function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - (isoWeekday(d) - 1));
  return d;
}

/** 星期展示文案（下标 0=周一…6=周日，与 isoWeekday 的 1-7 错一位）。 */
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 周报文本（纯函数便于单测）：头部为迭代全量计数（与晨报同口径），正文聚焦「这周干得怎么样」——
 * 本周完成 / 待审阅积压 / 失败三个分组。
 * 「本周完成」口径：状态为已完成且最后更新时间落在本周（周一 00:00 起，本地时区）。看板任务
 * 没有「完成时间」字段，updated_at 是最接近的口径——已完成的任务很少再被编辑，最后更新时间
 * 通常就是转入已完成的那一刻；updated_at 无法解析的任务保守不计入（宁缺毋假）。
 * 分组计数用 totals.doneThisWeek（采集侧截断前全量口径，与头部计数行一致）；标题列表仍是
 * data.tasks 的截断样本。旧采集缺该字段时回退样本计数（只少报不谎报）。
 * opts.makeUpDay：补推日（原定推送星期，1=周一…7=周日）——错过推送日后当周补推时必须
 * 注明补发，否则用户会困惑「今天不是推送日怎么收到周报」。
 */
export function buildWeeklyBriefText(data: WorkSummaryData, now: Date, opts?: { makeUpDay?: number }): string {
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  // 头部日期范围终点不越过推送当天：周一推送就展示「至 周日」是在预报未来
  const rangeEnd = weekEnd.getTime() > now.getTime() ? now : weekEnd;
  const doneThisWeek = data.tasks.filter((t) => {
    if (t.status !== 'done') return false;
    const ts = Date.parse(t.updatedAt);
    return Number.isFinite(ts) && ts >= weekStart.getTime();
  });
  const doneThisWeekTotal = data.totals.doneThisWeek ?? doneThisWeek.length;
  const inreview = data.tasks.filter((t) => t.status === 'inreview');
  // 失败按 last_attempt_failed 标记独立分组（与状态正交：失败任务可能停在 inprogress 等任意状态）
  const failed = data.tasks.filter((t) => t.failed);
  // 头部计数全部用 totals（截断前全量，迭代全量口径）；列表仍取截断后的 data.tasks 抽样。
  // 失败与状态计数正交，非零时注明口径（零值不挂括注，减少噪音）；
  // 「已完成」是迭代/全部任务累计口径，与下方「本周完成」分组不同口径，须标注避免误读
  const failedNote = data.totals.failed ? '（含于上方状态）' : '';
  const doneNote = data.iteration ? '（迭代累计）' : '（累计）';
  const lines = [
    `📅 看板周报 · ${data.sinceLabel}（${localDateStr(weekStart)} 至 ${localDateStr(rangeEnd)}）`,
    `进行中 ${data.totals.inprogress} · 待办 ${data.totals.todo} · 待审阅 ${data.totals.inreview} · 已完成 ${data.totals.done}${doneNote} · 失败 ${data.totals.failed}${failedNote}`,
  ];
  if (opts?.makeUpDay) {
    lines.push(`📮 补发：原定每${WEEKDAY_LABELS[opts.makeUpDay - 1] ?? ''}的周报延迟到今天推送。`);
  }
  if (!data.tasks.length) {
    lines.push('', data.iteration ? '这个迭代还没有任务。' : '看板上还没有任务。');
  } else {
    if (!doneThisWeekTotal) lines.push('', '本周暂无新完成的任务。');
    let anySection = false;
    for (const section of [
      listSection('本周完成', doneThisWeek, { total: doneThisWeekTotal }),
      listSection('待审阅积压', inreview, { total: data.totals.inreview }),
      listSection('失败', failed, { showStatus: true, total: data.totals.failed }),
    ]) {
      if (section.length) {
        anySection = true;
        lines.push('', ...section);
      }
    }
    // 范围内任务全部是已取消/未知状态时各分组为空：兜底体现取消数（与报告侧「已取消」
    // 统计卡同口径），不输出头部全零、正文空白的空周报
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
  // 底部引导语与周报范围匹配：配置了迭代引导「总结这个迭代」；未配置时范围为全部任务，
  // 引导语须说清「全部任务」——只说「看板进展」时 agent 默认按 today 范围总结，与周报口径不符
  lines.push(
    '',
    data.iteration ? '回复「总结一下这个迭代做了什么」看完整报告' : '回复「总结一下全部任务的看板进展」看完整报告',
  );
  return lines.join('\n');
}

export interface WeeklyBriefOptions extends Omit<BriefSchedulerOptions, 'label'> {
  time: WeeklyBriefTime;
  /** 周几推送：1=周一…7=周日。 */
  day: number;
}

export class WeeklyBrief extends BriefScheduler {
  private readonly time: WeeklyBriefTime;
  private readonly day: number;

  constructor(opts: WeeklyBriefOptions) {
    super({ ...opts, label: '周报' });
    this.time = opts.time;
    this.day = opts.day;
  }

  /**
   * 到点判定：设定星期当天需到点（进程在到点后拉起、或恰好错过那一分钟，当天仍可补推）；
   * 错过设定日（进程当天没开）时当周后续日期补推一次——补推日不再受时刻门限制，
   * 启动即检查即补（周刊早报比守着原时刻更有价值）；跨周不补，等当周推送日。
   * 设定日为周日（7）时没有更晚的当周日期，天然无补推窗口。
   */
  protected due(now: Date): BriefDue | null {
    const wd = isoWeekday(now);
    const { hour, minute } = this.time;
    const isScheduledDay = wd === this.day;
    if (isScheduledDay) {
      if (now.getHours() < hour || (now.getHours() === hour && now.getMinutes() < minute)) return null;
    } else if (wd < this.day) return null;
    // 判重口径是「当周」而非「当天」：补推日也要认出设定日已送达的 owner，只补投未送达的
    const weekStartStr = localDateStr(startOfWeek(now));
    return {
      inPeriod: (stateDate) => stateDate >= weekStartStr,
      buildText: (data) => buildWeeklyBriefText(data, now, isScheduledDay ? undefined : { makeUpDay: this.day }),
      deliveredSuffix: isScheduledDay ? '' : '（补发）',
    };
  }
}
