import {
  billedKw,
  intervalState,
  monthlyCost,
  tariffFor,
  dayKey,
  INTERVAL_MS,
  type LiveInterval,
} from '@peak-guard/core';
import type { PowerFlowReading } from '@peak-guard/fronius';
import type { LiveSnapshot, Settings } from '@peak-guard/shared';

export interface SnapshotInput {
  now: number;
  connection: LiveSnapshot['connection'];
  live: LiveInterval;
  gridW: number;
  flow: PowerFlowReading | null;
  /** Smoothed current import power used for the projection (W). */
  smoothedImportW: number;
  /** Month-to-date peak from closed intervals (raw, uncalibrated). */
  monthPeak: { start: number; kw: number } | null;
  settings: Settings;
  timeZone: string;
}

/**
 * Build the live snapshot shown in the UI. Pure.
 *
 * All kW values are multiplied by the calibration factor so the UI shows estimates of
 * what the billing meter will register.
 */
export function buildSnapshot(i: SnapshotInput): LiveSnapshot {
  const { settings: s, live } = i;
  const cal = s.calibrationFactor;
  const tariff = tariffFor(dayKey(i.now, i.timeZone), s.tariffs);
  const effectiveLimitKw = Math.max(s.thresholdKw, tariff.minBilledKw);

  const committedKw = live.committedKw * cal;
  const projectedKw =
    committedKw + (Math.max(0, i.smoothedImportW) / 1000) * (live.remainingMs / INTERVAL_MS) * cal;
  const monthPeak = i.monthPeak ? { start: i.monthPeak.start, kw: i.monthPeak.kw * cal } : null;
  const peakKw = monthPeak?.kw ?? 0;
  const monthCostEur = monthlyCost(peakKw, tariff);
  const projectedExtraCostEur = Math.max(
    0,
    monthlyCost(Math.max(peakKw, projectedKw), tariff) - monthCostEur,
  );

  return {
    ts: i.now,
    connection: i.connection,
    power: {
      gridW: i.gridW,
      loadW: i.flow?.loadW ?? null,
      pvW: i.flow?.pvW ?? null,
      batteryW: i.flow?.batteryW ?? null,
      socPct: i.flow?.socPct ?? null,
    },
    interval: {
      start: live.start,
      end: live.end,
      elapsedMs: live.elapsedMs,
      remainingMs: live.remainingMs,
      importWh: live.importWh * cal,
      runningAvgKw: live.runningAvgKw * cal,
      committedKw,
      projectedKw,
      completeness: live.completeness,
      source: live.source,
    },
    thresholdKw: s.thresholdKw,
    effectiveLimitKw,
    monthPeak,
    // Colour relative to the higher of the limit and the month peak: going above the
    // month peak is what costs money; staying under it is "free".
    state: intervalState(
      projectedKw,
      Math.max(effectiveLimitKw, billedKw(peakKw, tariff)),
      s.warnRatio,
    ),
    monthCostEur,
    projectedExtraCostEur,
  };
}

/** Time-weighted moving average of import power over a window. */
export class PowerSmoother {
  private readonly points: { ts: number; w: number }[] = [];
  constructor(private windowMs: number) {}

  setWindow(ms: number): void {
    this.windowMs = ms;
  }

  push(ts: number, importW: number): void {
    this.points.push({ ts, w: Math.max(0, importW) });
    while (this.points.length > 2 && this.points[0]!.ts < ts - this.windowMs) this.points.shift();
  }

  value(): number {
    const pts = this.points;
    const last = pts.at(-1);
    if (!last) return 0;
    if (this.windowMs <= 0 || pts.length < 2) return last.w;
    let area = 0;
    let span = 0;
    for (let k = 1; k < pts.length; k++) {
      const dt = pts[k]!.ts - pts[k - 1]!.ts;
      area += ((pts[k]!.w + pts[k - 1]!.w) / 2) * dt;
      span += dt;
    }
    return span > 0 ? area / span : last.w;
  }
}
