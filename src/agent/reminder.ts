import fs from 'fs';
import path from 'path';
import { defaultDataHome } from '../infra/paths';
import { writeFileAtomicPrivateSync } from '../infra/private-file';
import { errMessage } from '../infra/err';

/**
 * 自然语言定时提醒：解析 / 持久化 / 到点判定 / 投递调度。
 * 提醒按用户分桶（bot 为 open_id，CLI 恒为 local），落盘 <home>/reminders.json
 * （原子写 0600），CLI 与 bot 共用同一文件与同一套核心逻辑；投递通道由调用方注入
 * （bot 注入飞书私聊推送，CLI 注入终端输出），本模块不依赖任何通道实现。
 *
 * 时间解析约定（对 LLM 最不易出错的设计）：工具只收两种参数——
 * - in_minutes：相对分钟数（「30 分钟后」直接传 30，LLM 无需知道当前时间）；
 * - at：本地时间字符串，支持「HH:mm」（当天，已过则顺延次日）、
 *   「今天/明天/后天 HH:mm」（含「9 点」「9 点半」口语形态）、「YYYY-MM-DD HH:mm」、
 *   带时区的标准时间串；LLM 不必自己推算日期。
 * 全部用本地时区（与晨报/周报等同口径）。
 */

export interface Reminder {
  id: string;
  text: string;
  /** 触发时刻（epoch ms，本地时区语义由格式化函数负责）。 */
  triggerAt: number;
  createdAt: number;
  status: 'pending' | 'delivered' | 'cancelled';
  /** 连续投递失败次数与下次允许重试时刻（指数退避，仅 pending 有意义）。 */
  failCount?: number;
  nextRetryAt?: number;
  deliveredAt?: number;
  cancelledAt?: number;
}

interface ReminderFile {
  version: number;
  users: Record<string, Reminder[]>;
}

const FILE_VERSION = 1;
/** 单用户活跃（未触发）提醒上限：防滥用（模型失控连建刷屏）。 */
export const MAX_ACTIVE_PER_USER = 20;
/** 最远期限：30 天（再远的日程建议用日历，提醒是短期工具）。 */
export const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
/** 提醒内容长度上限。 */
export const MAX_TEXT_LEN = 500;
/** 投递失败退避：1→2→4…分钟，封顶 30 分钟（与晨报同口径）。 */
const BACKOFF_CAP_MIN = 30;
/** 已终结（已投递/已取消）记录每用户保留条数：超出丢弃最旧，防文件无界增长。 */
const MAX_DONE_PER_USER = 50;

/** 本地时刻格式化为「YYYY-MM-DD HH:mm」（展示口径，全部本地时区）。 */
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 剩余时间的中文描述（列表/创建回执用）。 */
export function remainingText(triggerAt: number, nowMs: number): string {
  const diff = triggerAt - nowMs;
  if (diff <= 0) return '已到点';
  const min = Math.ceil(diff / 60000);
  if (min < 60) return `${min} 分钟后`;
  const hours = Math.floor(min / 60);
  if (hours < 24) {
    const rest = min % 60;
    return rest ? `${hours} 小时 ${rest} 分钟后` : `${hours} 小时后`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时后` : `${days} 天后`;
}

function validDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

/**
 * 解析「at」绝对时刻字符串（本地时区；now 仅用于「HH:mm 已过则顺延次日」与过去时间判定）。
 * 非法输入抛中文错误（工具层原样回报给模型）。
 */
function parseAbsoluteAt(raw: string, now: Date): number {
  const s = raw.trim();
  // 「今天/明天/后天/今晚/明晚 HH:mm」与裸「HH:mm」（全角冒号兼容；也接受「9 点」「9 点 5 分」「9 点半」口语形态；
  // 可带「早上/凌晨/上午/中午/下午/晚上」修饰，下午/晚上且小时 <12 自动 +12）
  const cn =
    /^(今天|明天|后天|今晚|明晚)?\s*(?:(早上|凌晨|上午|中午|下午|晚上)\s*)?(\d{1,2})\s*(?:[:：]\s*(\d{1,2})|点\s*(?:(\d{1,2})\s*分?|(半))?)$/u.exec(
      s,
    );
  if (cn) {
    let hour = Number(cn[3]);
    let minute: number;
    if (cn[6]) minute = 30;
    else if (cn[4] !== undefined) minute = Number(cn[4]);
    else if (cn[5] !== undefined) minute = Number(cn[5]);
    else minute = 0;
    const modifier = cn[2] || (cn[1] === '今晚' || cn[1] === '明晚' ? '晚上' : undefined);
    if ((modifier === '下午' || modifier === '晚上') && hour < 12) hour += 12;
    if (hour > 23 || minute > 59) throw new Error(`时间「${raw}」非法：小时须 0-23、分钟须 0-59`);
    const dayOffset = cn[1] === '明天' || cn[1] === '明晚' ? 1 : cn[1] === '后天' ? 2 : 0;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute, 0, 0);
    // 裸「HH:mm」：当天已过则顺延到明天（「提醒我 9 点」于 10 点说，显然是明早 9 点）
    if (!cn[1] && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // 「YYYY-MM-DD HH:mm」（本地时区；T 分隔与秒可选，秒按 0 处理之外的值保留）
  const local = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const d = new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      local[6] ? Number(local[6]) : 0,
      0,
    );
    // 回环校验：2 月 30 日等溢出会被 Date 自动进位，必须拒绝而非静默改期
    if (
      !validDate(d) ||
      d.getMonth() !== Number(local[2]) - 1 ||
      d.getDate() !== Number(local[3]) ||
      d.getHours() !== Number(local[4])
    ) {
      throw new Error(`时间「${raw}」非法：日期或时刻不存在`);
    }
    return d.getTime();
  }
  // 带时区的标准时间串（如 2026-09-05T09:00:00+08:00）：交给 Date.parse
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new Error(
    `无法识别的时间「${raw}」：支持「HH:mm」「今天/明天/后天 HH:mm」「YYYY-MM-DD HH:mm」（均为本地时间），相对时长请用 in_minutes 参数`,
  );
}

/**
 * 解析触发时刻：in_minutes（相对分钟数）与 at（本地时间字符串）二选一。
 * 过去时间与超出最远期限（30 天）一律拒绝（抛中文错误）。
 */
export function parseTriggerAt(opts: { at?: string; inMinutes?: number }, now: Date): number {
  const hasAt = typeof opts.at === 'string' && opts.at.trim() !== '';
  const hasMin = typeof opts.inMinutes === 'number';
  if (hasAt && hasMin) throw new Error('参数错误：at 与 in_minutes 只能传一个');
  if (!hasAt && !hasMin) throw new Error('参数错误：需传 at（触发时刻）或 in_minutes（多少分钟后）之一');
  let triggerAt: number;
  if (hasMin) {
    const m = opts.inMinutes!;
    if (!Number.isFinite(m) || m <= 0) throw new Error('参数错误：in_minutes 必须是大于 0 的数字（分钟）');
    triggerAt = now.getTime() + Math.round(m * 60000);
  } else {
    triggerAt = parseAbsoluteAt(opts.at!, now);
  }
  if (triggerAt <= now.getTime()) {
    throw new Error(`触发时刻已过（${formatLocal(triggerAt)}，现在 ${formatLocal(now.getTime())}）：提醒只能设在未来`);
  }
  if (triggerAt - now.getTime() > MAX_HORIZON_MS) {
    throw new Error('提醒最远只能设 30 天内；更远的日程建议用日历');
  }
  return triggerAt;
}

function newId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeReminder(raw: unknown): Reminder | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Reminder>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.text !== 'string' || !r.text) return null;
  if (typeof r.triggerAt !== 'number' || !Number.isFinite(r.triggerAt)) return null;
  if (r.status !== 'pending' && r.status !== 'delivered' && r.status !== 'cancelled') return null;
  return {
    id: r.id,
    text: r.text,
    triggerAt: r.triggerAt,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : r.triggerAt,
    status: r.status,
    ...(typeof r.failCount === 'number' ? { failCount: r.failCount } : {}),
    ...(typeof r.nextRetryAt === 'number' ? { nextRetryAt: r.nextRetryAt } : {}),
    ...(typeof r.deliveredAt === 'number' ? { deliveredAt: r.deliveredAt } : {}),
    ...(typeof r.cancelledAt === 'number' ? { cancelledAt: r.cancelledAt } : {}),
  };
}

function emptyFile(): ReminderFile {
  return { version: FILE_VERSION, users: {} };
}

/** 投递文案（bot 飞书私聊与 CLI 终端共用，全中文，含提醒内容与设定时间）。 */
export function buildReminderText(r: Reminder): string {
  return [
    '⏰ 提醒时间到',
    r.text,
    `（设定于 ${formatLocal(r.createdAt)}，定于 ${formatLocal(r.triggerAt)} 触发）`,
  ].join('\n');
}

export class ReminderStore {
  readonly filePath: string;

  constructor(homeDir?: string) {
    const root = homeDir || defaultDataHome();
    this.filePath = path.join(root, 'reminders.json');
  }

  private load(): ReminderFile {
    try {
      if (!fs.existsSync(this.filePath)) return emptyFile();
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<ReminderFile>;
      if (!raw || typeof raw !== 'object') return emptyFile();
      const users: Record<string, Reminder[]> = {};
      for (const [uid, list] of Object.entries(raw.users || {})) {
        if (!Array.isArray(list)) continue;
        users[uid] = list.map(normalizeReminder).filter((r): r is Reminder => r !== null);
      }
      return { version: typeof raw.version === 'number' ? raw.version : FILE_VERSION, users };
    } catch {
      // 解析失败：先改名备份再回退空文件（与 memory.ts 同策略），避免下次写盘覆盖损坏文件无备份
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败不阻塞回退 */
      }
      return emptyFile();
    }
  }

  /**
   * 读-改-写：每次操作都从磁盘重读再应用单个变更后原子写回。文件在 CLI 与 bot 间共享，
   * 重读合避免盲写全量覆盖丢掉另一进程的更新（与 memory.ts 的 journal 重放同思路，
   * 这里每次只改一条记录，重读+单点变更即可，无需 journal）。
   * 已知限制：无跨进程文件锁，两进程同一瞬间写仍可能互相覆盖（与 memory.ts 相同）。
   * 返回 false 表示写盘失败：调用方必须显式报错，不得谎报成功。
   */
  private mutate(fn: (file: ReminderFile) => void): boolean {
    try {
      const file = this.load();
      fn(file);
      for (const uid of Object.keys(file.users)) {
        const list = file.users[uid]!;
        // 已终结记录限量保留（丢弃最旧）；全空的桶整个删掉，防文件无界增长
        const done = list.filter((r) => r.status !== 'pending');
        if (done.length > MAX_DONE_PER_USER) {
          const drop = new Set(done.slice(0, done.length - MAX_DONE_PER_USER).map((r) => r.id));
          file.users[uid] = list.filter((r) => !drop.has(r.id));
        }
        if (!file.users[uid]!.length) delete file.users[uid];
      }
      writeFileAtomicPrivateSync(this.filePath, JSON.stringify(file, null, 2) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** 当前用户未触发提醒（按触发时刻升序；返回副本，外部改动不影响存储）。 */
  list(userId: string): Reminder[] {
    const list = this.load().users[userId] || [];
    return list.filter((r) => r.status === 'pending').sort((a, b) => a.triggerAt - b.triggerAt);
  }

  /** 按序号（list 顺序，1 起）或 id 查找未触发提醒。 */
  find(userId: string, ref: string): Reminder | null {
    const pending = this.list(userId);
    const n = Number(ref);
    if (Number.isInteger(n) && String(n) === ref.trim() && n >= 1 && n <= pending.length) {
      return pending[n - 1]!;
    }
    return pending.find((r) => r.id === ref.trim()) || null;
  }

  /** 创建提醒：活跃上限校验 + 落盘；写盘失败抛错（不谎报「已设置」）。 */
  add(userId: string, text: string, triggerAt: number): Reminder {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('提醒内容不能为空');
    const pending = this.list(userId);
    if (pending.length >= MAX_ACTIVE_PER_USER) {
      throw new Error(`待触发提醒已达上限（${MAX_ACTIVE_PER_USER} 条），请先取消不再需要的提醒`);
    }
    const reminder: Reminder = {
      id: newId(),
      text: trimmed.length > MAX_TEXT_LEN ? `${trimmed.slice(0, MAX_TEXT_LEN)}…（已截断）` : trimmed,
      triggerAt,
      createdAt: Date.now(),
      status: 'pending',
    };
    const ok = this.mutate((file) => {
      (file.users[userId] || (file.users[userId] = [])).push(reminder);
    });
    if (!ok) throw new Error('提醒保存失败，本次设置重启后会丢失，请再试一次');
    return { ...reminder };
  }

  /** 取消：返回被取消的提醒；不存在/已终结返回 null。写盘失败抛错（不谎报「已取消」）。 */
  cancel(userId: string, ref: string): Reminder | null {
    const target = this.find(userId, ref);
    if (!target) return null;
    const ok = this.mutate((file) => {
      const r = (file.users[userId] || []).find((x) => x.id === target.id);
      if (r && r.status === 'pending') {
        r.status = 'cancelled';
        r.cancelledAt = Date.now();
      }
    });
    if (!ok) throw new Error('提醒保存失败，本次取消重启后会丢失，请再试一次');
    return target;
  }

  /** 到期且不在退避窗口内的未触发提醒（跨全部用户；runner 每 tick 调用）。 */
  due(nowMs: number): Array<{ userId: string; reminder: Reminder }> {
    const file = this.load();
    const out: Array<{ userId: string; reminder: Reminder }> = [];
    for (const [uid, list] of Object.entries(file.users)) {
      for (const r of list) {
        if (r.status !== 'pending') continue;
        if (r.triggerAt > nowMs) continue;
        if ((r.nextRetryAt ?? 0) > nowMs) continue;
        out.push({ userId: uid, reminder: r });
      }
    }
    return out.sort((a, b) => a.reminder.triggerAt - b.reminder.triggerAt);
  }

  /** 投递成功落盘：已投递状态持久化，进程重启不重复推送。 */
  markDelivered(userId: string, id: string, nowMs: number): void {
    this.mutate((file) => {
      const r = (file.users[userId] || []).find((x) => x.id === id);
      if (r && r.status === 'pending') {
        r.status = 'delivered';
        r.deliveredAt = nowMs;
        delete r.failCount;
        delete r.nextRetryAt;
      }
    });
  }

  /** 投递失败落盘：连续失败指数退避（1→2→4…分钟，封顶 30 分钟），到点未投的之后补投。 */
  markFailed(userId: string, id: string, nowMs: number): void {
    this.mutate((file) => {
      const r = (file.users[userId] || []).find((x) => x.id === id);
      if (r && r.status === 'pending') {
        r.failCount = (r.failCount || 0) + 1;
        const backoffMin = Math.min(2 ** (r.failCount - 1), BACKOFF_CAP_MIN);
        r.nextRetryAt = nowMs + backoffMin * 60 * 1000;
      }
    });
  }
}

export interface ReminderRunnerOptions {
  store: ReminderStore;
  /** 投递通道（bot：飞书私聊推送；CLI：终端输出）。抛错视为投递失败，走退避补投。 */
  deliver: (userId: string, text: string) => Promise<void>;
  /** 到点检查间隔（默认 15s，最小 1s）；测试可注入更小值。 */
  checkIntervalMs?: number;
  /** 注入时钟（测试用）；默认真实时间。 */
  now?: () => Date;
  /** stop() 等待在途 tick 的兜底超时（默认 5s）。 */
  stopTimeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * 到点调度器（CLI 与 bot 共用）：tick 检查到期提醒 → 逐条经注入通道投递。
 * 每条提醒独立标记：投递成功即落盘 delivered（重启不重复推）；失败按 1→2→4…分钟
 * 指数退避（封顶 30 分钟）落盘 nextRetryAt，窗口过后补投——进程重启后到点未投的
 * 首次 tick 即补投，已投的不重复。
 */
export class ReminderRunner {
  private readonly opts: ReminderRunnerOptions;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: ReminderRunnerOptions) {
    this.opts = opts;
  }

  start(): void {
    const interval = Math.max(1000, this.opts.checkIntervalMs ?? 15000);
    void this.tick(); // 启动即检查一次：进程在到点之后才拉起时立即补投
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  /** 停止检查并等待在途 tick 结束（带兜底超时）：否则 shutdown 后在途投递会打到已关闭的通道。 */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + (this.opts.stopTimeoutMs ?? 5000);
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.running) this.opts.log?.('stop 等待在途提醒投递超时，继续关闭流程');
  }

  /** 单 tick：取出全部到期提醒逐条投递；单条失败不影响其余提醒。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowMs = (this.opts.now?.() ?? new Date()).getTime();
      for (const { userId, reminder } of this.opts.store.due(nowMs)) {
        try {
          await this.opts.deliver(userId, buildReminderText(reminder));
          this.opts.store.markDelivered(userId, reminder.id, nowMs);
          this.opts.log?.(`提醒已送达（${userId}）：${reminder.text.slice(0, 50)}`);
        } catch (err) {
          this.opts.store.markFailed(userId, reminder.id, nowMs);
          this.opts.log?.(`提醒投递失败（${userId}），退避后补投: ${errMessage(err)}`);
        }
      }
    } catch (err) {
      this.opts.log?.(`提醒检查失败: ${errMessage(err)}`);
    } finally {
      this.running = false;
    }
  }
}
