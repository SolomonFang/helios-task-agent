import fs from 'fs';
import { writeFileAtomicPrivateSync } from '../infra/private-file';
import { errMessage } from '../infra/err';
import { fetchKanbanHealth } from '../kanban/http';
import { collectWorkSummary, statusLabel, type WorkSummaryData, type WorkSummaryTask } from '../kanban/summary';

/**
 * 定时晨报：HTA_DAILY_BRIEF=HH:MM（本地时间）开启，默认关闭。
 * bot 运行期间每分钟检查一次是否到点；到点且当天未推送过则给 owner 推一条
 * 当前迭代的看板任务概览（复用 work_summary 采集）。「上次推送日期 + 已送达 owner」
 * 落盘（原子写），重启当天不重复推；部分 owner 推送失败时下一 tick 只补投未送达的。
 * 看板不可达 / 采集失败 / 推送失败：本次跳过并记日志（不打扰用户），失败后按 1→2→4…分钟
 * 指数退避（封顶 30 分钟）再试，当天内有效——防异常 owner 导致每分钟全量采集重试。
 * 仅 bot 形态装配（CLI 不引本模块）；owner 未认领（白名单为空）时不推、不标记，认领后当天仍可补推。
 */

export interface DailyBriefTime {
  hour: number;
  minute: number;
}

/** 解析 HTA_DAILY_BRIEF（HH:MM，本地时间）：未设置/空串返回 null；非法值抛错（由调用方 console.warn）。 */
export function parseDailyBriefTime(raw: string | undefined): DailyBriefTime | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(v);
  const hour = m ? Number(m[1]) : NaN;
  if (!m || hour > 23) {
    throw new Error(`HTA_DAILY_BRIEF 值非法: ${JSON.stringify(raw)}（应为 HH:MM，如 09:30）`);
  }
  return { hour, minute: Number(m![2]) };
}

/** 本地日期 YYYY-MM-DD（与推送判重同口径，必须用本地时区而非 toISOString）。 */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 每个分组最多列出的任务标题数（晨报是概览，全量走「总结一下这个迭代做了什么」报告）。 */
const MAX_LIST = 10;

function listSection(label: string, tasks: WorkSummaryTask[], opts?: { showStatus?: boolean }): string[] {
  if (!tasks.length) return [];
  const lines = [`【${label}】${tasks.length} 个`];
  // 标题来自看板数据：文本消息无 markdown 解析，原样输出即可，不做转义
  // 失败分组与状态分组正交（同一任务两边都出现）：标注原状态消除「重复计数」困惑
  for (const t of tasks.slice(0, MAX_LIST)) {
    lines.push(`· 《${t.title}》${opts?.showStatus ? `（${statusLabel(t.status)}）` : ''}`);
  }
  if (tasks.length > MAX_LIST) lines.push(`· …还有 ${tasks.length - MAX_LIST} 个`);
  return lines;
}

/** 晨报文本（纯函数便于单测）：数量概览 + 各状态标题清单；空迭代给一句兜底。 */
export function buildDailyBriefText(data: WorkSummaryData, now: Date): string {
  const inprogress = data.tasks.filter((t) => t.status === 'inprogress');
  const inreview = data.tasks.filter((t) => t.status === 'inreview');
  const done = data.tasks.filter((t) => t.status === 'done');
  // 失败按 last_attempt_failed 标记独立分组（与状态正交：失败任务可能停在 inprogress 等任意状态）
  const failed = data.tasks.filter((t) => t.failed);
  const lines = [
    `☀️ 看板晨报 · ${data.sinceLabel}（${localDateStr(now)}）`,
    `进行中 ${inprogress.length} · 待审阅 ${inreview.length} · 已完成 ${done.length} · 失败 ${failed.length}`,
  ];
  if (!data.tasks.length) {
    lines.push('', '当前范围内还没有任务。');
  } else {
    for (const section of [
      listSection('进行中', inprogress),
      listSection('待审阅', inreview),
      listSection('已完成', done),
      listSection('失败', failed, { showStatus: true }),
    ]) {
      if (section.length) lines.push('', ...section);
    }
  }
  // 底部引导语与晨报范围匹配：配置了迭代引导「总结这个迭代」，未配置（范围为全部迭代）引导「总结看板进展」
  lines.push('', data.iteration ? '回复「总结一下这个迭代做了什么」看完整报告' : '回复「总结一下看板进展」看完整报告');
  return lines.join('\n');
}

interface DailyBriefState {
  /** 最近一次推送的本地日期（YYYY-MM-DD）：与今天相同则只补投未送达 owner。 */
  date: string;
  /** 当天已送达的 owner open_id（部分失败时下一 tick 只补投未送达的，避免重复刷屏）。 */
  delivered: string[];
}

export interface DailyBriefOptions {
  time: DailyBriefTime;
  statePath: string;
  kanbanUrl: string;
  projectId?: string;
  /** 当前迭代名（HELIOS_KANBAN_ITERATION）；缺省时范围为全部迭代。 */
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

export class DailyBrief {
  private readonly opts: DailyBriefOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private state: DailyBriefState | null;
  /** 连续失败次数与下次允许重试时间（ms）：失败指数退避，防异常 owner 导致每分钟全量采集。 */
  private failStreak = 0;
  private nextRetryAt = 0;

  constructor(opts: DailyBriefOptions) {
    this.opts = opts;
    this.state = this.load();
  }

  start(): void {
    const interval = Math.max(5000, this.opts.checkIntervalMs ?? 60000);
    void this.tick(); // 启动即检查一次：进程在到点之后才拉起时当天仍可补推
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

  private load(): DailyBriefState | null {
    try {
      if (!fs.existsSync(this.opts.statePath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8')) as Partial<DailyBriefState>;
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

  /** 单 tick：到点且当天未全员送达才推送。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.opts.now?.() ?? new Date();
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
        this.opts.log?.(`看板不可达，本次晨报跳过（退避后再试）`);
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
        this.opts.log?.(`晨报采集失败，本次跳过: ${errMessage(err)}`);
        return;
      }
      const text = buildDailyBriefText(data, now);
      const sent = [...delivered];
      let failed = 0;
      for (const owner of targets) {
        try {
          await this.opts.notifyOwner(owner, text);
          sent.push(owner);
        } catch (err) {
          failed++;
          this.opts.log?.(`晨报推送失败（${owner}）: ${errMessage(err)}`);
        }
      }
      this.state = { date: today, delivered: sent };
      this.persist();
      if (failed) {
        this.markFailure(now.getTime());
        this.opts.log?.(`${failed} 个 owner 晨报未送达，退避后补投`);
      } else {
        this.failStreak = 0;
        this.nextRetryAt = 0;
        this.opts.log?.(`晨报已送达 ${targets.length} 个 owner`);
      }
    } catch (err) {
      this.opts.log?.(`晨报检查失败: ${errMessage(err)}`);
    } finally {
      this.running = false;
    }
  }
}
