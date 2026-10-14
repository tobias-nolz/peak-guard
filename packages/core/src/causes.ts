/**
 * Heuristic "likely cause" of a high quarter-hour, from the power flows recorded during it.
 * Appliance-level data isn't available, so this explains the situation, not the device.
 */

export type PeakCause =
  /** Battery at its minimum SoC, so it could not help. */
  | 'battery_empty'
  /** Battery was discharging at (close to) its maximum power: load exceeded what it can cover. */
  | 'battery_limit'
  /** Battery had charge left but hardly discharged (standby, limit, or control). */
  | 'battery_idle'
  /** Battery was charging while power was imported. */
  | 'battery_charging'
  /** High import for most of the quarter-hour (EV, heat pump, oven, …). */
  | 'sustained_load'
  /** A brief, much higher spike dominated the interval. */
  | 'short_spike';

export interface CauseSample {
  ts: number;
  /** + import (W) */
  gridW: number;
  loadW: number | null;
  pvW: number | null;
  /** + discharge, − charge (W) */
  batteryW: number | null;
  socPct: number | null;
}

export interface CauseOptions {
  /** Battery max discharge power (W) if known, e.g. from SunSpec WChaMax. */
  batteryMaxW?: number | null;
  /** Inverter minimum SoC (%). */
  minSocPct?: number;
}

export interface CauseAnalysis {
  causes: PeakCause[];
  avgGridW: number;
  maxGridW: number;
  avgLoadW: number | null;
  avgPvW: number | null;
  avgBatteryW: number | null;
  socStart: number | null;
  socEnd: number | null;
  /** Minutes during which import was at least 80 % of the interval average. */
  sustainedMinutes: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function inferCauses(
  samples: readonly CauseSample[],
  opts: CauseOptions = {},
): CauseAnalysis | null {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a.ts - b.ts);
  const grid = s.map((x) => Math.max(0, x.gridW));
  const avgGridW = mean(grid)!;
  const maxGridW = Math.max(...grid);
  const bat = s.map((x) => x.batteryW).filter((v): v is number => v != null);
  const soc = s.map((x) => x.socPct).filter((v): v is number => v != null);
  const avgBatteryW = mean(bat);
  const socStart = soc[0] ?? null;
  const socEnd = soc.at(-1) ?? null;
  const minSoc = opts.minSocPct ?? 5;

  const spanMs = s.length > 1 ? s.at(-1)!.ts - s[0]!.ts : 0;
  const share = (pred: (w: number) => boolean) => grid.filter(pred).length / grid.length;
  const sustainedShare = share((w) => w >= 0.8 * avgGridW);
  const sustainedMinutes = (sustainedShare * Math.max(spanMs, 60_000)) / 60_000;

  const causes: PeakCause[] = [];
  if (avgBatteryW != null) {
    const maxDis = bat.length ? Math.max(...bat) : 0;
    if (avgBatteryW < -200 && avgGridW > 200) causes.push('battery_charging');
    else if (socEnd != null && socEnd <= minSoc + 2 && avgBatteryW < 200)
      causes.push('battery_empty');
    else if (opts.batteryMaxW && maxDis >= 0.9 * opts.batteryMaxW) causes.push('battery_limit');
    else if (avgBatteryW < 200 && (socEnd ?? 0) > minSoc + 5) causes.push('battery_idle');
  }
  if (maxGridW > 1.8 * avgGridW && share((w) => w > 1.2 * avgGridW) < 0.3)
    causes.push('short_spike');
  else if (sustainedShare >= 0.75) causes.push('sustained_load');

  return {
    causes,
    avgGridW,
    maxGridW,
    avgLoadW: mean(s.map((x) => x.loadW).filter((v): v is number => v != null)),
    avgPvW: mean(s.map((x) => x.pvW).filter((v): v is number => v != null)),
    avgBatteryW,
    socStart,
    socEnd,
    sustainedMinutes,
  };
}
