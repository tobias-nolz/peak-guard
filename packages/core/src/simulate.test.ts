import { describe, expect, it } from 'vitest';
import { simulatePeakShaving, sweep, type NetPoint, type SimulationParams } from './simulate.js';

const DAY = Date.parse('2027-01-14T23:00:00Z'); // 15 Jan 00:00 local
const MIN = 60_000;

/** One day at 1-minute resolution: 1 kW base load, EV adds 11 kW from 18:00 to 20:00 local. */
function evDay(): NetPoint[] {
  const pts: NetPoint[] = [];
  for (let m = 0; m < 24 * 60; m++) {
    const ts = DAY + m * MIN;
    const h = m / 60;
    pts.push({ ts, netW: 1_000 + (h >= 18 && h < 20 ? 11_000 : 0) });
  }
  return pts;
}

const base: SimulationParams = {
  strategy: 'selfConsumption',
  battery: { capacityKwh: 10, maxPowerKw: 6, efficiency: 1, minSocPct: 5, initialSocPct: 100 },
  control: { thresholdKw: 10, minBilledKw: 10, adaptive: false, marginKw: 0, reservePct: 60 },
};

describe('simulatePeakShaving', () => {
  it('without a battery the EV evening sets a 12 kW peak', () => {
    const r = simulatePeakShaving(evDay(), { ...base, strategy: 'none' });
    expect(r.peakKw).toBeCloseTo(12, 6);
    expect(r.months[0]!.overTarget).toBe(8);
  });

  it('self-consumption alone empties the battery before the evening', () => {
    const r = simulatePeakShaving(evDay(), base);
    // 9.5 kWh usable covers the 1 kW base load until ~09:30 — nothing left at 18:00
    expect(r.peakKw).toBeCloseTo(12, 6);
    expect(r.months[0]!.minSocPct).toBeCloseTo(5, 6);
  });

  it('a reserve keeps enough energy to shave the evening below the target', () => {
    const r = simulatePeakShaving(evDay(), { ...base, strategy: 'shaving' });
    const m = r.months[0]!;
    expect(r.peakKw).toBeLessThanOrEqual(10 + 1e-6);
    expect(m.overTarget).toBe(0);
    expect(m.shaveIntervals).toBe(8);
    // 2 kW above target for 2 h = 4 kWh from the reserve (efficiency 1)
    expect(m.shaveKwh).toBeCloseTo(4, 1);
    expect(m.minSocPct).toBeGreaterThan(5);
  });

  it('cannot shave more than the reserve holds', () => {
    const r = simulatePeakShaving(evDay(), {
      ...base,
      strategy: 'shaving',
      control: { ...base.control, reservePct: 30 },
    });
    // reserve 30 % → 2.5 kWh usable above 5 %: not enough for 4 kWh
    expect(r.peakKw).toBeGreaterThan(10.5);
    expect(r.months[0]!.overTarget).toBeGreaterThan(0);
  });

  it('skips data gaps instead of integrating across them', () => {
    const pts = evDay().filter((p) => p.ts < DAY + 18 * 60 * MIN || p.ts >= DAY + 19 * 60 * MIN);
    const r = simulatePeakShaving(pts, { ...base, strategy: 'none' });
    // 46 kWh per day minus the missing hour (1 kWh base + 11 kWh EV); the points next to
    // the gap and the last point are not integrated (≈ 2 × 1/60 kWh)
    expect(r.months[0]!.importKwh).toBeCloseTo(46 - 12, 1);
  });

  it('sweeps all combinations', () => {
    const cells = sweep(evDay(), base, {
      thresholdsKw: [10, 11],
      reservesPct: [30, 60],
      capacitiesKwh: [10],
    });
    expect(cells).toHaveLength(4);
    const best = cells.find((c) => c.thresholdKw === 10 && c.reservePct === 60)!;
    expect(best.result.peakKw).toBeLessThanOrEqual(10 + 1e-6);
  });
});
