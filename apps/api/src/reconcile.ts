import { INTERVAL_HOURS, monthKey, type ClosedInterval } from '@peak-guard/core';
import type { BillingRow } from '@peak-guard/db';

export interface ReconcileMonth {
  month: string;
  n: number;
  ownKwh: number;
  officialKwh: number;
  ownPeakKw: number | null;
  ownPeakStart: number | null;
  officialPeakKw: number | null;
  officialPeakStart: number | null;
}

export interface ReconcileResult {
  /** Quarter-hours present in both data sets. */
  n: number;
  /** Official quarter-hours without own data. */
  officialOnly: number;
  ownKwh: number;
  officialKwh: number;
  /** officialKwh / ownKwh */
  ratio: number | null;
  /** Least-squares factor (through the origin) official ≈ factor × own, over all pairs. */
  factorAll: number | null;
  /** Same, only over quarter-hours with ≥ 2 kW — what matters for the peak. */
  factorHighLoad: number | null;
  /** factorHighLoad when there are enough high-load pairs, else factorAll. */
  suggestedFactor: number | null;
  meanAbsDeltaKw: number | null;
  maxDelta: { start: number; ownKw: number; officialKw: number } | null;
  months: ReconcileMonth[];
  /** [start, ownKw (raw), officialKw] */
  points: [number, number, number][];
}

const kw = (wh: number) => wh / 1000 / INTERVAL_HOURS;

function lsq(pairs: readonly [number, number][]): number | null {
  let xy = 0;
  let xx = 0;
  for (const [x, y] of pairs) {
    xy += x * y;
    xx += x * x;
  }
  return xx > 0 ? xy / xx : null;
}

/** Compare own quarter-hours (raw, uncalibrated) with the billing meter's (pure). */
export function reconcile(
  own: readonly ClosedInterval[],
  official: readonly BillingRow[],
  timeZone: string,
): ReconcileResult {
  const ownByStart = new Map<number, number>();
  for (const o of own)
    if (o.importWh != null && o.quality !== 'missing') ownByStart.set(o.start, o.importWh);

  const points: [number, number, number][] = [];
  const months = new Map<string, ReconcileMonth>();
  let officialOnly = 0;
  for (const b of official) {
    const mine = ownByStart.get(b.start);
    if (mine == null) {
      officialOnly++;
      continue;
    }
    const p: [number, number, number] = [b.start, kw(mine), kw(b.importWh)];
    points.push(p);
    const key = monthKey(b.start, timeZone);
    const m = months.get(key) ?? {
      month: key,
      n: 0,
      ownKwh: 0,
      officialKwh: 0,
      ownPeakKw: null,
      ownPeakStart: null,
      officialPeakKw: null,
      officialPeakStart: null,
    };
    m.n++;
    m.ownKwh += mine / 1000;
    m.officialKwh += b.importWh / 1000;
    if (m.ownPeakKw == null || p[1] > m.ownPeakKw) [m.ownPeakKw, m.ownPeakStart] = [p[1], p[0]];
    if (m.officialPeakKw == null || p[2] > m.officialPeakKw)
      [m.officialPeakKw, m.officialPeakStart] = [p[2], p[0]];
    months.set(key, m);
  }

  const ownKwh = points.reduce((s, p) => s + p[1] * INTERVAL_HOURS, 0);
  const officialKwh = points.reduce((s, p) => s + p[2] * INTERVAL_HOURS, 0);
  const pairs = points.map((p) => [p[1], p[2]] as [number, number]);
  const high = pairs.filter(([x]) => x >= 2);
  const factorAll = lsq(pairs);
  const factorHighLoad = lsq(high);
  let maxDelta: ReconcileResult['maxDelta'] = null;
  for (const [start, o, f] of points) {
    if (!maxDelta || Math.abs(f - o) > Math.abs(maxDelta.officialKw - maxDelta.ownKw)) {
      maxDelta = { start, ownKw: o, officialKw: f };
    }
  }

  return {
    n: points.length,
    officialOnly,
    ownKwh,
    officialKwh,
    ratio: ownKwh > 0 ? officialKwh / ownKwh : null,
    factorAll,
    factorHighLoad,
    suggestedFactor: high.length >= 20 ? factorHighLoad : factorAll,
    meanAbsDeltaKw: points.length
      ? points.reduce((s, p) => s + Math.abs(p[2] - p[1]), 0) / points.length
      : null,
    maxDelta,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    points,
  };
}
