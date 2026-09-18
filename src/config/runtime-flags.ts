/**
 * 运行期开关统一解析（cli / bot / handler 不再散落直读 process.env）：
 * KANBAN_WATCH / KANBAN_WATCH_INTERVAL_SEC / HTA_STALE_NUDGE_HOURS /
 * HTA_DAILY_BRIEF / HTA_WEEKLY_BRIEF / HTA_WEEKLY_BRIEF_DAY。
 * 非法值的告警集中在 readRuntimeFlags（warn 回调注入，调用方决定着色/前缀）；
 * 具体解析规则仍由各自模块的 parse 函数承担（单一事实源），这里只做编排与告警收口。
 */

import { parseStaleNudgeHours } from '../kanban/stale-nudge';
import { parseDailyBriefTime, type DailyBriefTime } from '../bot/daily-brief';
import { parseWeeklyBriefDay, parseWeeklyBriefTime, type WeeklyBriefTime } from '../bot/weekly-brief';
import { errMessage } from '../infra/err';

export interface RuntimeFlags {
  /** 看板状态主动推送（KANBAN_WATCH=0 关闭，默认开）。 */
  kanbanWatch: boolean;
  /** 看板推送轮询间隔（秒）：默认 60、下限 15；非法值告警并按默认。 */
  kanbanWatchIntervalSec: number;
  /** 停滞任务提醒阈值（小时；null=关闭；非法值告警并关闭）。依赖看板推送（watcher）驱动。 */
  staleNudgeHours: number | null;
  /** 定时晨报时间（本地时间；null=关闭；非法值告警并关闭）。 */
  dailyBriefTime: DailyBriefTime | null;
  /** 定时周报时间（本地时间；null=关闭；非法值告警并关闭）。 */
  weeklyBriefTime: WeeklyBriefTime | null;
  /** 周报推送星期（1=周一…7=周日，默认 5 周五；非法值告警并按默认处理，不关闭功能）。 */
  weeklyBriefDay: number;
}

export function readRuntimeFlags(env: NodeJS.ProcessEnv, warn: (msg: string) => void): RuntimeFlags {
  const kanbanWatch = env.KANBAN_WATCH !== '0';

  let intervalSec = 60;
  const rawInterval = (env.KANBAN_WATCH_INTERVAL_SEC ?? '').trim();
  if (rawInterval) {
    const n = Number(rawInterval);
    if (Number.isFinite(n) && n > 0) intervalSec = n;
    else warn(`KANBAN_WATCH_INTERVAL_SEC 值非法：${JSON.stringify(env.KANBAN_WATCH_INTERVAL_SEC)}（应为正数秒，如 60），已按默认 60 秒`);
  }

  let staleNudgeHours: number | null = null;
  try {
    staleNudgeHours = parseStaleNudgeHours(env.HTA_STALE_NUDGE_HOURS);
  } catch (err) {
    warn(`${errMessage(err)}，停滞任务提醒已关闭`);
  }

  let dailyBriefTime: DailyBriefTime | null = null;
  try {
    dailyBriefTime = parseDailyBriefTime(env.HTA_DAILY_BRIEF);
  } catch (err) {
    warn(`${errMessage(err)}，定时晨报已关闭`);
  }

  let weeklyBriefTime: WeeklyBriefTime | null = null;
  try {
    weeklyBriefTime = parseWeeklyBriefTime(env.HTA_WEEKLY_BRIEF);
  } catch (err) {
    warn(`${errMessage(err)}，定时周报已关闭`);
  }
  let weeklyBriefDay = parseWeeklyBriefDay(undefined);
  try {
    weeklyBriefDay = parseWeeklyBriefDay(env.HTA_WEEKLY_BRIEF_DAY);
  } catch (err) {
    warn(`${errMessage(err)}，按默认周五推送`);
  }

  return {
    kanbanWatch,
    kanbanWatchIntervalSec: Math.max(15, intervalSec),
    staleNudgeHours,
    dailyBriefTime,
    weeklyBriefTime,
    weeklyBriefDay,
  };
}

let cached: RuntimeFlags | null = null;

/**
 * 进程级运行开关：惰性解析一次（首个调用方的 warn 生效，非法值告警只发一次）；
 * 之后各处（/status 展示等）读取的都是同一份结果。
 */
export function runtimeFlags(warn?: (msg: string) => void): RuntimeFlags {
  if (!cached) cached = readRuntimeFlags(process.env, warn ?? ((m) => console.warn(m)));
  return cached;
}
