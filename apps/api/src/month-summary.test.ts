import { describe, expect, it } from 'vitest';
import type { ClosedInterval } from '@peak-guard/core';
import { DEFAULT_SETTINGS } from '@peak-guard/shared';
import { summarizeMonth } from './month-summary.js';

const iv = (
  iso: string,
  kw: number | null,
  quality: ClosedInterval['quality'] = 'exact',
): ClosedInterval => ({
  start: Date.parse(iso),
  importWh: kw == null ? null : kw * 250,
  exportWh: 0,
  avgImportKw: kw,
  avgExportKw: 0,
  completeness: 1,
  quality,
  source: 'counter',
  sampleCount: 450,
  maxImportW: kw == null ? null : kw * 1500,
  integratedImportWh: (kw ?? 0) * 250,
});

describe('summarizeMonth', () => {
  const rows = [
    iv('2027-01-01T17:00:00Z', 4),
    iv('2027-01-01T17:15:00Z', 12.4),
    iv('2027-01-02T06:00:00Z', 7),
    iv('2027-01-02T06:15:00Z', 30, 'missing'),
    iv('2027-01-31T22:45:00Z', 11), // still 31 Jan 23:45 local
  ];

  it('finds the peak, billed power and cost', () => {
    const s = summarizeMonth('2027-01', rows, DEFAULT_SETTINGS, 'Europe/Vienna', 3);
    expect(s.peak?.kw).toBe(12.4);
    expect(s.billedKw).toBe(12.4);
    expect(s.costEur).toBeCloseTo((10 * 19 + 2.4 * 38) / 12, 6);
    expect(s.top.map((t) => t.kw)).toEqual([12.4, 11, 7]);
    expect(s.quality).toEqual({ exact: 4, missing: 1 });
  });

  it('groups daily peaks by local day and ignores missing intervals', () => {
    const s = summarizeMonth('2027-01', rows, DEFAULT_SETTINGS, 'Europe/Vienna');
    expect(s.daily.map((d) => [d.day, d.peakKw])).toEqual([
      ['2027-01-01', 12.4],
      ['2027-01-02', 7],
      ['2027-01-31', 11],
    ]);
  });

  it('applies the calibration factor', () => {
    const s = summarizeMonth(
      '2027-01',
      rows,
      { ...DEFAULT_SETTINGS, calibrationFactor: 0.5 },
      'Europe/Vienna',
    );
    expect(s.peak?.kw).toBe(6.2);
    expect(s.billedKw).toBe(10);
  });
});
