import { describe, expect, it } from 'vitest';
import type { NetPoint } from '@peak-guard/core';
import { DEFAULT_SETTINGS } from '@peak-guard/shared';
import { runSimulation, toNetPoints } from './simulation.js';

const DAY = Date.parse('2027-01-14T23:00:00Z');

/**
 * Two days: 1 kW base load, 4 kW PV surplus 10:00–15:00 (recharges the battery),
 * 11 kW EV from 18:00 to 20:00 local.
 */
const points: NetPoint[] = Array.from({ length: 2 * 1440 }, (_, m) => {
  const h = (m % 1440) / 60;
  const pv = h >= 10 && h < 15 ? 5_000 : 0;
  return { ts: DAY + m * 60_000, netW: 1_000 - pv + (h >= 18 && h < 20 ? 11_000 : 0) };
});

describe('toNetPoints', () => {
  it('uses load − PV and falls back to grid + battery', () => {
    expect(
      toNetPoints([
        [1, 500, 3_000, 1_000, 1_500, 50],
        [2, 800, null, null, 200, null],
        [3, null, null, null, null, null],
      ]),
    ).toEqual([
      { ts: 1, netW: 2_000 },
      { ts: 2, netW: 1_000 },
    ]);
  });
});

describe('runSimulation', () => {
  const req = {
    from: DAY,
    to: DAY + 2 * 86_400_000,
    battery: { capacityKwh: 10, maxPowerKw: 6, efficiency: 1, minSocPct: 5, initialSocPct: 100 },
    control: { thresholdKw: 10, reservePct: 60, adaptive: false, marginKw: 0 },
  };

  it('compares baselines with the shaving scenario and prices them', async () => {
    const r = await runSimulation(points, req, DEFAULT_SETTINGS, 'Europe/Vienna');
    expect(r.none.peakKw).toBeCloseTo(12, 6);
    expect(r.selfConsumption.peakKw).toBeCloseTo(12, 6);
    expect(r.scenario.peakKw).toBeLessThanOrEqual(10 + 1e-6);
    // 2 kW above 10 kW at 38 €/kW/year saved per month
    expect(r.selfConsumption.avgMonthlyCostEur - r.scenario.avgMonthlyCostEur).toBeCloseTo(
      (2 * 38) / 12,
      6,
    );
  });

  it('sweeps and recommends the cheapest, least invasive combination', async () => {
    const r = await runSimulation(
      points,
      { ...req, sweep: { thresholdsKw: [10, 11], reservesPct: [30, 60, 80], capacitiesKwh: [10] } },
      DEFAULT_SETTINGS,
      'Europe/Vienna',
    );
    expect(r.sweep).toHaveLength(6);
    // PV refills the battery by the evening, so every reserve reaches 10 kW;
    // the smallest reserve (least battery withheld from self-consumption) wins.
    expect(r.best).toMatchObject({ thresholdKw: 10, reservePct: 30 });
    expect(r.best!.avgMonthlySavingEur).toBeCloseTo((2 * 38) / 12, 6);
  });
});
