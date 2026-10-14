import { INTERVAL_HOURS, INTERVAL_MS, intervalStart } from './time.js';

/**
 * One reading of the grid connection point.
 *
 * `gridPowerW` is signed: positive = import from the grid, negative = export.
 * `importWh` / `exportWh` are the meter's cumulative energy counters (monotonic). They are
 * the source of truth for interval energy; power integration is only a fallback.
 */
export interface GridSample {
  ts: number;
  gridPowerW: number;
  importWh: number | null;
  exportWh: number | null;
}

export type IntervalQuality =
  /** Both boundary counter values interpolated from samples close to the boundary. */
  | 'exact'
  /** Energy derived across a gap (counter spread or power extrapolation). */
  | 'estimated'
  /** Interval only partly observed (e.g. first interval after start without history). */
  | 'partial'
  /** No usable data. */
  | 'missing';

export type IntervalSource = 'counter' | 'integrated' | 'none';

export interface ClosedInterval {
  /** Inclusive start, epoch ms, aligned to :00/:15/:30/:45. */
  start: number;
  importWh: number | null;
  exportWh: number | null;
  /** Average import power over the full quarter-hour in kW (billing value). */
  avgImportKw: number | null;
  avgExportKw: number | null;
  /** Fraction (0..1) of the interval covered by samples spaced no more than `maxGapMs`. */
  completeness: number;
  quality: IntervalQuality;
  source: IntervalSource;
  sampleCount: number;
  /** Highest instantaneous import power seen in the interval (W), null if no samples. */
  maxImportW: number | null;
  /** Power-integrated import energy over covered time, for diagnostics. */
  integratedImportWh: number;
}

export interface IntervalTrackerOptions {
  /** Max spacing between samples that still counts as continuous coverage. */
  maxGapMs: number;
  /**
   * Gaps up to this length are backfilled from the cumulative counters (energy spread
   * linearly over the gap). Longer gaps produce `missing` intervals.
   */
  maxBackfillMs: number;
  /**
   * Counter increases implying a higher average power than this are treated as a counter
   * discontinuity (meter swap/reset, replaced device), not as consumption.
   */
  maxPlausibleW: number;
}

export const DEFAULT_TRACKER_OPTIONS: IntervalTrackerOptions = {
  maxGapMs: 30_000,
  maxBackfillMs: 48 * 3_600_000,
  maxPlausibleW: 100_000,
};

interface BoundaryValue {
  importWh: number | null;
  exportWh: number | null;
  /** True if interpolated between samples no more than maxGapMs apart. */
  exact: boolean;
}

interface OpenInterval {
  start: number;
  /** Counter values at the interval start; null when unknown (first interval). */
  startCounters: BoundaryValue | null;
  integratedImportWh: number;
  integratedExportWh: number;
  coveredMs: number;
  sampleCount: number;
  maxImportW: number | null;
  /** Set when a counter reset/decrease or a long gap broke counter continuity. */
  counterBroken: boolean;
  /** True if part of this interval lies inside a backfilled gap. */
  backfilled: boolean;
}

export interface LiveInterval {
  start: number;
  end: number;
  elapsedMs: number;
  remainingMs: number;
  /** Import energy so far in this interval (Wh). */
  importWh: number;
  /** importWh / elapsed time, kW. */
  runningAvgKw: number;
  /** Energy so far plus current import held for the remaining time, as average kW. */
  projectedKw: number;
  /** Energy so far as average over the full interval (kW) — the floor for the final value. */
  committedKw: number;
  completeness: number;
  source: IntervalSource;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const imp = (p: number) => Math.max(0, p);
const exp = (p: number) => Math.max(0, -p);

/**
 * Turns a stream of grid samples into clock-aligned quarter-hour energies.
 *
 * Pure and deterministic: no clock access, no I/O. Feed samples in time order via
 * {@link push}; each call returns the intervals that were closed by that sample.
 */
export class IntervalTracker {
  private readonly opts: IntervalTrackerOptions;
  private prev: GridSample | null = null;
  private open: OpenInterval | null = null;

  constructor(options: Partial<IntervalTrackerOptions> = {}) {
    this.opts = { ...DEFAULT_TRACKER_OPTIONS, ...options };
  }

  /** Last accepted sample. */
  get lastSample(): GridSample | null {
    return this.prev;
  }

  push(sample: GridSample): ClosedInterval[] {
    const p = this.prev;
    if (!p) {
      this.prev = sample;
      this.open = this.newInterval(intervalStart(sample.ts), null, false);
      this.open.sampleCount = 1;
      this.open.maxImportW = imp(sample.gridPowerW);
      return [];
    }
    if (sample.ts <= p.ts) return []; // duplicate or out-of-order

    const closed: ClosedInterval[] = [];
    const dt = sample.ts - p.ts;
    const continuous = dt <= this.opts.maxGapMs;
    const backfillable = dt <= this.opts.maxBackfillMs;
    const countersOk =
      hasCounters(p) &&
      hasCounters(sample) &&
      countersMonotonic(p, sample) &&
      countersPlausible(p, sample, this.opts.maxPlausibleW);

    let segStart = p.ts;
    while (segStart < sample.ts) {
      const open = this.open!;
      const boundary = open.start + INTERVAL_MS;
      const segEnd = Math.min(boundary, sample.ts);

      if (continuous) {
        const f0 = (segStart - p.ts) / dt;
        const f1 = (segEnd - p.ts) / dt;
        const p0 = lerp(p.gridPowerW, sample.gridPowerW, f0);
        const p1 = lerp(p.gridPowerW, sample.gridPowerW, f1);
        const hours = (segEnd - segStart) / 3_600_000;
        open.integratedImportWh += ((imp(p0) + imp(p1)) / 2) * hours;
        open.integratedExportWh += ((exp(p0) + exp(p1)) / 2) * hours;
        open.coveredMs += segEnd - segStart;
      } else {
        open.backfilled = true;
        if (!countersOk || !backfillable) open.counterBroken = true;
      }
      if (!countersOk) open.counterBroken = true;

      if (segEnd === boundary) {
        // Close the interval at the boundary.
        let atBoundary: BoundaryValue | null = null;
        if (countersOk && (continuous || backfillable)) {
          const f = (boundary - p.ts) / dt;
          atBoundary = {
            importWh: lerp(p.importWh!, sample.importWh!, f),
            exportWh: lerp(p.exportWh!, sample.exportWh!, f),
            exact: continuous,
          };
        }
        closed.push(this.close(open, atBoundary));
        this.open = this.newInterval(boundary, atBoundary, !continuous);
      }
      segStart = segEnd;
    }

    const cur = this.open!;
    cur.sampleCount += 1;
    cur.maxImportW = Math.max(cur.maxImportW ?? 0, imp(sample.gridPowerW));
    this.prev = sample;
    return closed;
  }

  /** Live status of the open interval at `now` (>= last sample time). */
  live(now: number): LiveInterval | null {
    const p = this.prev;
    const open = this.open;
    if (!p || !open) return null;
    const start = open.start;
    const end = start + INTERVAL_MS;
    const t = Math.min(Math.max(now, p.ts), end);
    const elapsedMs = Math.max(0, t - start);
    const remainingMs = end - t;

    // Energy so far: counter difference when the interval start is known, else integration.
    let importWh: number;
    let source: IntervalSource;
    if (open.startCounters?.importWh != null && p.importWh != null && !open.counterBroken) {
      importWh = Math.max(0, p.importWh - open.startCounters.importWh);
      source = 'counter';
    } else {
      importWh = open.integratedImportWh;
      source = 'integrated';
    }
    // Hold the last power from the last sample until `now`.
    const holdMs = t - p.ts;
    if (holdMs > 0 && holdMs <= this.opts.maxGapMs) {
      importWh += imp(p.gridPowerW) * (holdMs / 3_600_000);
    }
    const currentKw = imp(p.gridPowerW) / 1000;
    const runningAvgKw = elapsedMs > 0 ? importWh / 1000 / (elapsedMs / 3_600_000) : currentKw;
    const committedKw = importWh / 1000 / INTERVAL_HOURS;
    const projectedKw = committedKw + currentKw * (remainingMs / INTERVAL_MS);
    const coveredMs = open.coveredMs + (holdMs <= this.opts.maxGapMs ? holdMs : 0);
    return {
      start,
      end,
      elapsedMs,
      remainingMs,
      importWh,
      runningAvgKw,
      projectedKw,
      committedKw,
      completeness: elapsedMs > 0 ? Math.min(1, coveredMs / elapsedMs) : 1,
      source,
    };
  }

  private newInterval(
    start: number,
    startCounters: BoundaryValue | null,
    backfilled: boolean,
  ): OpenInterval {
    return {
      start,
      startCounters,
      integratedImportWh: 0,
      integratedExportWh: 0,
      coveredMs: 0,
      sampleCount: 0,
      maxImportW: null,
      counterBroken: false,
      backfilled,
    };
  }

  private close(open: OpenInterval, end: BoundaryValue | null): ClosedInterval {
    const completeness = Math.min(1, open.coveredMs / INTERVAL_MS);
    const s = open.startCounters;
    let importWh: number | null = null;
    let exportWh: number | null = null;
    let source: IntervalSource = 'none';
    let quality: IntervalQuality = 'missing';

    if (s && end && !open.counterBroken && s.importWh != null && end.importWh != null) {
      importWh = Math.max(0, end.importWh - s.importWh);
      exportWh =
        s.exportWh != null && end.exportWh != null ? Math.max(0, end.exportWh - s.exportWh) : null;
      source = 'counter';
      // Gaps inside the interval don't matter: the counter difference is still exact.
      quality = s.exact && end.exact ? 'exact' : 'estimated';
    } else if (open.coveredMs > 0) {
      source = 'integrated';
      if (completeness >= 0.999) {
        importWh = open.integratedImportWh;
        exportWh = open.integratedExportWh;
        quality = 'exact';
      } else {
        // Extrapolate the average power of the covered part to the whole interval.
        const scale = INTERVAL_MS / open.coveredMs;
        importWh = open.integratedImportWh * scale;
        exportWh = open.integratedExportWh * scale;
        quality = s === null && !open.backfilled ? 'partial' : 'estimated';
      }
    }

    return {
      start: open.start,
      importWh,
      exportWh,
      avgImportKw: importWh == null ? null : importWh / 1000 / INTERVAL_HOURS,
      avgExportKw: exportWh == null ? null : exportWh / 1000 / INTERVAL_HOURS,
      completeness,
      quality,
      source,
      sampleCount: open.sampleCount,
      maxImportW: open.maxImportW,
      integratedImportWh: open.integratedImportWh,
    };
  }
}

function hasCounters(s: GridSample): boolean {
  return s.importWh != null && s.exportWh != null;
}

function countersPlausible(a: GridSample, b: GridSample, maxW: number): boolean {
  // Allow 1 Wh of counter resolution on top of the power limit.
  const maxWh = (maxW * (b.ts - a.ts)) / 3_600_000 + 1;
  return b.importWh! - a.importWh! <= maxWh && b.exportWh! - a.exportWh! <= maxWh;
}

function countersMonotonic(a: GridSample, b: GridSample): boolean {
  return b.importWh! >= a.importWh! && b.exportWh! >= a.exportWh!;
}

/** Batch helper: run samples (sorted by ts) through a fresh tracker. */
export function intervalsFromSamples(
  samples: readonly GridSample[],
  options: Partial<IntervalTrackerOptions> = {},
): ClosedInterval[] {
  const t = new IntervalTracker(options);
  const out: ClosedInterval[] = [];
  for (const s of samples) out.push(...t.push(s));
  return out;
}
