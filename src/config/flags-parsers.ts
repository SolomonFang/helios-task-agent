/**
 * 运行期开关的 env 解析纯函数（config 层单源）：HH:MM 时刻（晨报/周报）、周报星期、
 * 停滞提醒阈值。bot（daily-brief / weekly-brief / brief-scheduler）与 kanban（stale-nudge）
 * 侧仅 re-export 保持既有导入路径；runtime-flags.ts 只依赖本模块——
 * config 层不再反向依赖 bot/kanban 层。
 */

/** HH:MM 形态的本地时间（晨报/周报推送时刻共用）。 */
export interface BriefTime {
  hour: number;
  minute: number;
}

/** 解析 HH:MM（本地时间）：未设置/空串返回 null；非法值抛错（由调用方 console.warn）。envName/example 仅用于报错文案。 */
export function parseBriefTime(raw: string | undefined, envName: string, example: string): BriefTime | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(v);
  const hour = m ? Number(m[1]) : NaN;
  if (!m || hour > 23) {
    throw new Error(`${envName} 值非法：${JSON.stringify(raw)}（应为 HH:MM，如 ${example}）`);
  }
  return { hour, minute: Number(m![2]) };
}

/** 定时晨报推送时刻（本地时间）。 */
export type DailyBriefTime = BriefTime;

/** 解析 HTA_DAILY_BRIEF（HH:MM，本地时间）：未设置/空串返回 null；非法值抛错（由调用方 console.warn）。 */
export function parseDailyBriefTime(raw: string | undefined): DailyBriefTime | null {
  return parseBriefTime(raw, 'HTA_DAILY_BRIEF', '09:30');
}

/** 定时周报推送时刻（本地时间）。 */
export type WeeklyBriefTime = BriefTime;

/** 默认推送星期：周五。 */
export const DEFAULT_WEEKLY_BRIEF_DAY = 5;

/** 解析 HTA_WEEKLY_BRIEF（HH:MM，本地时间）：未设置/空串返回 null；非法值抛错（由调用方 console.warn）。 */
export function parseWeeklyBriefTime(raw: string | undefined): WeeklyBriefTime | null {
  return parseBriefTime(raw, 'HTA_WEEKLY_BRIEF', '18:00');
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
