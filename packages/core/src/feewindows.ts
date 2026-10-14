import { DEFAULT_TIME_ZONE, localParts } from './time.js';

/** A time window with a different (typically lower) grid fee, in local time. */
export interface FeeWindow {
  id: string;
  label: string;
  /** 1–12; empty = all months */
  months: number[];
  /** 0 = Monday … 6 = Sunday; empty = all days */
  weekdays: number[];
  /** "HH:MM" local time; `to` < `from` spans midnight */
  from: string;
  to: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** The first window active at `ts`, or null. Day/month refer to the window's start day for overnight windows. */
export function activeFeeWindow<T extends FeeWindow>(
  ts: number,
  windows: readonly T[],
  timeZone = DEFAULT_TIME_ZONE,
): T | null {
  if (windows.length === 0) return null;
  const p = localParts(ts, timeZone);
  const now = p.hour * 60 + p.minute;
  for (const w of windows) {
    const from = minutes(w.from);
    const to = minutes(w.to);
    const overnight = to <= from;
    // For the part after midnight of an overnight window, the window "belongs" to the previous day.
    const afterMidnight = overnight && now < to;
    const inTime = overnight ? now >= from || now < to : now >= from && now < to;
    if (!inTime) continue;
    let weekday = p.weekday;
    let month = p.month;
    if (afterMidnight) {
      const prev = localParts(ts - 24 * 3_600_000, timeZone);
      weekday = prev.weekday;
      month = prev.month;
    }
    if (w.months.length && !w.months.includes(month)) continue;
    if (w.weekdays.length && !w.weekdays.includes(weekday)) continue;
    return w;
  }
  return null;
}
