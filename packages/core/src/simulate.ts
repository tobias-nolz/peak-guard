/**
 * What-if replay of historical power flows against a (hypothetical) battery and control
 * strategy. Works on the household's *net demand* (load − PV), which doesn't depend on
 * what the real battery did, so different capacities, reserves and thresholds can be
 * compared on the same history.
 */

import { decide, type ControlConfig } from './control.js';
import { INTERVAL_HOURS, INTERVAL_MS, intervalStart, monthKey, DEFAULT_TIME_ZONE } from './time.js';

export interface NetPoint {
  ts: number;
  /** load − PV (W); positive = deficit the grid or battery must cover. */
  netW: number;
}

export type Strategy =
  /** No battery at all. */
  | 'none'
  /** Battery covers deficits down to the minimum SoC (today's Gen24 behaviour). */
  | 'selfConsumption'
  /** Self-consumption above the reserve, peak shaving below it (decide()). */
  | 'shaving';

export interface BatteryModel {
  capacityKwh: number;
  maxPowerKw: number;
  /** One-way efficiency (0..1). */
  efficiency: number;
  minSocPct: number;
  initialSocPct: number;
}

export interface SimulationParams {
  strategy: Strategy;
  battery: BatteryModel;
  control: Omit<ControlConfig, 'maxDischargeW' | 'minSocPct'>;
  timeZone?: string;
  /** Gaps between points longer than this are not integrated (missing data). */
  maxGapMs?: number;
}

export interface SimMonth {
  month: string;
  peakKw: number;
  peakStart: number | null;
  intervals: number;
  /** Quarter-hours in which the controller discharged in shave mode. */
  shaveIntervals: number;
  /** Quarter-hours that still ended above the (non-adaptive) target. */
  overTarget: number;
  importKwh: number;
  /** Battery energy delivered in shave mode (kWh). */
  shaveKwh: number;
  /** Total battery energy delivered (kWh). */
  dischargeKwh: number;
  /** Lowest SoC reached (%). */
  minSocPct: number;
}

export interface SimResult {
  months: SimMonth[];
  peakKw: number;
}

const H = 3_600_000;

export function simulatePeakShaving(points: readonly NetPoint[], p: SimulationParams): SimResult {
  const tz = p.timeZone ?? DEFAULT_TIME_ZONE;
  const maxGap = p.maxGapMs ?? 5 * 60_000;
  const b = p.battery;
  const capWh = b.capacityKwh * 1000;
  const maxW = b.maxPowerKw * 1000;
  const hasBattery = p.strategy !== 'none' && capWh > 0 && maxW > 0;
  const reservePct = p.strategy === 'shaving' ? p.control.reservePct : b.minSocPct;
  const cfg: ControlConfig = {
    ...p.control,
    reservePct,
    minSocPct: b.minSocPct,
    maxDischargeW: maxW,
  };
  const baseTarget = Math.max(cfg.thresholdKw, cfg.minBilledKw);

  let socWh = (b.initialSocPct / 100) * capWh;
  const months = new Map<string, SimMonth>();
  let curStart: number | null = null;
  let eWh = 0;
  let shavedThisInterval = false;
  let monthPeak: number | null = null;
  let curMonth: string | null = null;
  // Month of the current interval (quarter-hours never span months), cached because
  // time-zone formatting is by far the most expensive operation in the loop.
  let curM: SimMonth | null = null;

  const monthOf = (key: string): SimMonth => {
    let m = months.get(key);
    if (!m) {
      m = {
        month: key,
        peakKw: 0,
        peakStart: null,
        intervals: 0,
        shaveIntervals: 0,
        overTarget: 0,
        importKwh: 0,
        shaveKwh: 0,
        dischargeKwh: 0,
        minSocPct: 100,
      };
      months.set(key, m);
    }
    return m;
  };

  const closeInterval = () => {
    if (curStart == null || !curM) return;
    const m = curM;
    const kw = eWh / 1000 / INTERVAL_HOURS;
    m.intervals++;
    if (shavedThisInterval) m.shaveIntervals++;
    if (kw > baseTarget + 1e-9) m.overTarget++;
    if (kw > m.peakKw) {
      m.peakKw = kw;
      m.peakStart = curStart;
    }
    monthPeak = Math.max(monthPeak ?? 0, kw);
  };

  for (let k = 0; k < points.length; k++) {
    const pt = points[k]!;
    const next = points[k + 1];
    if (!next || next.ts - pt.ts > maxGap) continue;
    // Integrate this point's power until the next point, split at the interval boundary.
    let t = pt.ts;
    while (t < next.ts) {
      const end = Math.min(next.ts, intervalStart(t) + INTERVAL_MS);
      if (intervalStart(t) !== curStart) {
        closeInterval();
        curStart = intervalStart(t);
        eWh = 0;
        shavedThisInterval = false;
        const key = monthKey(curStart, tz);
        if (key !== curMonth) {
          curMonth = key;
          monthPeak = null;
        }
        curM = monthOf(key);
      }
      const m = curM!;
      const dtH = (end - t) / H;
      const net = pt.netW;
      let batW = 0;
      const socPct = capWh > 0 ? (socWh / capWh) * 100 : 0;
      if (hasBattery) {
        if (net > 0) {
          let limit: number | null = null;
          let floorPct = b.minSocPct;
          if (p.strategy === 'shaving') {
            const d = decide(
              {
                elapsedMs: t - curStart,
                importWh: eWh,
                gridW: net,
                batteryW: 0,
                socPct,
                monthPeakKw: monthPeak,
              },
              cfg,
            );
            limit = d.dischargeLimitW;
            // In release mode the controller switches to hold at the reserve.
            floorPct = d.mode === 'release' ? cfg.reservePct : b.minSocPct;
            if (d.mode === 'shave') shavedThisInterval = true;
          }
          const availW = (Math.max(0, socWh - (floorPct / 100) * capWh) * b.efficiency) / dtH;
          batW = Math.min(net, maxW, limit ?? Infinity, availW);
          m.dischargeKwh += (batW * dtH) / 1000;
          if (p.strategy === 'shaving' && limit != null && limit > 0)
            m.shaveKwh += (batW * dtH) / 1000;
          socWh -= (batW * dtH) / b.efficiency;
        } else if (net < 0) {
          const roomW = Math.max(0, capWh - socWh) / b.efficiency / dtH;
          batW = -Math.min(-net, maxW, roomW);
          socWh += -batW * dtH * b.efficiency;
        }
      }
      const gridW = net - batW;
      eWh += Math.max(0, gridW) * dtH;
      m.importKwh += (Math.max(0, gridW) * dtH) / 1000;
      if (capWh > 0) m.minSocPct = Math.min(m.minSocPct, (socWh / capWh) * 100);
      t = end;
    }
  }
  closeInterval();

  const list = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  return { months: list, peakKw: Math.max(0, ...list.map((m) => m.peakKw)) };
}

export interface SweepAxis {
  thresholdsKw: number[];
  reservesPct: number[];
  capacitiesKwh: number[];
}

export interface SweepCell {
  thresholdKw: number;
  reservePct: number;
  capacityKwh: number;
  result: SimResult;
}

/** Run the shaving strategy for every combination of the axes. */
export function sweep(
  points: readonly NetPoint[],
  base: SimulationParams,
  axes: SweepAxis,
): SweepCell[] {
  const cells: SweepCell[] = [];
  for (const capacityKwh of axes.capacitiesKwh) {
    for (const thresholdKw of axes.thresholdsKw) {
      for (const reservePct of axes.reservesPct) {
        cells.push({
          thresholdKw,
          reservePct,
          capacityKwh,
          result: simulatePeakShaving(points, {
            ...base,
            strategy: 'shaving',
            battery: { ...base.battery, capacityKwh },
            control: { ...base.control, thresholdKw, reservePct },
          }),
        });
      }
    }
  }
  return cells;
}
