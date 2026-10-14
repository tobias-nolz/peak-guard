/**
 * Integration test against a real TimescaleDB. Set TEST_DATABASE_URL to an admin URL,
 * e.g. postgres://peakguard:devpassword@127.0.0.1:5432/peakguard — a separate database
 * `peakguard_test` is (re)created for the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import postgres from 'postgres';
import { INTERVAL_MS, intervalsFromSamples, type GridSample } from '@peak-guard/core';
import {
  createDb,
  intervalsBetween,
  migrateDb,
  recentEvents,
  type Db,
  type Sql,
} from '@peak-guard/db';
import type { SolarApiClient } from '@peak-guard/fronius';
import { DEFAULT_SETTINGS } from '@peak-guard/shared';
import { House } from '@peak-guard/sim';
import { Collector } from '../src/collector.js';
import { collectorEnvSchema } from '../src/config.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const T0 = Date.parse('2027-01-15T16:00:00Z');

describe.skipIf(!adminUrl)('collector ↔ TimescaleDB', () => {
  let url: string;
  let sql: Sql;
  let db: Db;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe('DROP DATABASE IF EXISTS peakguard_test WITH (FORCE)');
    await admin.unsafe('CREATE DATABASE peakguard_test');
    await admin.end();
    const u = new URL(adminUrl!);
    u.pathname = '/peakguard_test';
    url = u.toString();
    // concurrent runs (collector + API starting together) are serialized by an advisory lock
    await Promise.all([migrateDb(url), migrateDb(url)]);
    await migrateDb(url); // idempotent
    ({ sql, db } = createDb(url));
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  const makeCollector = () =>
    new Collector({
      env: collectorEnvSchema.parse({
        DATABASE_URL: url,
        FRONIUS_URL: 'http://unused',
        SAMPLE_FLUSH_MS: 1_000_000,
      }),
      db,
      api: {} as SolarApiClient,
      log: pino({ level: 'silent' }),
      getSettings: () => DEFAULT_SETTINGS,
      publish: () => Promise.resolve(),
    });

  function simulate(from: number, to: number, stepMs: number): GridSample[] {
    const house = new House(from, { batteryWh: 0 });
    const out: GridSample[] = [];
    for (let ts = from; ts <= to; ts += stepMs) {
      const s = house.advanceTo(ts);
      out.push({ ts, gridPowerW: s.gridW, importWh: s.importWh, exportWh: s.exportWh });
    }
    return out;
  }

  it('persists the same intervals as the pure tracker, survives a restart and backfills a gap', async () => {
    const samples = simulate(T0, T0 + 3 * 3_600_000, 2_000);
    const firstHalf = samples.filter((s) => s.ts < T0 + 80 * 60_000);
    // collector "crashes" for 20 minutes, the inverter keeps counting
    const secondHalf = samples.filter((s) => s.ts >= T0 + 100 * 60_000);

    const c1 = makeCollector();
    await c1.recover();
    for (const s of firstHalf) await c1.ingest(s, null);
    await c1.stop();

    const c2 = makeCollector();
    await c2.recover();
    for (const s of secondHalf) await c2.ingest(s, null);
    await c2.stop();

    const stored = await intervalsBetween(db, T0, T0 + 3 * 3_600_000);
    const expected = intervalsFromSamples([...firstHalf, ...secondHalf]);

    expect(stored.map((i) => i.start)).toEqual(expected.map((i) => i.start));
    for (const [k, e] of expected.entries()) {
      expect(stored[k]!.quality).toBe(e.quality);
      expect(stored[k]!.avgImportKw ?? 0).toBeCloseTo(e.avgImportKw ?? 0, 6);
    }
    // outage 80→100 min: the two intervals touching it are counter-estimated,
    // the neighbours (recovered state before, fresh data after) stay exact
    const q = (min: number) => stored.find((i) => i.start === T0 + min * 60_000)!.quality;
    expect([q(60), q(75), q(90), q(105)]).toEqual(['exact', 'estimated', 'estimated', 'exact']);
    expect(stored.length).toBe(12);
    expect(stored.every((i) => i.start % INTERVAL_MS === 0)).toBe(true);

    const events = await recentEvents(db, 50);
    expect(events.some((e) => e.kind === 'backfill')).toBe(true);
    expect(events.some((e) => e.kind === 'month_peak')).toBe(true);
  }, 60_000);

  it('restarts interval tracking when the clock jumps backwards', async () => {
    const c = makeCollector();
    const future = simulate(T0 + 10 * 86_400_000, T0 + 10 * 86_400_000 + 60_000, 2_000);
    for (const s of future) await c.ingest(s, null);
    // clock goes back 10 days: samples must not be dropped forever
    const past = simulate(T0 + 86_400_000, T0 + 86_400_000 + 20 * 60_000, 2_000);
    const closed = [];
    for (const s of past) closed.push(...(await c.ingest(s, null)));
    await c.stop();
    expect(closed.length).toBeGreaterThan(0);
    const events = await recentEvents(db, 20);
    expect(events.some((e) => e.kind === 'clock_jump')).toBe(true);
  }, 60_000);
});
