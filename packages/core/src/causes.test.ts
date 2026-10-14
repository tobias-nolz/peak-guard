import { describe, expect, it } from 'vitest';
import { inferCauses, type CauseSample } from './causes.js';

const T0 = Date.parse('2027-01-15T17:00:00Z');
const series = (n: number, f: (i: number) => Partial<CauseSample>): CauseSample[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: T0 + i * 60_000,
    gridW: 0,
    loadW: null,
    pvW: 0,
    batteryW: null,
    socPct: null,
    ...f(i),
  }));

describe('inferCauses', () => {
  it('flags an empty battery during sustained load (EV charging)', () => {
    const r = inferCauses(
      series(15, () => ({ gridW: 11_500, loadW: 11_500, batteryW: 0, socPct: 5 })),
    )!;
    expect(r.causes).toEqual(['battery_empty', 'sustained_load']);
    expect(r.sustainedMinutes).toBeGreaterThan(13);
  });

  it('flags the battery power limit when it discharges at its maximum', () => {
    const r = inferCauses(
      series(15, () => ({ gridW: 6_000, loadW: 12_000, batteryW: 6_000, socPct: 60 })),
      { batteryMaxW: 6_000 },
    )!;
    expect(r.causes).toEqual(['battery_limit', 'sustained_load']);
  });

  it('flags an idle battery that still had charge', () => {
    const r = inferCauses(series(15, () => ({ gridW: 7_000, batteryW: 0, socPct: 70 })))!;
    expect(r.causes[0]).toBe('battery_idle');
  });

  it('flags charging the battery while importing', () => {
    const r = inferCauses(series(15, () => ({ gridW: 4_000, batteryW: -3_000, socPct: 30 })))!;
    expect(r.causes[0]).toBe('battery_charging');
  });

  it('detects a short spike', () => {
    const r = inferCauses(series(15, (i) => ({ gridW: i === 7 ? 20_000 : 1_000 })))!;
    expect(r.causes).toEqual(['short_spike']);
  });

  it('returns null without samples', () => {
    expect(inferCauses([])).toBeNull();
  });
});
