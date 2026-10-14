import { describe, expect, it } from 'vitest';
import { INTERVAL_MS, type LiveInterval } from '@peak-guard/core';
import { DEFAULT_SETTINGS } from '@peak-guard/shared';
import { PowerSmoother, buildSnapshot } from './snapshot.js';

const T0 = Date.parse('2027-01-15T17:00:00Z');

function live(committedKw: number, elapsedMin: number): LiveInterval {
  const elapsedMs = elapsedMin * 60_000;
  return {
    start: T0,
    end: T0 + INTERVAL_MS,
    elapsedMs,
    remainingMs: INTERVAL_MS - elapsedMs,
    importWh: committedKw * 250,
    runningAvgKw: (committedKw * 250) / 1000 / (elapsedMs / 3_600_000),
    projectedKw: 0,
    committedKw,
    completeness: 1,
    source: 'counter',
  };
}

const base = {
  now: T0 + 10 * 60_000,
  connection: 'ok' as const,
  gridW: 9_000,
  flow: null,
  monthPeak: null,
  settings: DEFAULT_SETTINGS,
  timeZone: 'Europe/Vienna',
};

describe('buildSnapshot', () => {
  it('projects with the smoothed power over the remaining time', () => {
    const s = buildSnapshot({ ...base, live: live(6, 10), smoothedImportW: 9_000 });
    // 6 kW committed + 9 kW × 5/15
    expect(s.interval.projectedKw).toBeCloseTo(9, 6);
    expect(s.state).toBe('safe');
    expect(s.effectiveLimitKw).toBe(10);
  });

  it('turns warning and over relative to the higher of limit and month peak', () => {
    expect(buildSnapshot({ ...base, live: live(6, 10), smoothedImportW: 10_000 }).state).toBe(
      'warning',
    );
    expect(buildSnapshot({ ...base, live: live(8, 10), smoothedImportW: 12_000 }).state).toBe(
      'over',
    );
    // with a month peak of 13 kW, 12 kW projected costs nothing extra
    const s = buildSnapshot({
      ...base,
      live: live(8, 10),
      smoothedImportW: 12_000,
      monthPeak: { start: T0 - 1e6, kw: 13 },
    });
    expect(s.state).toBe('warning');
    expect(s.projectedExtraCostEur).toBe(0);
  });

  it('prices the projected excess above the month peak', () => {
    const s = buildSnapshot({
      ...base,
      live: live(10, 10),
      smoothedImportW: 12_000,
      monthPeak: { start: T0 - 1e6, kw: 11 },
    });
    // projected 14 kW vs peak 11 kW, 3 kW above 10 kW at 38 €/kW/year
    expect(s.projectedExtraCostEur).toBeCloseTo((3 * 38) / 12, 6);
  });

  it('applies the calibration factor', () => {
    const settings = { ...DEFAULT_SETTINGS, calibrationFactor: 1.02 };
    const s = buildSnapshot({
      ...base,
      settings,
      live: live(5, 10),
      smoothedImportW: 0,
      monthPeak: { start: 0, kw: 10 },
    });
    expect(s.interval.committedKw).toBeCloseTo(5.1, 6);
    expect(s.monthPeak?.kw).toBeCloseTo(10.2, 6);
  });
});

describe('PowerSmoother', () => {
  it('averages over the window and ignores export', () => {
    const p = new PowerSmoother(10_000);
    p.push(0, 1_000);
    p.push(5_000, 1_000);
    p.push(10_000, 3_000);
    expect(p.value()).toBeCloseTo(1_500, 6);
    p.push(20_000, -5_000);
    // window now holds 3 kW → 0 kW (export clipped): trapezoid average
    expect(p.value()).toBeCloseTo(1_500, 6);
  });

  it('returns the last value with a zero window', () => {
    const p = new PowerSmoother(0);
    p.push(0, 1_000);
    p.push(1_000, 4_000);
    expect(p.value()).toBe(4_000);
  });
});
