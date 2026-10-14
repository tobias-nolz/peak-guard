import { describe, expect, it } from 'vitest';
import type { ClosedInterval } from '@peak-guard/core';
import { reconcile } from './reconcile.js';

const T0 = Date.parse('2027-01-31T20:00:00Z');
const own = (i: number, kw: number): ClosedInterval => ({
  start: T0 + i * 900_000,
  importWh: kw * 250,
  exportWh: 0,
  avgImportKw: kw,
  avgExportKw: 0,
  completeness: 1,
  quality: 'exact',
  source: 'counter',
  sampleCount: 1,
  maxImportW: null,
  integratedImportWh: 0,
});

describe('reconcile', () => {
  it('pairs quarter-hours and fits the calibration factor', () => {
    const mine = Array.from({ length: 40 }, (_, i) => own(i, 1 + (i % 10)));
    const official = mine.map((o) => ({
      start: o.start,
      importWh: o.importWh! * 1.02,
      status: null,
    }));
    official.push({ start: T0 + 100 * 900_000, importWh: 500, status: null }); // no own data
    const r = reconcile(mine, official, 'Europe/Vienna');
    expect(r.n).toBe(40);
    expect(r.officialOnly).toBe(1);
    expect(r.ratio).toBeCloseTo(1.02, 9);
    expect(r.factorAll).toBeCloseTo(1.02, 9);
    expect(r.suggestedFactor).toBeCloseTo(1.02, 9);
    expect(r.meanAbsDeltaKw).toBeGreaterThan(0);
  });

  it('reports per local month peaks of both meters', () => {
    // T0 = 31 Jan 21:00 local; i = 12 → 1 Feb 00:00 local
    const mine = [own(0, 8), own(11, 3), own(12, 9), own(13, 4)];
    const official = [
      { start: mine[0]!.start, importWh: 2_100, status: null },
      { start: mine[1]!.start, importWh: 700, status: null },
      { start: mine[2]!.start, importWh: 2_200, status: null },
      { start: mine[3]!.start, importWh: 1_100, status: null },
    ];
    const r = reconcile(mine, official, 'Europe/Vienna');
    expect(r.months.map((m) => [m.month, m.ownPeakKw, m.officialPeakKw])).toEqual([
      ['2027-01', 8, 8.4],
      ['2027-02', 9, 8.8],
    ]);
    // two deltas of 0.4 kW tie; the first one is reported
    expect(r.maxDelta).toMatchObject({ ownKw: 8, officialKw: 8.4 });
  });

  it('handles no overlap', () => {
    const r = reconcile([], [{ start: T0, importWh: 1, status: null }], 'Europe/Vienna');
    expect(r).toMatchObject({ n: 0, ratio: null, suggestedFactor: null, maxDelta: null });
  });
});
