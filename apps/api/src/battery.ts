import type { BatteryEnergyRow } from './queries.js';

export interface BatteryUsage {
  chargeKwh: number;
  dischargeKwh: number;
  /** Equivalent full cycles: (charged + discharged) / 2 / usable capacity; null without a capacity. */
  cycles: number | null;
  /** minutes with a battery reading */
  minutes: number;
}

export interface BatterySummary {
  capacityKwh: number | null;
  total: BatteryUsage;
  periods: (BatteryUsage & { period: string })[];
}

function usage(
  chargeWh: number,
  dischargeWh: number,
  minutes: number,
  capacityKwh: number | null,
): BatteryUsage {
  const chargeKwh = chargeWh / 1000;
  const dischargeKwh = dischargeWh / 1000;
  return {
    chargeKwh,
    dischargeKwh,
    cycles: capacityKwh ? (chargeKwh + dischargeKwh) / 2 / capacityKwh : null,
    minutes,
  };
}

/** Battery throughput and equivalent full cycles per period and in total (pure). */
export function summarizeBattery(
  rows: readonly BatteryEnergyRow[],
  capacityKwh: number | null,
): BatterySummary {
  const sum = (k: 'chargeWh' | 'dischargeWh' | 'minutes') => rows.reduce((a, r) => a + r[k], 0);
  return {
    capacityKwh,
    total: usage(sum('chargeWh'), sum('dischargeWh'), sum('minutes'), capacityKwh),
    periods: rows.map((r) => ({
      period: r.period,
      ...usage(r.chargeWh, r.dischargeWh, r.minutes, capacityKwh),
    })),
  };
}
