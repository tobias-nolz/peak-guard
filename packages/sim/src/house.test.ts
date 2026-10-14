import { describe, expect, it } from 'vitest';
import { HOUR_MS, intervalsFromSamples, peakOf, billable } from '@peak-guard/core';
import { House } from './house.js';

const DAY = Date.parse('2027-01-14T23:00:00Z'); // 2027-01-15 00:00 Vienna

describe('House simulation', () => {
  it('conserves energy at the meter and keeps SoC in range', () => {
    const h = new House(DAY);
    const start = { ...h.current };
    let gridWh = 0;
    for (let ts = DAY + 1_000; ts <= DAY + 24 * HOUR_MS; ts += 1_000) {
      const s = h.advanceTo(ts);
      gridWh += s.gridW / 3_600;
      expect(s.socPct).toBeGreaterThanOrEqual(0);
      expect(s.socPct).toBeLessThanOrEqual(100);
    }
    const end = h.current;
    expect(end.importWh - start.importWh - (end.exportWh - start.exportWh)).toBeCloseTo(gridWh, 0);
  });

  it('is deterministic for a given seed', () => {
    const a = new House(DAY).advanceTo(DAY + 6 * HOUR_MS);
    const b = new House(DAY).advanceTo(DAY + 6 * HOUR_MS);
    expect(a).toEqual(b);
  });

  it('produces 15-min peaks above 10 kW on an EV evening without a battery', () => {
    // find a day with an EV session
    for (let d = 0; d < 20; d++) {
      const start = DAY + d * 24 * HOUR_MS;
      const h = new House(start, { batteryWh: 0, pvPeakW: 0 });
      const samples = [];
      for (let ts = start; ts <= start + 24 * HOUR_MS; ts += 5_000) {
        const s = h.advanceTo(ts);
        samples.push({ ts, gridPowerW: s.gridW, importWh: s.importWh, exportWh: s.exportWh });
      }
      const peak = peakOf(billable(intervalsFromSamples(samples)));
      if (peak && peak.avgImportKw > 10) return;
    }
    throw new Error('no day with a peak > 10 kW in 20 days');
  });

  it('honours a discharge limit (StorCtl_Mod bit1, OutWRte)', () => {
    const h = new House(DAY + 18 * HOUR_MS, {}, { socPct: 80 });
    h.writeControl({ storCtlMod: 2, outWRtePct: 25 }, h.current.ts);
    for (let i = 1; i <= 600; i++) {
      const s = h.advanceTo(DAY + 18 * HOUR_MS + i * 1_000);
      expect(s.batteryW).toBeLessThanOrEqual(0.25 * h.config.batteryMaxW + 1e-9);
    }
  });

  it('reverts control after the revert timeout when supported, not otherwise', () => {
    for (const revertSupported of [true, false]) {
      const t0 = DAY + 18 * HOUR_MS;
      const h = new House(t0, { revertSupported });
      h.writeControl({ storCtlMod: 2, outWRtePct: 0, revertS: 60 }, t0);
      h.advanceTo(t0 + 61_000);
      expect(h.control.storCtlMod).toBe(revertSupported ? 0 : 2);
    }
  });
});
