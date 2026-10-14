import { describe, expect, it } from 'vitest';
import { durationCurve, heatmap, histogram, percentile } from './analytics.js';

describe('heatmap', () => {
  it('buckets by local weekday and hour (Europe/Vienna)', () => {
    // Monday 2027-01-18 07:15 local = 06:15Z; Sunday 2027-01-17 23:45 local = 22:45Z
    const cells = heatmap([
      { start: Date.parse('2027-01-18T06:15:00Z'), kw: 4 },
      { start: Date.parse('2027-01-18T06:30:00Z'), kw: 9 },
      { start: Date.parse('2027-01-17T22:45:00Z'), kw: 2 },
    ]);
    expect(cells).toHaveLength(168);
    const mon7 = cells.find((c) => c.weekday === 0 && c.hour === 7)!;
    expect(mon7).toMatchObject({ value: 9, count: 2 });
    expect(cells.find((c) => c.weekday === 6 && c.hour === 23)!.value).toBe(2);
    expect(cells.filter((c) => c.value != null)).toHaveLength(2);
  });

  it('can average instead of max', () => {
    const cells = heatmap(
      [
        { start: Date.parse('2027-01-18T06:15:00Z'), kw: 4 },
        { start: Date.parse('2027-01-18T06:30:00Z'), kw: 9 },
      ],
      'avg',
    );
    expect(cells.find((c) => c.count === 2)!.value).toBe(6.5);
  });
});

describe('histogram', () => {
  it('uses fixed bins from 0', () => {
    expect(histogram([0, 0.2, 0.5, 1.4, 1.5], 0.5)).toEqual([
      { fromKw: 0, toKw: 0.5, count: 2 },
      { fromKw: 0.5, toKw: 1, count: 1 },
      { fromKw: 1, toKw: 1.5, count: 1 },
      { fromKw: 1.5, toKw: 2, count: 1 },
    ]);
    expect(histogram([])).toEqual([]);
  });
});

describe('durationCurve', () => {
  it('sorts descending against share of time', () => {
    expect(durationCurve([1, 3, 2, 4])).toEqual([
      { pct: 25, kw: 4 },
      { pct: 50, kw: 3 },
      { pct: 75, kw: 2 },
      { pct: 100, kw: 1 },
    ]);
  });

  it('downsamples but keeps the maximum and the 100 % end', () => {
    const values = Array.from({ length: 3000 }, (_, i) => i / 100);
    const c = durationCurve(values, 100);
    expect(c.length).toBeLessThanOrEqual(101);
    expect(c[0]!.kw).toBe(29.99);
    expect(c.at(-1)).toEqual({ pct: 100, kw: 0 });
  });
});

describe('percentile', () => {
  it('interpolates', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([5], 99)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});
