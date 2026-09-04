import fs from 'fs';
import { writeFileAtomicPrivateSync } from '../infra/private-file';

/**
 * 停滞任务提醒（stale nudge）：HTA_STALE_NUDGE_HOURS=N（小时）开启，默认关闭。
 * 由 watcher 每轮驱动：处于「进行中」的任务，其 updated_at（看板任务行上唯一可用的
 * 活动时间字段，无更细粒度心跳）距今超过阈值即提醒一次；同一停滞阶段只提醒一次，
 * 之后每 24 小时（remindIntervalMs）可再提醒一次；任务有更新（updated_at 变化）或
 * 状态流转（离开进行中/任务消失）后重置。提醒状态落盘（原子私有写 0600），
 * 进程重启不重复轰炸。文案口径与数据一致：只能说「超过 N 小时无更新」，
 * 不断言任务「卡死」——执行中的 attempt 不一定推动 updated_at。
 */

/** 解析 HTA_STALE_NUDGE_HOURS：未设置/空串返回 null（关闭）；非法值抛错（由调用方告警并关闭）。 */
export function parseStaleNudgeHours(raw: string | undefined): number | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`HTA_STALE_NUDGE_HOURS 值非法：${JSON.stringify(raw)}（应为正数小时，如 8）`);
  }
  return n;
}

/** 默认再次提醒间隔：24 小时。 */
export const STALE_REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** watcher 每轮喂给 tracker 的任务快照（仅判定所需字段）。 */
export interface StaleTaskSnapshot {
  id: string;
  status: string;
  /** updated_at 的解析结果（ms epoch）；缺失/无法解析为 null（不参与判定）。 */
  updatedAtMs: number | null;
}

interface StaleNudgeEntry {
  /** 提醒时任务的 updated_at（ms）：之后 updated_at 变化视为新阶段，重新计时。 */
  updatedAtMs: number;
  /** 最近一次提醒时间（ms epoch）。 */
  nudgedAt: number;
}

interface StaleNudgeState {
  tasks: Record<string, StaleNudgeEntry>;
}

export class StaleNudgeTracker {
  private readonly statePath: string;
  private readonly thresholdMs: number;
  private readonly remindIntervalMs: number;
  private entries: Record<string, StaleNudgeEntry>;

  constructor(opts: { statePath: string; thresholdMs: number; remindIntervalMs?: number }) {
    this.statePath = opts.statePath;
    this.thresholdMs = opts.thresholdMs;
    this.remindIntervalMs = opts.remindIntervalMs ?? STALE_REMIND_INTERVAL_MS;
    this.entries = this.load();
  }

  private load(): Record<string, StaleNudgeEntry> {
    try {
      if (!fs.existsSync(this.statePath)) return {};
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<StaleNudgeState>;
      if (!raw || typeof raw !== 'object' || !raw.tasks || typeof raw.tasks !== 'object') return {};
      const out: Record<string, StaleNudgeEntry> = {};
      for (const [id, e] of Object.entries(raw.tasks)) {
        if (!e || typeof e !== 'object') continue;
        const entry = e as Partial<StaleNudgeEntry>;
        if (typeof entry.updatedAtMs === 'number' && entry.updatedAtMs > 0 && typeof entry.nudgedAt === 'number' && entry.nudgedAt > 0) {
          out[id] = { updatedAtMs: entry.updatedAtMs, nudgedAt: entry.nudgedAt };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      writeFileAtomicPrivateSync(this.statePath, JSON.stringify({ tasks: this.entries }, null, 2) + '\n');
    } catch {
      /* best-effort：写盘失败时重启后可能重复提醒一次（重复优于丢失） */
    }
  }

  /**
   * 返回本轮应提醒的任务（id + 判定依据 updatedAtMs），并在返回时即记录 nudgedAt 落盘：
   * 推送失败由 watcher 的 (事件, owner) 重投队列兜底，tracker 不做第二次决策，
   * 否则下一 tick 会重复产出同一提醒事件。
   */
  due(tasks: StaleTaskSnapshot[], nowMs: number): Array<{ id: string; updatedAtMs: number }> {
    const out: Array<{ id: string; updatedAtMs: number }> = [];
    const active = new Set<string>();
    let dirty = false;
    for (const t of tasks) {
      // 只盯「进行中」：其它状态各有现成的事件推送（待审阅/完成/失败/取消）
      if (t.status !== 'inprogress') continue;
      active.add(t.id);
      const entry = this.entries[t.id];
      // updated_at 缺失/无法解析：无数据不判定；旧条目一并清掉（口径变化视为新阶段）
      if (t.updatedAtMs === null || !Number.isFinite(t.updatedAtMs)) {
        if (entry) {
          delete this.entries[t.id];
          dirty = true;
        }
        continue;
      }
      // 任务有更新（updated_at 变化）视为新停滞阶段：旧提醒记录重置，重新计时
      if (entry && entry.updatedAtMs !== t.updatedAtMs) {
        delete this.entries[t.id];
        dirty = true;
      }
      // 未到期（恰好到阈值即提醒：「超过 N 小时」按 >= 判定）
      if (nowMs - t.updatedAtMs < this.thresholdMs) continue;
      const cur = this.entries[t.id];
      // 同一停滞阶段已提醒过：间隔未满 24h 不再打扰
      if (cur && nowMs - cur.nudgedAt < this.remindIntervalMs) continue;
      this.entries[t.id] = { updatedAtMs: t.updatedAtMs, nudgedAt: nowMs };
      dirty = true;
      out.push({ id: t.id, updatedAtMs: t.updatedAtMs });
    }
    // 状态流转（离开进行中）或任务消失：重置提醒状态，下次进入进行中重新计
    for (const id of Object.keys(this.entries)) {
      if (!active.has(id)) {
        delete this.entries[id];
        dirty = true;
      }
    }
    if (dirty) this.persist();
    return out;
  }
}
