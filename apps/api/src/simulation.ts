import { z } from 'zod';
import {
  monthlyCost,
  simulatePeakShaving,
  tariffFor,
  type NetPoint,
  type SimResult,
  type SimulationParams,
} from '@peak-guard/core';
import type { Settings } from '@peak-guard/shared';
import type { SeriesPoint } from './queries.js';

export const simulationRequestSchema = z.object({
  from: z.number(),
  to: z.number(),
  battery: z.object({
    capacityKwh: z.number().min(0).max(200),
    maxPowerKw: z.number().min(0).max(100),
    efficiency: z.number().min(0.5).max(1).default(0.95),
    minSocPct: z.number().min(0).max(50).default(5),
    initialSocPct: z.number().min(0).max(100).default(50),
  }),
  control: z.object({
    thresholdKw: z.number().min(0).max(1000),
    reservePct: z.number().min(0).max(100),
    adaptive: z.boolean().default(true),
    marginKw: z.number().min(0).max(5).default(0.2),
  }),
  sweep: z
    .object({
      thresholdsKw: z.array(z.number().min(0).max(1000)).min(1).max(8),
      reservesPct: z.array(z.number().min(0).max(100)).min(1).max(8),
      capacitiesKwh: z.array(z.number().min(0).max(200)).min(1).max(4),
    })
    .optional(),
});

export type SimulationRequest = z.infer<typeof simulationRequestSchema>;

/** Net demand (load − PV) from the power series; falls back to grid + battery. */
export function toNetPoints(points: readonly SeriesPoint[]): NetPoint[] {
  const out: NetPoint[] = [];
  for (const [ts, grid, load, pv, bat] of points) {
    const net = load != null && pv != null ? load - pv : grid != null ? grid + (bat ?? 0) : null;
    if (net != null) out.push({ ts, netW: net });
  }
  return out;
}

export interface CostedMonth {
  month: string;
  peakKw: number;
  peakStart: number | null;
  costEur: number;
  shaveKwh: number;
  dischargeKwh: number;
  shaveIntervals: number;
  overTarget: number;
  minSocPct: number;
}

export interface CostedResult {
  peakKw: number;
  totalCostEur: number;
  avgMonthlyCostEur: number;
  shaveKwh: number;
  overTarget: number;
  months: CostedMonth[];
}

/** Apply calibration and the tariff to a simulation result. */
export function costResult(r: SimResult, settings: Settings): CostedResult {
  const cal = settings.calibrationFactor;
  const months = r.months.map((m) => {
    const kw = m.peakKw * cal;
    return {
      month: m.month,
      peakKw: kw,
      peakStart: m.peakStart,
      costEur: monthlyCost(kw, tariffFor(`${m.month}-01`, settings.tariffs)),
      shaveKwh: m.shaveKwh,
      dischargeKwh: m.dischargeKwh,
      shaveIntervals: m.shaveIntervals,
      overTarget: m.overTarget,
      minSocPct: m.minSocPct,
    };
  });
  const total = months.reduce((s, m) => s + m.costEur, 0);
  return {
    peakKw: r.peakKw * cal,
    totalCostEur: total,
    avgMonthlyCostEur: months.length ? total / months.length : 0,
    shaveKwh: months.reduce((s, m) => s + m.shaveKwh, 0),
    overTarget: months.reduce((s, m) => s + m.overTarget, 0),
    months,
  };
}

export interface SweepRow {
  thresholdKw: number;
  reservePct: number;
  capacityKwh: number;
  peakKw: number;
  avgMonthlyCostEur: number;
  /** vs. today's self-consumption with the same battery capacity */
  avgMonthlySavingEur: number;
  shaveKwh: number;
  overTarget: number;
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** Run baselines, the requested scenario and an optional sweep (yields between runs). */
export async function runSimulation(
  points: readonly NetPoint[],
  req: SimulationRequest,
  settings: Settings,
  timeZone: string,
) {
  const minBilledKw = tariffFor(
    new Date(req.from).toISOString().slice(0, 10),
    settings.tariffs,
  ).minBilledKw;
  const base: SimulationParams = {
    strategy: 'shaving',
    battery: req.battery,
    control: { ...req.control, minBilledKw },
    timeZone,
  };
  const run = async (p: SimulationParams) => {
    await yieldToLoop();
    return costResult(simulatePeakShaving(points, p), settings);
  };

  const none = await run({ ...base, strategy: 'none' });
  const selfConsumption = await run({ ...base, strategy: 'selfConsumption' });
  const scenario = await run(base);

  let sweep: SweepRow[] | undefined;
  let best: SweepRow | undefined;
  if (req.sweep) {
    sweep = [];
    const selfByCapacity = new Map<number, CostedResult>();
    for (const capacityKwh of req.sweep.capacitiesKwh) {
      const battery = { ...req.battery, capacityKwh };
      selfByCapacity.set(capacityKwh, await run({ ...base, strategy: 'selfConsumption', battery }));
      for (const thresholdKw of req.sweep.thresholdsKw) {
        for (const reservePct of req.sweep.reservesPct) {
          const r = await run({
            ...base,
            battery,
            control: { ...base.control, thresholdKw, reservePct },
          });
          sweep.push({
            thresholdKw,
            reservePct,
            capacityKwh,
            peakKw: r.peakKw,
            avgMonthlyCostEur: r.avgMonthlyCostEur,
            avgMonthlySavingEur:
              selfByCapacity.get(capacityKwh)!.avgMonthlyCostEur - r.avgMonthlyCostEur,
            shaveKwh: r.shaveKwh,
            overTarget: r.overTarget,
          });
        }
      }
    }
    // Best saving; among (near-)equal savings prefer the smaller reserve, then the higher threshold.
    best = [...sweep].sort((a, b) =>
      b.avgMonthlySavingEur - a.avgMonthlySavingEur > 0.005
        ? 1
        : a.avgMonthlySavingEur - b.avgMonthlySavingEur > 0.005
          ? -1
          : a.reservePct - b.reservePct || b.thresholdKw - a.thresholdKw,
    )[0];
  }

  return { points: points.length, none, selfConsumption, scenario, sweep, best };
}
