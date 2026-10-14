import {
  billable,
  dayKey,
  durationCurve,
  heatmap,
  histogram,
  percentile,
  tariffFor,
  type ClosedInterval,
  type DurationPoint,
  type HeatmapCell,
  type HistogramBin,
} from '@peak-guard/core';
import type { Settings } from '@peak-guard/shared';

export interface RangeAnalysis {
  count: number;
  maxKw: number | null;
  p50Kw: number | null;
  p95Kw: number | null;
  p99Kw: number | null;
  /** Effective limit at the start of the range (max of threshold and minimum billed power). */
  limitKw: number;
  /** Quarter-hours above the effective limit. */
  aboveLimit: number;
  heatmap: HeatmapCell[];
  histogram: HistogramBin[];
  duration: DurationPoint[];
}

/** Statistics over the quarter-hours of a range (pure; calibrated). */
export function analyzeRange(
  rows: readonly ClosedInterval[],
  settings: Settings,
  timeZone: string,
  agg: 'max' | 'avg' = 'max',
  binKw = 0.5,
): RangeAnalysis {
  const pts = billable(rows).map((r) => ({
    start: r.start,
    kw: r.avgImportKw * settings.calibrationFactor,
  }));
  const values = pts.map((p) => p.kw);
  const first = rows[0]?.start ?? Date.now();
  const tariff = tariffFor(dayKey(first, timeZone), settings.tariffs);
  const limitKw = Math.max(settings.thresholdKw, tariff.minBilledKw);
  return {
    count: values.length,
    maxKw: values.length ? Math.max(...values) : null,
    p50Kw: percentile(values, 50),
    p95Kw: percentile(values, 95),
    p99Kw: percentile(values, 99),
    limitKw,
    aboveLimit: values.filter((v) => v > limitKw).length,
    heatmap: heatmap(pts, agg, timeZone),
    histogram: histogram(values, binKw),
    duration: durationCurve(values),
  };
}
