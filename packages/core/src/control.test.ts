import { describe, expect, it } from 'vitest';
import { decide, effectiveTarget, type ControlConfig, type ControlInputs } from './control.js';

const cfg: ControlConfig = {
  thresholdKw: 10,
  minBilledKw: 10,
  adaptive: false,
  marginKw: 0,
  reservePct: 40,
  minSocPct: 5,
  maxDischargeW: 6_000,
};
const at = (patch: Partial<ControlInputs>): ControlInputs => ({
  elapsedMs: 0,
  importWh: 0,
  gridW: 0,
  batteryW: 0,
  socPct: 30,
  monthPeakKw: null,
  ...patch,
});

describe('decide', () => {
  it('releases the battery above the reserve', () => {
    expect(decide(at({ socPct: 80, gridW: 15_000 }), cfg)).toMatchObject({
      mode: 'release',
      dischargeLimitW: null,
    });
  });

  it('holds the reserve when the interval stays below target', () => {
    expect(decide(at({ gridW: 8_000 }), cfg)).toMatchObject({
      mode: 'hold',
      dischargeLimitW: 0,
      requiredW: 0,
    });
  });

  it('discharges exactly the excess at the start of an interval', () => {
    const d = decide(at({ gridW: 12_000 }), cfg);
    expect(d.mode).toBe('shave');
    expect(d.requiredW).toBeCloseTo(2_000, 6);
    expect(d.dischargeLimitW).toBeCloseTo(2_000, 6);
  });

  it('uses the remaining energy budget (low first half allows more later)', () => {
    // 7.5 min at 6 kW used 750 Wh of the 2500 Wh budget → 1750 Wh for 7.5 min = 14 kW affordable
    expect(decide(at({ elapsedMs: 450_000, importWh: 750, gridW: 13_000 }), cfg).mode).toBe('hold');
    // high first half: 7.5 min at 12 kW used 1500 Wh → 1000 Wh left = 8 kW affordable
    const d = decide(at({ elapsedMs: 450_000, importWh: 1_500, gridW: 12_000 }), cfg);
    expect(d.requiredW).toBeCloseTo(4_000, 6);
  });

  it('counts what the battery already delivers as demand', () => {
    // grid shows 10 kW while the battery already gives 2 kW: demand is 12 kW
    const d = decide(at({ gridW: 10_000, batteryW: 2_000 }), cfg);
    expect(d.dischargeLimitW).toBeCloseTo(2_000, 6);
  });

  it('caps at the battery power and stops at the floor', () => {
    expect(decide(at({ gridW: 20_000 }), cfg).dischargeLimitW).toBe(6_000);
    expect(decide(at({ gridW: 20_000, socPct: 5 }), cfg)).toMatchObject({
      mode: 'empty',
      dischargeLimitW: 0,
    });
  });

  it('applies the margin and the adaptive month peak', () => {
    expect(decide(at({ gridW: 10_000 }), { ...cfg, marginKw: 0.5 }).requiredW).toBeCloseTo(500, 6);
    expect(effectiveTarget({ ...cfg, adaptive: true }, 13)).toBe(13);
    expect(effectiveTarget({ ...cfg, adaptive: false }, 13)).toBe(10);
    expect(decide(at({ gridW: 12_000, monthPeakKw: 13 }), { ...cfg, adaptive: true }).mode).toBe(
      'hold',
    );
    expect(effectiveTarget({ ...cfg, thresholdKw: 7 }, null)).toBe(10); // never below min billed
  });
});
