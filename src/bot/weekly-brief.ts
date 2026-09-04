import fs from 'fs';
import { writeFileAtomicPrivateSync } from '../infra/private-file';
import { errMessage } from '../infra/err';
import { fetchKanbanHealth } from '../kanban/http';
import { collectWorkSummary, isKnownStatus, statusLabel, type WorkSummaryData, type WorkSummaryTask } from '../kanban/summary';

/**
 * 定时周报：HTA_WEEKLY_BRIEF=HH:MM（本地时间）开启，默认关闭；
 * HTA_WEEKLY_BRIEF_DAY=1-7（1=周一…7=周日）指定周几推送，默认 5（周五），非法值告警并按默认处理。
 * 机制与晨报（daily-brief.ts）完全对齐：bot 运行期间每分钟检查一次是否到点；到点（当周当周
 * 设定星期且过了设定时刻）且当天未推送过则给 owner 推一条本周迭代进展（复用 work_summary 采集）。
 * 「上次推送日期 + 已送达 owner」落盘（原子写），重启当周当天不重复推；部分 owner 推送失败时
 * 下一 tick 只补投未送达的。看板不可达 / 采集失败 / 推送失败：本次跳过并记日志，按 1→2→4…分钟
 * 指数退避（封顶 30 分钟）再试，当天内有效。owner 未认领（白名单为空）时不推、不标记。
 * 仅 bot 形态装配（CLI 不引本模块）。
 */

export interface WeeklyBriefTime {
  hour: number;
  minute: number;
}

/** 默认推送星期：周五。 */
export const DEFAULT_WEEKLY_BRIEF_DAY = 5;

/** 解析 HTA_WEEKLY_BRIEF（HH:MM，本地时间）：未设置/空串返回 null；非法值抛错（由调用方 console.warn）。 */
export function parseWeeklyBriefTime(raw: string | undefined): WeeklyBriefTime | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(v);
  const hour = m ? Number(m[1]) : NaN;
  if (!m || hour > 23) {
    throw new Error(`HTA_WEEKLY_BRIEF 值非法：${JSON.stringify(raw)}（应为 HH:MM，如 18:00）`);
  }
  return { hour, minute: Number(m![2]) };
}

/** 解析 HTA_WEEKLY_BRIEF_DAY（1=周一…7=周日）：未设置/空串返回默认（周五）；非法值抛错（由调用方 console.warn 并按默认处理）。 */
export function parseWeeklyBriefDay(raw: string | undefined): number {
  const v = (raw ?? '').trim();
  if (!v) return DEFAULT_WEEKLY_BRIEF_DAY;
  if (!/^[1-7]$/.test(v)) {
    throw new Error(`HTA_WEEKLY_BRIEF_DAY 值非法：${JSON.stringify(raw)}（应为 1-7，1=周一…7=周日）`);
  }
  return Number(v);
}

/** 本地日期 YYYY-MM-DD（与推送判重同口径，必须用本地时区而非 toISOString）。 */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

/** 每个分组最多列出的任务标题数（周报是概览，全量走「总结一下这个迭代做了什么」报告）。 */
const MAX_LIST = 10;

/**
 * 分组小节：标题计数用 total（totals 的截断前全量，与头部计数行同口径），
 * 列表仍是 data.tasks 的截断样本；截断时用「…还有 N 个」按全量口径补剩余数。
 */
function listSection(label: string, tasks: WorkSummaryTask[], opts?: { showStatus?: boolean; total?: number }): string[] {
  const total = opts?.total ?? tasks.length;
  if (!total) return [];
  const lines = [`【${label}】${total} 个`];
  // 标题来自看板数据：文本消息无 markdown 解析，原样输出即可，不做转义
  // 失败分组与状态分组正交（同一任务两边都出现）：标注原状态消除「重复计数」困惑；
  // 未知状态 statusLabel 会回退英文原键，这里兜底「其他」
  for (const t of tasks.slice(0, MAX_LIST)) {
    lines.push(`· 《${t.title}》${opts?.showStatus ? `（${isKnownStatus(t.status) ? statusLabel(t.status) : '其他'}）` : ''}`);
  }
  const listed = Math.min(tasks.length, MAX_LIST);
  if (total > listed) lines.push(`· …还有 ${total - listed} 个`);
  return lines;
}

/**
 * 周报文本（纯函数便于单测）：头部为迭代全量计数（与晨报同口径），正文聚焦「这周干得怎么样」——
 * 本周完成 / 待审阅积压 / 失败三个分组。
 * 「本周完成」口径：状态为已完成且最后更新时间落在本周（周一 00:00 起，本地时区）。看板任务
 * 没有「完成时间」字段，updated_at 是最接近的口径——已完成的任务很少再被编辑，最后更新时间
 * 通常就是转入已完成的那一刻；updated_at 无法解析的任务保守不计入（宁缺毋假）。
 */
export function buildWeeklyBriefText(data: WorkSummaryData, now: Date): string {
  const weekStart = startOfWeek(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const doneThisWeek = data.tasks.filter((t) => {
    if (t.status !== 'done') return false;
    const ts = Date.parse(t.updatedAt);
    return Number.isFinite(ts) && ts >= weekStart.getTime();
  });
  const inreview = data.tasks.filter((t) => t.status === 'inreview');
  // 失败按 last_attempt_failed 标记独立分组（与状态正交：失败任务可能停在 inprogress 等任意状态）
  const failed = data.tasks.filter((t) => t.failed);
  // 头部计数全部用 totals（截断前全量，迭代全量口径）；列表仍取截断后的 data.tasks 抽样。
  // 失败与状态计数正交，非零时注明口径（零值不挂括注，减少噪音）
  const failedNote = data.totals.failed ? '（含于上方状态）' : '';
  const lines = [
    `📅 看板周报 · ${data.sinceLabel}（${localDateStr(weekStart)} 至 ${localDateStr(weekEnd)}）`,
    `进行中 ${data.totals.inprogress} · 待办 ${data.totals.todo} · 待审阅 ${data.totals.inreview} · 已完成 ${data.totals.done} · 失败 ${data.totals.failed}${failedNote}`,
  ];
  if (!data.tasks.length) {
    lines.push('', data.iteration ? '这个迭代还没有任务。' : '看板上还没有任务。');
  } else {
    if (!doneThisWeek.length) lines.push('', '本周暂无新完成的任务。');
    let anySection = false;
    for (const section of [
      listSection('本周完成', doneThisWeek),
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
      const unknown = data.tasks.filter((t) => !isKnownStatus(t.status)).length;
      if (unknown) parts.push(`其它状态 ${unknown} 个`);
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

interface WeeklyBriefState {
  /** 最近一次推送的本地日期（YYYY-MM-DD）：推送只发生在设定星期，与今天相同则只补投未送达 owner。 */
  date: string;
  /** 当天已送达的 owner open_id（部分失败时下一 tick 只补投未送达的，避免重复刷屏）。 */
  delivered: string[];
}

export interface WeeklyBriefOptions {
  time: WeeklyBriefTime;
  /** 周几推送：1=周一…7=周日。 */
  day: number;
  statePath: string;
  kanbanUrl: string;
  projectId?: string;
  /** 当前迭代名（HELIOS_KANBAN_ITERATION）；缺省时范围为全部任务。 */
  iteration?: string;
  /** owner 列表取法（含运行时认领的 owner）；为空时不推。 */
  owners: () => string[];
  notifyOwner: (owner: string, text: string) => Promise<void>;
  /** 到点检查间隔（默认 60s，最小 5s）；测试可注入更小值。 */
  checkIntervalMs?: number;
  /** 注入时钟（测试用）；默认真实时间。 */
  now?: () => Date;
  /** 注入采集与健康检查（测试用）；默认走真实看板。 */
  collect?: () => Promise<WorkSummaryData>;
  healthCheck?: () => Promise<boolean>;
  /** stop() 等待在途 tick 的兜底超时（默认 5s）。 */
  stopTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class WeeklyBrief {
  private readonly opts: WeeklyBriefOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private state: WeeklyBriefState | null;
  /** 连续失败次数与下次允许重试时间（ms）：失败指数退避，防异常 owner 导致每分钟全量采集。 */
  private failStreak = 0;
  private nextRetryAt = 0;

  constructor(opts: WeeklyBriefOptions) {
    this.opts = opts;
    this.state = this.load();
  }

  start(): void {
    const interval = Math.max(5000, this.opts.checkIntervalMs ?? 60000);
    void this.tick(); // 启动即检查一次：进程在到点之后才拉起时当周仍可补推
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  /** 停止检查并等待在途 tick 结束（带兜底超时）：否则 shutdown 后在途推送会打到已关闭的 channel。 */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + (this.opts.stopTimeoutMs ?? 5000);
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.running) this.opts.log?.('stop 等待在途推送超时，继续关闭流程');
  }

  private load(): WeeklyBriefState | null {
    try {
      if (!fs.existsSync(this.opts.statePath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8')) as Partial<WeeklyBriefState>;
      if (!raw || typeof raw !== 'object' || typeof raw.date !== 'string' || !raw.date) return null;
      const delivered = Array.isArray(raw.delivered)
        ? raw.delivered.filter((o): o is string => typeof o === 'string')
        : [];
      return { date: raw.date, delivered };
    } catch {
      return null;
    }
  }

  private persist(): void {
    try {
      writeFileAtomicPrivateSync(this.opts.statePath, JSON.stringify(this.state, null, 2) + '\n');
    } catch {
      /* best-effort：写盘失败时下次 tick 会按未送达重推（重复优于丢失） */
    }
  }

  /** 记录一次失败并设置指数退避（1→2→4…分钟，封顶 30 分钟）。 */
  private markFailure(nowMs: number): void {
    this.failStreak++;
    const backoffMin = Math.min(2 ** (this.failStreak - 1), 30);
    this.nextRetryAt = nowMs + backoffMin * 60 * 1000;
  }

  /** 单 tick：是当周设定星期、到点且当天未全员送达才推送。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.opts.now?.() ?? new Date();
      // 只在设定星期推送：错过当天（进程整天没开）本周不再补推，等下一周
      if (isoWeekday(now) !== this.opts.day) return;
      const { hour, minute } = this.opts.time;
      // 到点判定用「当前时间 ≥ 当天设定时刻」：进程在到点后拉起（或恰好错过那一分钟）当天仍可补推
      if (now.getHours() < hour || (now.getHours() === hour && now.getMinutes() < minute)) return;
      const owners = this.opts.owners();
      if (!owners.length) return; // owner 未认领不推、不标记（认领后当天到点仍可补推）
      const today = localDateStr(now);
      const delivered = this.state?.date === today ? this.state.delivered : [];
      const targets = owners.filter((o) => !delivered.includes(o));
      if (!targets.length) return; // 当天已全员送达
      if (now.getTime() < this.nextRetryAt) return; // 失败退避中，等下一个窗口

      const health = this.opts.healthCheck
        ? await this.opts.healthCheck()
        : (await fetchKanbanHealth(this.opts.kanbanUrl)) === 'ok';
      if (!health) {
        // 看板不可达：跳过本次推送（不推「不可达」消息打扰用户），不标记，退避后当天内再试
        this.markFailure(now.getTime());
        this.opts.log?.(`看板不可达，本次周报跳过（退避后再试）`);
        return;
      }
      let data: WorkSummaryData;
      try {
        data = this.opts.collect
          ? await this.opts.collect()
          : await collectWorkSummary({
              kanbanUrl: this.opts.kanbanUrl,
              projectId: this.opts.projectId,
              iteration: this.opts.iteration,
              scope: 'iteration',
            });
      } catch (err) {
        this.markFailure(now.getTime());
        this.opts.log?.(`周报采集失败，本次跳过: ${errMessage(err)}`);
        return;
      }
      const text = buildWeeklyBriefText(data, now);
      const sent = [...delivered];
      let failed = 0;
      for (const owner of targets) {
        try {
          await this.opts.notifyOwner(owner, text);
          sent.push(owner);
        } catch (err) {
          failed++;
          this.opts.log?.(`周报推送失败（${owner}）: ${errMessage(err)}`);
        }
      }
      this.state = { date: today, delivered: sent };
      this.persist();
      if (failed) {
        this.markFailure(now.getTime());
        this.opts.log?.(`${failed} 个 owner 周报未送达，退避后补投`);
      } else {
        this.failStreak = 0;
        this.nextRetryAt = 0;
        this.opts.log?.(`周报已送达 ${targets.length} 个 owner`);
      }
    } catch (err) {
      this.opts.log?.(`周报检查失败: ${errMessage(err)}`);
    } finally {
      this.running = false;
    }
  }
}
