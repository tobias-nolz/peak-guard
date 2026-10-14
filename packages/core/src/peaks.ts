import type { ClosedInterval } from './interval.js';

export interface PeakInterval {
  start: number;
  avgImportKw: number;
}

/** Intervals with a usable billing value. */
export function billable<T extends Pick<ClosedInterval, 'avgImportKw' | 'quality'>>(
  intervals: readonly T[],
): (T & { avgImportKw: number })[] {
  return intervals.filter(
    (i): i is T & { avgImportKw: number } => i.avgImportKw != null && i.quality !== 'missing',
  );
}

/** Highest interval (first one wins on ties), or null. */
export function peakOf<T extends PeakInterval>(intervals: readonly T[]): T | null {
  let best: T | null = null;
  for (const i of intervals) if (!best || i.avgImportKw > best.avgImportKw) best = i;
  return best;
}

/** Top-N intervals by average import power, descending. */
export function topN<T extends PeakInterval>(intervals: readonly T[], n: number): T[] {
  return [...intervals]
    .sort((a, b) => b.avgImportKw - a.avgImportKw || a.start - b.start)
    .slice(0, n);
}

export type IntervalState = 'safe' | 'warning' | 'over';

/**
 * Colour state of a projected interval value against the effective limit
 * (max of threshold and month-to-date peak, if the latter is chosen as reference).
 */
export function intervalState(
  projectedKw: number,
  limitKw: number,
  warnRatio = 0.9,
): IntervalState {
  if (projectedKw > limitKw) return 'over';
  if (projectedKw > limitKw * warnRatio) return 'warning';
  return 'safe';
}
