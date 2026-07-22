/** Tiny daily scheduler (local time) for the morning-report style jobs. */

export interface DailyTime {
  hh: number;
  mm: number;
}

export function parseDailyTime(raw: string): DailyTime | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/** Run fn once per day at the given local time. Returns a stop function. */
export function scheduleDaily(time: DailyTime, fn: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  const nextDelay = (): number => {
    const d = new Date();
    d.setHours(time.hh, time.mm, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime() - Date.now();
  };
  const loop = (): void => {
    try {
      fn();
    } finally {
      timer = setTimeout(loop, nextDelay());
      timer.unref();
    }
  };
  timer = setTimeout(loop, nextDelay());
  timer.unref();
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
