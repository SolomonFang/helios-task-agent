import fs from 'fs';
import { writeFileAtomicPrivateSync } from '../infra/private-file';
import { errMessage } from '../infra/err';
import { fetchKanbanHealth } from '../kanban/http';
import { collectWorkSummary, type WorkSummaryData, type WorkSummaryTask } from '../kanban/summary';
import { isKnownStatus, statusLabel } from '../kanban/status';

// HH:MM 解析单源在 config/flags-parsers.ts（config 层，runtime-flags 直接依赖）；
// 此处 re-export 保持既有导入路径不变
export { parseBriefTime, type BriefTime } from '../config/flags-parsers';

/**
 * 定时简报（晨报 daily-brief / 周报 weekly-brief）的共享调度骨架：
 * 到点判定（子类 due()）→ owner 判重（落盘「上次推送日期 + 已送达 owner」，原子写，
 * 重启不重复推；部分 owner 失败时下一 tick 只补投未送达的）→ 看板健康检查 → 采集 → 推送。
 * 看板不可达 / 采集失败 / 推送失败：本次跳过并记日志（不打扰用户），按 1→2→4…分钟
 * 指数退避（封顶 30 分钟）再试，本周期内有效——防异常 owner 导致每分钟全量采集重试。
 * 子类只提供：到点判定 + 判重周期口径（due）、推送文案（buildText）。
 */

/** 本地日期 YYYY-MM-DD（与推送判重同口径，必须用本地时区而非 toISOString）。 */
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 每个分组最多列出的任务标题数（简报是概览，全量走「总结一下这个迭代做了什么」报告）。 */
const MAX_LIST = 10;

/**
 * 分组小节：标题计数用 total（totals 的截断前全量，与头部计数行同口径），
 * 列表仍是 data.tasks 的截断样本；截断时用「…还有 N 个」按全量口径补剩余数。
 */
export function listSection(label: string, tasks: WorkSummaryTask[], opts?: { showStatus?: boolean; total?: number }): string[] {
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

/** 推送日志的 owner open_id 脱敏（与 confirm.ts logSettle 同口径）：头尾保留、中间打码；短 id 整体打码。 */
function maskOwner(openId: string): string {
  return openId.length > 8 ? `${openId.slice(0, 4)}…${openId.slice(-2)}` : '***';
}

interface BriefState {
  /** 最近一次推送的本地日期（YYYY-MM-DD）：是否处于本判重周期由 due().inPeriod 判定。 */
  date: string;
  /** 本周期已送达的 owner open_id（部分失败时下一 tick 只补投未送达的，避免重复刷屏）。 */
  delivered: string[];
}

/** due() 判定本 tick 应推送时返回的计划。 */
export interface BriefDue {
  /** 判重周期口径：state.date 满足本周期时其 delivered 仍有效（晨报为「当天」，周报为「当周」，补推日同样认本周期记录）。 */
  inPeriod: (stateDate: string) => boolean;
  /** 推送文案（采集数据就绪后由 tick 调用）。 */
  buildText: (data: WorkSummaryData) => string;
  /** 全员送达日志的附注（如周报补发时为「（补发）」）。 */
  deliveredSuffix?: string;
}

export interface BriefSchedulerOptions {
  /** 简报名（日志用）：「晨报」/「周报」。 */
  label: string;
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

export abstract class BriefScheduler {
  protected readonly opts: BriefSchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private state: BriefState | null;
  /** 连续失败次数与下次允许重试时间（ms）：失败指数退避，防异常 owner 导致每分钟全量采集。 */
  private failStreak = 0;
  private nextRetryAt = 0;

  constructor(opts: BriefSchedulerOptions) {
    this.opts = opts;
    this.state = this.load();
  }

  /** 到点判定：null = 本 tick 不推；否则返回判重周期口径与文案构建器。 */
  protected abstract due(now: Date): BriefDue | null;

  start(): void {
    const interval = Math.max(5000, this.opts.checkIntervalMs ?? 60000);
    void this.tick(); // 启动即检查一次：进程在到点之后才拉起时本周期仍可补推
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

  private load(): BriefState | null {
    try {
      if (!fs.existsSync(this.opts.statePath)) return null;
      const raw = JSON.parse(fs.readFileSync(this.opts.statePath, 'utf8')) as Partial<BriefState>;
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

  /** 单 tick：到点且本周期未全员送达才推送。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const label = this.opts.label;
    try {
      const now = this.opts.now?.() ?? new Date();
      const due = this.due(now);
      if (!due) return;
      const owners = this.opts.owners();
      if (!owners.length) return; // owner 未认领不推、不标记（认领后本周期到点仍可补推）
      const today = localDateStr(now);
      const delivered = this.state && due.inPeriod(this.state.date) ? this.state.delivered : [];
      const targets = owners.filter((o) => !delivered.includes(o));
      if (!targets.length) return; // 本周期已全员送达
      if (now.getTime() < this.nextRetryAt) return; // 失败退避中，等下一个窗口

      const health = this.opts.healthCheck
        ? await this.opts.healthCheck()
        : (await fetchKanbanHealth(this.opts.kanbanUrl)) === 'ok';
      if (!health) {
        // 看板不可达：跳过本次推送（不推「不可达」消息打扰用户），不标记，退避后本周期内再试
        this.markFailure(now.getTime());
        this.opts.log?.(`看板不可达，本次${label}跳过（退避后再试）`);
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
        this.opts.log?.(`${label}采集失败，本次跳过：${errMessage(err)}`);
        return;
      }
      const text = due.buildText(data);
      const sent = [...delivered];
      let failed = 0;
      for (const owner of targets) {
        try {
          await this.opts.notifyOwner(owner, text);
          sent.push(owner);
        } catch (err) {
          failed++;
          this.opts.log?.(`${label}推送失败（${maskOwner(owner)}）：${errMessage(err)}`);
        }
      }
      this.state = { date: today, delivered: sent };
      this.persist();
      if (failed) {
        this.markFailure(now.getTime());
        this.opts.log?.(`${failed} 个 owner ${label}未送达，退避后补投`);
      } else {
        this.failStreak = 0;
        this.nextRetryAt = 0;
        this.opts.log?.(`${label}已送达 ${targets.length} 个 owner${due.deliveredSuffix ?? ''}`);
      }
    } catch (err) {
      this.opts.log?.(`${label}检查失败：${errMessage(err)}`);
    } finally {
      this.running = false;
    }
  }
}
