import { DEFAULT_TIME_ZONE, localParts } from './time.js';

/** A quarter-hour value: interval start and its average import power. */
export interface KwPoint {
  start: number;
  kw: number;
}

export interface HeatmapCell {
  /** 0 = Monday … 6 = Sunday */
  weekday: number;
  /** local hour 0..23 */
  hour: number;
  /** max (or mean) kW of all quarter-hours in this cell; null if none */
  value: number | null;
  count: number;
}

/** Weekday × hour-of-day matrix (local time) of quarter-hour powers. Always 168 cells. */
export function heatmap(
  points: readonly KwPoint[],
  agg: 'max' | 'avg' = 'max',
  timeZone: string = DEFAULT_TIME_ZONE,
): HeatmapCell[] {
  const sum = new Float64Array(168);
  const max = new Float64Array(168).fill(-Infinity);
  const count = new Uint32Array(168);
  for (const p of points) {
    const { weekday, hour } = localParts(p.start, timeZone);
    const k = weekday * 24 + hour;
    sum[k]! += p.kw;
    if (p.kw > max[k]!) max[k] = p.kw;
    count[k]! += 1;
  }
  const cells: HeatmapCell[] = [];
  for (let k = 0; k < 168; k++) {
    const n = count[k]!;
    cells.push({
      weekday: Math.floor(k / 24),
      hour: k % 24,
      value: n === 0 ? null : agg === 'max' ? max[k]! : sum[k]! / n,
      count: n,
    });
  }
  return cells;
}

export interface HistogramBin {
  fromKw: number;
  toKw: number;
  count: number;
}

/** Fixed-width histogram starting at 0 kW (values below 0 go into the first bin). */
export function histogram(values: readonly number[], binKw = 0.5): HistogramBin[] {
  if (binKw <= 0) throw new Error('binKw must be > 0');
  if (values.length === 0) return [];
  const top = Math.max(...values);
  const n = Math.max(1, Math.floor(top / binKw) + 1);
  const bins: HistogramBin[] = Array.from({ length: n }, (_, i) => ({
    fromKw: i * binKw,
    toKw: (i + 1) * binKw,
    count: 0,
  }));
  for (const v of values) bins[Math.min(n - 1, Math.max(0, Math.floor(v / binKw)))]!.count++;
  return bins;
}

export interface DurationPoint {
  /** share of intervals (0..100 %) with a value at least `kw` */
  pct: number;
  kw: number;
}

/**
 * Load duration curve: values sorted descending against the share of time they are
 * reached. Downsampled to at most `maxPoints`, always keeping the maximum.
 */
export function durationCurve(values: readonly number[], maxPoints = 400): DurationPoint[] {
  const sorted = [...values].sort((a, b) => b - a);
  const n = sorted.length;
  if (n === 0) return [];
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const out: DurationPoint[] = [];
  for (let i = 0; i < n; i += step) out.push({ pct: ((i + 1) / n) * 100, kw: sorted[i]! });
  if (out.at(-1)!.pct !== 100) out.push({ pct: 100, kw: sorted[n - 1]! });
  return out;
}

/** Percentile (0..100) with linear interpolation. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}
