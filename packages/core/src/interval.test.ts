import { describe, expect, it } from 'vitest';
import { IntervalTracker, intervalsFromSamples, type GridSample } from './interval.js';
import { INTERVAL_MS } from './time.js';

const T0 = Date.parse('2027-01-15T10:00:00Z');
const MIN = 60_000;

/**
 * Generate samples every `stepMs` from `from` to `to` (inclusive) for a power profile,
 * with cumulative counters that are consistent with that profile.
 */
function generate(
  from: number,
  to: number,
  stepMs: number,
  powerW: (ts: number) => number,
  counters = { importWh: 1_000_000, exportWh: 500_000 },
): GridSample[] {
  const out: GridSample[] = [];
  let { importWh, exportWh } = counters;
  let prev: { ts: number; p: number } | null = null;
  for (let ts = from; ts <= to; ts += stepMs) {
    const p = powerW(ts);
    if (prev) {
      const h = (ts - prev.ts) / 3_600_000;
      importWh += ((Math.max(0, prev.p) + Math.max(0, p)) / 2) * h;
      exportWh += ((Math.max(0, -prev.p) + Math.max(0, -p)) / 2) * h;
    }
    out.push({ ts, gridPowerW: p, importWh, exportWh });
    prev = { ts, p };
  }
  return out;
}

describe('IntervalTracker – counters', () => {
  it('computes exact energy and average kW for constant import', () => {
    const samples = generate(T0 - 5_000, T0 + 2 * INTERVAL_MS + 5_000, 1_000, () => 8_000);
    const closed = intervalsFromSamples(samples);
    // first (partial) interval + 2 full ones
    const full = closed.filter((c) => c.start >= T0);
    expect(full).toHaveLength(2);
    for (const c of full) {
      expect(c.quality).toBe('exact');
      expect(c.source).toBe('counter');
      expect(c.importWh).toBeCloseTo(2_000, 6);
      expect(c.avgImportKw).toBeCloseTo(8, 6);
      expect(c.exportWh).toBeCloseTo(0, 6);
      expect(c.completeness).toBeCloseTo(1, 6);
    }
  });

  it('marks the first interval after start as partial', () => {
    const samples = generate(T0 + 5 * MIN, T0 + INTERVAL_MS + 1_000, 1_000, () => 4_000);
    const [first] = intervalsFromSamples(samples);
    expect(first?.start).toBe(T0);
    expect(first?.quality).toBe('partial');
    expect(first?.source).toBe('integrated');
    // extrapolated from the observed 10 minutes at 4 kW
    expect(first?.avgImportKw).toBeCloseTo(4, 3);
  });

  it('interpolates counters exactly at the boundary between sparse samples', () => {
    // samples every 7 s, never on the boundary; a step from 2 kW to 10 kW at T0+15min
    const step = (ts: number) => (ts < T0 + INTERVAL_MS ? 2_000 : 10_000);
    const samples = generate(T0 - 3_000, T0 + 2 * INTERVAL_MS + 7_000, 7_000, step);
    const closed = intervalsFromSamples(samples).filter((c) => c.start >= T0);
    expect(closed[0]!.avgImportKw).toBeCloseTo(2, 1);
    expect(closed[1]!.avgImportKw).toBeCloseTo(10, 1);
    // 0.5 kWh + 2.5 kWh; the only error is the linear ramp across the 7 s around the step
    const total = closed.reduce((s, c) => s + (c.importWh ?? 0), 0);
    expect(Math.abs(total - 3_000)).toBeLessThan(10);
  });

  it('separates import and export (netting only within an instant, not across)', () => {
    // 10 min importing 6 kW, 5 min exporting 3 kW
    const p = (ts: number) => ((ts - T0) % INTERVAL_MS < 10 * MIN ? 6_000 : -3_000);
    const samples = generate(T0 - 1_000, T0 + INTERVAL_MS + 1_000, 1_000, p);
    const c = intervalsFromSamples(samples).find((i) => i.start === T0)!;
    expect(c.importWh).toBeCloseTo(1_000, -1);
    expect(c.exportWh).toBeCloseTo(250, -1);
    expect(c.avgImportKw).toBeCloseTo(4, 1);
  });

  it('keeps exact energy for a gap inside an interval but lowers completeness', () => {
    const all = generate(T0 - 1_000, T0 + INTERVAL_MS + 1_000, 1_000, () => 5_000);
    const samples = all.filter((s) => s.ts < T0 + 3 * MIN || s.ts > T0 + 9 * MIN);
    const c = intervalsFromSamples(samples).find((i) => i.start === T0)!;
    expect(c.quality).toBe('exact');
    expect(c.importWh).toBeCloseTo(1_250, 3);
    expect(c.completeness).toBeCloseTo(9 / 15, 2);
  });

  it('backfills intervals across an outage from the counters', () => {
    const all = generate(T0 - 1_000, T0 + 3 * INTERVAL_MS + 1_000, 1_000, () => 6_000);
    // outage from T0+10min to T0+40min (crosses two boundaries)
    const samples = all.filter((s) => s.ts < T0 + 10 * MIN || s.ts > T0 + 40 * MIN);
    const closed = intervalsFromSamples(samples).filter((c) => c.start >= T0);
    expect(closed.map((c) => c.start)).toEqual([T0, T0 + INTERVAL_MS, T0 + 2 * INTERVAL_MS]);
    expect(closed.map((c) => c.quality)).toEqual(['estimated', 'estimated', 'estimated']);
    expect(closed[1]!.completeness).toBe(0);
    for (const c of closed) expect(c.avgImportKw).toBeCloseTo(6, 3);
  });

  it('emits missing intervals for outages longer than maxBackfillMs', () => {
    const before = generate(T0 - 1_000, T0 + 5 * MIN, 1_000, () => 3_000);
    const after = generate(
      T0 + 3 * 3_600_000,
      T0 + 3 * 3_600_000 + 2 * INTERVAL_MS,
      1_000,
      () => 3_000,
      {
        importWh: before.at(-1)!.importWh! + 9_000,
        exportWh: before.at(-1)!.exportWh!,
      },
    );
    const closed = intervalsFromSamples([...before, ...after], { maxBackfillMs: 3_600_000 });
    const gapIntervals = closed.filter((c) => c.start > T0 && c.start < T0 + 3 * 3_600_000);
    expect(gapIntervals.length).toBe(11);
    expect(gapIntervals.every((c) => c.quality === 'missing' && c.importWh === null)).toBe(true);
  });

  it('falls back to integration when the counter resets', () => {
    const samples = generate(T0 - 1_000, T0 + INTERVAL_MS + 1_000, 1_000, () => 4_000);
    // meter replaced at T0+5min: counters restart near zero
    const offset = samples.find((s) => s.ts === T0 + 5 * MIN)!.importWh!;
    const patched = samples.map((s) =>
      s.ts >= T0 + 5 * MIN ? { ...s, importWh: s.importWh! - offset, exportWh: 0 } : s,
    );
    const c = intervalsFromSamples(patched).find((i) => i.start === T0)!;
    expect(c.source).toBe('integrated');
    expect(c.importWh).toBeCloseTo(1_000, 3);
  });

  it('ignores duplicate and out-of-order samples', () => {
    const samples = generate(T0 - 1_000, T0 + INTERVAL_MS + 1_000, 1_000, () => 4_000);
    const noisy = samples.flatMap((s, i) =>
      i % 10 === 0 ? [s, s, samples[Math.max(0, i - 3)]!] : [s],
    );
    const c = intervalsFromSamples(noisy).find((i) => i.start === T0)!;
    expect(c.importWh).toBeCloseTo(1_000, 6);
  });
});

describe('IntervalTracker – integration fallback (no counters)', () => {
  it('integrates power when the meter provides no counters', () => {
    const samples = generate(T0 - 1_000, T0 + INTERVAL_MS + 1_000, 2_000, () => 12_000).map(
      (s) => ({
        ...s,
        importWh: null,
        exportWh: null,
      }),
    );
    const c = intervalsFromSamples(samples).find((i) => i.start === T0)!;
    expect(c.source).toBe('integrated');
    expect(c.quality).toBe('exact');
    expect(c.avgImportKw).toBeCloseTo(12, 6);
  });
});

describe('IntervalTracker – live status', () => {
  it('projects the end-of-interval average from energy so far plus current power', () => {
    // 5 min at 4 kW, then 12 kW
    const p = (ts: number) => (ts < T0 + 5 * MIN ? 4_000 : 12_000);
    const t = new IntervalTracker();
    for (const s of generate(T0 - 2_000, T0 + 6 * MIN, 1_000, p)) t.push(s);
    const live = t.live(T0 + 6 * MIN)!;
    expect(live.start).toBe(T0);
    expect(live.elapsedMs).toBe(6 * MIN);
    expect(live.remainingMs).toBe(9 * MIN);
    const energyKwh = (4 * 5 + 12 * 1) / 60; // ≈0.5333
    expect(live.importWh / 1000).toBeCloseTo(energyKwh, 2);
    expect(live.runningAvgKw).toBeCloseTo(energyKwh / 0.1, 1);
    expect(live.committedKw).toBeCloseTo(energyKwh / 0.25, 2);
    expect(live.projectedKw).toBeCloseTo((energyKwh + 12 * (9 / 60)) / 0.25, 2);
    expect(live.source).toBe('counter');
  });

  it('holds the last power until now for short sample delays', () => {
    const t = new IntervalTracker();
    for (const s of generate(T0 - 1_000, T0 + 60_000, 1_000, () => 6_000)) t.push(s);
    const a = t.live(T0 + 60_000)!;
    const b = t.live(T0 + 65_000)!;
    expect(b.importWh - a.importWh).toBeCloseTo((6_000 * 5) / 3_600, 6);
    expect(b.projectedKw).toBeCloseTo(a.projectedKw, 6);
  });
});

describe('IntervalTracker – DST', () => {
  it('produces contiguous 15-min intervals through the fall-back night', () => {
    const from = Date.parse('2026-10-24T22:00:00Z'); // 00:00 CEST
    const to = Date.parse('2026-10-25T04:00:00Z'); // 05:00 CET
    const closed = intervalsFromSamples(generate(from - 5_000, to + 5_000, 5_000, () => 1_000));
    const full = closed.filter((c) => c.start >= from && c.start < to);
    expect(full).toHaveLength(24); // 6 real hours
    for (let i = 1; i < full.length; i++)
      expect(full[i]!.start - full[i - 1]!.start).toBe(INTERVAL_MS);
  });
});
