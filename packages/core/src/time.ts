/**
 * Time helpers for clock-aligned quarter-hours in a configurable time zone.
 *
 * Quarter-hour boundaries are computed on the UTC epoch. This is equivalent to local
 * clock alignment for every zone whose UTC offset is a whole multiple of 15 minutes,
 * which includes Europe/Vienna (+1h / +2h). DST therefore never splits or shifts a
 * quarter-hour; it only changes how many quarter-hours a local day has (92 or 100).
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const INTERVAL_MINUTES = 15;
export const INTERVAL_MS = INTERVAL_MINUTES * MINUTE_MS;
/** Interval length in hours (energy [kWh] / INTERVAL_HOURS = average power [kW]). */
export const INTERVAL_HOURS = INTERVAL_MS / HOUR_MS;

export const DEFAULT_TIME_ZONE = 'Europe/Vienna';

/** Start (inclusive) of the quarter-hour containing `ts`. */
export function intervalStart(ts: number): number {
  return Math.floor(ts / INTERVAL_MS) * INTERVAL_MS;
}

/** End (exclusive) of the quarter-hour containing `ts`. */
export function intervalEnd(ts: number): number {
  return intervalStart(ts) + INTERVAL_MS;
}

export interface LocalParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Monday … 6 = Sunday (ISO order) */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function localParts(ts: number, timeZone: string = DEFAULT_TIME_ZONE): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(ts)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 0,
  };
}

/** UTC offset of `timeZone` at instant `ts`, in milliseconds (local = utc + offset). */
export function tzOffsetMs(ts: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const p = localParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Epoch ms of a local wall-clock time. Non-existent times (spring-forward gap) resolve
 * to the instant after the gap; ambiguous times (fall-back) resolve to the first one.
 */
export function zonedToEpoch(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Try both offsets around the wall time; prefer the earliest that round-trips.
  const candidates = [
    wall - tzOffsetMs(wall - 12 * HOUR_MS, timeZone),
    wall - tzOffsetMs(wall + 12 * HOUR_MS, timeZone),
  ].sort((a, b) => a - b);
  for (const c of candidates) {
    if (c + tzOffsetMs(c, timeZone) === wall) return c;
  }
  // Wall time falls into a DST gap: shift by the later offset.
  return Math.max(...candidates);
}

/** Start of the local day containing `ts`. */
export function startOfLocalDay(ts: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const p = localParts(ts, timeZone);
  return zonedToEpoch(p.year, p.month, p.day, 0, 0, timeZone);
}

/** Start of the local month containing `ts`. */
export function startOfLocalMonth(ts: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const p = localParts(ts, timeZone);
  return zonedToEpoch(p.year, p.month, 1, 0, 0, timeZone);
}

/** Start of the local month following the one containing `ts`. */
export function startOfNextLocalMonth(ts: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const p = localParts(ts, timeZone);
  const [y, m] = p.month === 12 ? [p.year + 1, 1] : [p.year, p.month + 1];
  return zonedToEpoch(y, m, 1, 0, 0, timeZone);
}

/** "YYYY-MM" in local time. */
export function monthKey(ts: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = localParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" in local time. */
export function dayKey(ts: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = localParts(ts, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Number of quarter-hours in the local day containing `ts` (92, 96 or 100 in Vienna). */
export function intervalsInLocalDay(ts: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const start = startOfLocalDay(ts, timeZone);
  const p = localParts(start, timeZone);
  const next = zonedToEpoch(p.year, p.month, p.day + 1, 0, 0, timeZone);
  return (next - start) / INTERVAL_MS;
}
