import {
  INTERVAL_MS,
  IntervalTracker,
  intervalStart,
  startOfLocalMonth,
  startOfNextLocalMonth,
  type ClosedInterval,
  type GridSample,
} from '@peak-guard/core';
import {
  addEvent,
  gridSamplesBetween,
  insertSamples,
  kvSet,
  lastSample,
  peakBetween,
  upsertIntervals,
  type Db,
  type SampleRow,
} from '@peak-guard/db';
import {
  gridMeterFrom,
  powerFlowFrom,
  type PowerFlowReading,
  type SolarApiClient,
} from '@peak-guard/fronius';
import type { LiveSnapshot, Settings } from '@peak-guard/shared';
import type { Logger } from 'pino';
import type { CollectorEnv } from './config.js';
import { DuplicateTimestampDetector } from './clock-check.js';
import type { CollectorMetrics } from './metrics.js';
import { PowerSmoother, buildSnapshot } from './snapshot.js';

export interface CollectorDeps {
  env: CollectorEnv;
  db: Db;
  api: SolarApiClient;
  log: Logger;
  getSettings: () => Settings;
  publish: (snapshot: LiveSnapshot) => Promise<void>;
  metrics?: CollectorMetrics;
  now?: () => number;
}

type Connection = LiveSnapshot['connection'];

/**
 * Polls the inverter, persists raw samples and closed quarter-hours, and publishes the
 * live snapshot. The I/O shell around the pure IntervalTracker.
 */
export class Collector {
  private tracker: IntervalTracker;
  private readonly smoother: PowerSmoother;
  private buffer: SampleRow[] = [];
  private lastFlush = 0;
  private lastOkAt = 0;
  private lastTickAt = Date.now();
  private lastFlow: PowerFlowReading | null = null;
  private lastGridW = 0;
  private connection: Connection = 'down';
  private monthPeak: { start: number; kw: number } | null = null;
  private monthStart = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inverterClock: number | null = null;
  private lastSnapshot: LiveSnapshot | null = null;
  /** Closed intervals not yet persisted (DB unavailable); retried every tick. */
  private pendingIntervals: ClosedInterval[] = [];
  private readonly clockCheck = new DuplicateTimestampDetector();

  constructor(private readonly deps: CollectorDeps) {
    this.tracker = this.newTracker();
    this.smoother = new PowerSmoother(deps.getSettings().projectionSmoothingS * 1000);
  }

  /** Time of the last successful poll (epoch ms, collector clock). */
  get lastSuccessAt(): number {
    return this.lastOkAt;
  }

  /** Time the poll loop last completed a cycle (liveness, independent of the inverter). */
  get lastLoopAt(): number {
    return this.lastTickAt;
  }

  get snapshot(): LiveSnapshot | null {
    return this.lastSnapshot;
  }

  private newTracker(): IntervalTracker {
    const { env } = this.deps;
    return new IntervalTracker({
      maxGapMs: env.MAX_GAP_MS,
      maxBackfillMs: env.MAX_BACKFILL_HOURS * 3_600_000,
    });
  }

  private now(): number {
    if (this.deps.env.CLOCK_SOURCE === 'inverter' && this.inverterClock != null)
      return this.inverterClock;
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Rebuild tracker state from the database so a restart doesn't lose the open interval.
   * Replays from one interval before the last stored sample; intervals closed during the
   * replay are already persisted and are ignored.
   */
  async recover(): Promise<void> {
    const { db, log } = this.deps;
    const last = await lastSample(db);
    if (!last) {
      log.info('no previous samples; starting fresh');
      return;
    }
    const from = intervalStart(last.ts) - INTERVAL_MS;
    const replay = await gridSamplesBetween(db, from, last.ts + 1);
    for (const s of replay) this.tracker.push(s);
    await this.refreshMonthPeak(last.ts);
    log.info(
      { lastSample: new Date(last.ts).toISOString(), replayed: replay.length },
      'recovered tracker state',
    );
  }

  private async refreshMonthPeak(ts: number): Promise<void> {
    const tz = this.deps.env.TIME_ZONE;
    this.monthStart = startOfLocalMonth(ts, tz);
    const peak = await peakBetween(this.deps.db, this.monthStart, startOfNextLocalMonth(ts, tz));
    this.monthPeak = peak?.avgImportKw != null ? { start: peak.start, kw: peak.avgImportKw } : null;
  }

  start(): void {
    this.running = true;
    const loop = async () => {
      const started = Date.now();
      await this.tick();
      if (!this.running) return;
      const delay = Math.max(0, this.deps.env.POLL_INTERVAL_MS - (Date.now() - started));
      this.timer = setTimeout(() => void loop(), delay);
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.flush(true);
  }

  /** One poll cycle. Never throws. */
  async tick(): Promise<void> {
    const { api, log } = this.deps;
    const started = performance.now();
    try {
      // The Gen24 tolerates at most two parallel requests.
      const [flowRes, meterRes] = await Promise.all([api.powerFlow(), api.meters()]);
      const meter = gridMeterFrom(meterRes);
      const flow = powerFlowFrom(flowRes);
      const ts =
        this.deps.env.CLOCK_SOURCE === 'inverter'
          ? Date.parse(meterRes.Head.Timestamp)
          : (this.deps.now ?? Date.now)();
      if (this.deps.env.CLOCK_SOURCE === 'inverter') {
        this.inverterClock = ts;
        if (this.clockCheck.record(ts)) await this.warnCoarseClock();
      }
      await this.ingest(
        { ts, gridPowerW: meter.powerW, importWh: meter.importWh, exportWh: meter.exportWh },
        flow,
      );
      this.lastOkAt = Date.now();
      this.deps.metrics?.pollOk((performance.now() - started) / 1000);
      await this.setConnection('ok');
    } catch (err) {
      log.warn({ err: errorMessage(err) }, 'poll failed');
      this.deps.metrics?.pollFailed();
      const age = Date.now() - this.lastOkAt;
      await this.setConnection(
        age > 3 * this.deps.env.STALE_AFTER_MS
          ? 'down'
          : age > this.deps.env.STALE_AFTER_MS
            ? 'stale'
            : this.connection,
      );
    }
    await this.publish();
    await this.flush(false);
    await this.persistIntervals();
    this.lastTickAt = Date.now();
  }

  /** Feed one sample (exposed for tests and the demo seeder). */
  async ingest(sample: GridSample, flow: PowerFlowReading | null): Promise<ClosedInterval[]> {
    const { log } = this.deps;
    this.lastFlow = flow;
    this.lastGridW = sample.gridPowerW;
    this.smoother.setWindow(this.deps.getSettings().projectionSmoothingS * 1000);
    this.smoother.push(sample.ts, sample.gridPowerW);
    this.buffer.push({
      ts: sample.ts,
      gridW: sample.gridPowerW,
      loadW: flow?.loadW ?? null,
      pvW: flow?.pvW ?? null,
      batteryW: flow?.batteryW ?? null,
      socPct: flow?.socPct ?? null,
      importWh: sample.importWh,
      exportWh: sample.exportWh,
    });

    const closed = this.tracker.push(sample);
    if (closed.length > 0) {
      // Persist samples first so a recompute from raw data is always possible.
      await this.flush(true);
      this.pendingIntervals.push(...closed);
      await this.persistIntervals();
      const nonExact = closed.filter((c) => c.quality !== 'exact');
      if (closed.length > 1 || nonExact.length > 0) {
        log.info(
          { count: closed.length, qualities: closed.map((c) => c.quality) },
          'closed intervals (gap/backfill)',
        );
        const bridged = closed.filter((c) => c.quality === 'estimated' || c.quality === 'missing');
        if (bridged.length > 0) {
          await addEvent(
            this.deps.db,
            'backfill',
            `Bridged a data gap: ${bridged.length} interval(s) estimated or missing`,
            {
              from: new Date(bridged[0]!.start).toISOString(),
              to: new Date(bridged.at(-1)!.start).toISOString(),
              qualities: bridged.map((c) => c.quality),
            },
          );
        }
      }
      for (const c of closed) {
        this.deps.metrics?.intervalClosed(c.quality);
        await this.onClosed(c);
      }
    }
    return closed;
  }

  private async persistIntervals(): Promise<void> {
    if (this.pendingIntervals.length === 0) return;
    try {
      await upsertIntervals(this.deps.db, this.pendingIntervals);
      this.pendingIntervals = [];
    } catch (err) {
      this.deps.log.error(
        { err: errorMessage(err), pending: this.pendingIntervals.length },
        'failed to write intervals',
      );
    }
  }

  private async onClosed(c: ClosedInterval): Promise<void> {
    const tz = this.deps.env.TIME_ZONE;
    if (c.start >= startOfNextLocalMonth(this.monthStart, tz) || this.monthStart === 0) {
      await this.refreshMonthPeak(c.start);
      return;
    }
    if (
      c.avgImportKw != null &&
      c.quality !== 'missing' &&
      (!this.monthPeak || c.avgImportKw > this.monthPeak.kw)
    ) {
      const previous = this.monthPeak;
      this.monthPeak = { start: c.start, kw: c.avgImportKw };
      this.deps.log.info({ kw: c.avgImportKw, previous: previous?.kw }, 'new month peak');
      await addEvent(this.deps.db, 'month_peak', `New month peak ${c.avgImportKw.toFixed(2)} kW`, {
        start: new Date(c.start).toISOString(),
        kw: c.avgImportKw,
        previousKw: previous?.kw ?? null,
      });
    }
  }

  private async warnCoarseClock(): Promise<void> {
    const { env, log, db } = this.deps;
    const message =
      'CLOCK_SOURCE=inverter, but the inverter repeats timestamps (whole-second clock, as on real ' +
      'hardware): samples are being dropped. Use CLOCK_SOURCE=local for a real inverter; ' +
      '"inverter" is meant for the accelerated mock.';
    log.warn(
      {
        duplicateRatio: this.clockCheck.duplicateRatio,
        pollMs: env.POLL_INTERVAL_MS,
        fronius: env.FRONIUS_URL,
      },
      message,
    );
    await addEvent(db, 'config_warning', message, {
      fronius: env.FRONIUS_URL,
      pollMs: env.POLL_INTERVAL_MS,
    }).catch(() => {});
  }

  private async setConnection(next: Connection): Promise<void> {
    if (next === this.connection) return;
    const prev = this.connection;
    this.connection = next;
    this.deps.log.info({ from: prev, to: next }, 'inverter connection state changed');
    await addEvent(this.deps.db, 'connection', `Inverter connection ${prev} → ${next}`).catch(
      () => {},
    );
  }

  private async publish(): Promise<void> {
    const live = this.tracker.live(this.now());
    if (!live) return;
    const snap = buildSnapshot({
      now: this.now(),
      connection: this.connection,
      live,
      gridW: this.lastGridW,
      flow: this.lastFlow,
      smoothedImportW: this.smoother.value(),
      monthPeak: this.monthPeak,
      settings: this.deps.getSettings(),
      timeZone: this.deps.env.TIME_ZONE,
    });
    this.lastSnapshot = snap;
    await this.deps
      .publish(snap)
      .catch((err: unknown) => this.deps.log.warn({ err: errorMessage(err) }, 'publish failed'));
  }

  private async flush(force: boolean): Promise<void> {
    const now = Date.now();
    if (
      this.buffer.length === 0 ||
      (!force && now - this.lastFlush < this.deps.env.SAMPLE_FLUSH_MS)
    )
      return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await insertSamples(this.deps.db, rows);
      this.deps.metrics?.samplesWritten(rows.length);
      this.lastFlush = now;
      await kvSet(this.deps.db, 'collector.heartbeat', { ts: now, lastSampleTs: rows.at(-1)!.ts });
    } catch (err) {
      // Keep the rows for the next attempt (bounded to ~1 day at 1 s polling).
      this.buffer = [...rows, ...this.buffer].slice(-100_000);
      this.deps.log.error({ err: errorMessage(err) }, 'failed to write samples');
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error)
    return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
  return String(err);
}
