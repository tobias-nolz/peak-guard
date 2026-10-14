import { describe, expect, it } from 'vitest';
import type { ClosedInterval } from '@peak-guard/core';
import { DEFAULT_SETTINGS } from '@peak-guard/shared';
import { analyzeRange } from './analysis.js';
import { toCsv } from './csv.js';
import { monthRange, summarizeYear } from './month-summary.js';

const iv = (iso: string, kw: number): ClosedInterval => ({
  start: Date.parse(iso),
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

describe('summarizeYear', () => {
  it('assigns intervals to local months and sums costs', () => {
    const rows = [
      iv('2027-01-31T22:45:00Z', 12),
      iv('2027-01-31T23:00:00Z', 11),
      iv('2027-03-10T12:00:00Z', 4),
    ];
    const y = summarizeYear(2027, rows, DEFAULT_SETTINGS, 'Europe/Vienna');
    expect(y.months.map((m) => m.peakKw)).toEqual([
      12,
      11,
      4,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(y.months[2]!.billedKw).toBe(10);
    expect(y.totalCostEur).toBeCloseTo((190 + 76) / 12 + (190 + 38) / 12 + 190 / 12, 6);
  });
});

describe('analyzeRange', () => {
  it('computes percentiles and counts above the limit (with calibration)', () => {
    const rows = [
      iv('2027-01-04T10:00:00Z', 5),
      iv('2027-01-04T10:15:00Z', 9.9),
      iv('2027-01-04T10:30:00Z', 10),
    ];
    const a = analyzeRange(rows, { ...DEFAULT_SETTINGS, calibrationFactor: 1.02 }, 'Europe/Vienna');
    expect(a.count).toBe(3);
    expect(a.maxKw).toBeCloseTo(10.2, 6);
    expect(a.aboveLimit).toBe(2);
    expect(a.histogram.reduce((s, b) => s + b.count, 0)).toBe(3);
  });
});

describe('monthRange', () => {
  it('uses local month boundaries', () => {
    expect(monthRange('2027-03', 'Europe/Vienna')).toEqual({
      from: Date.parse('2027-02-28T23:00:00Z'),
      to: Date.parse('2027-03-31T22:00:00Z'),
    });
  });
});

describe('toCsv', () => {
  it('quotes when needed and leaves nulls empty', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', null],
          ['say "hi"', 1.5],
        ],
      ),
    ).toBe('a,b\r\n"x,y",\r\n"say ""hi""",1.5\r\n');
  });
});
