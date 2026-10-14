/**
 * Fill an EMPTY database with simulated history (demo / development / e2e tests).
 *
 *   node dist/seed-demo.js [--days 60] [--step 10] [--seed 42] [--force]
 *
 * Uses DATABASE_URL. Refuses to run if samples already exist, unless --force is given,
 * so it can't mix simulated data into real measurements by accident.
 */
import { parseArgs } from 'node:util';
import { INTERVAL_MS, IntervalTracker, intervalStart, type ClosedInterval } from '@peak-guard/core';
import {
  addEvent,
  createDb,
  insertSamples,
  lastSample,
  migrateDb,
  refreshMinuteAggregate,
  upsertIntervals,
  type SampleRow,
} from '@peak-guard/db';
import { DEFAULT_PROFILE, House } from '@peak-guard/sim';

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '60' },
    step: { type: 'string', default: '10' },
    seed: { type: 'string', default: '42' },
    force: { type: 'boolean', default: false },
  },
});

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const days = Number(values.days);
const stepMs = Number(values.step) * 1000;
if (!(days > 0 && days <= 400) || !(stepMs >= 1000 && stepMs <= 30_000)) {
  throw new Error('--days must be 1..400 and --step 1..30 seconds');
}

await migrateDb(url);
const { sql, db } = createDb(url);
try {
  if ((await lastSample(db)) && !values.force) {
    console.error(
      'Database already contains samples; refusing to seed demo data (use --force to override).',
    );
    process.exitCode = 2;
  } else {
    const end = intervalStart(Date.now());
    const start = end - days * 86_400_000;
    const house = new House(
      start,
      {
        profile: { ...DEFAULT_PROFILE, seed: Number(values.seed) },
      },
      { importWh: 1_000_000, exportWh: 500_000 },
    );
    const tracker = new IntervalTracker();
    let batch: SampleRow[] = [];
    let closed: ClosedInterval[] = [];
    let count = 0;
    const flush = async () => {
      await insertSamples(db, batch);
      await upsertIntervals(db, closed);
      count += batch.length;
      batch = [];
      closed = [];
    };

    console.log(
      `Seeding ${days} days (${new Date(start).toISOString()} → ${new Date(end).toISOString()}), step ${stepMs / 1000} s…`,
    );
    for (let ts = start; ts < end; ts += stepMs) {
      const s = house.advanceTo(ts, stepMs);
      batch.push({
        ts,
        gridW: s.gridW,
        loadW: s.loadW,
        pvW: s.pvW,
        batteryW: s.batteryW,
        socPct: s.socPct,
        importWh: s.importWh,
        exportWh: s.exportWh,
      });
      closed.push(
        ...tracker.push({ ts, gridPowerW: s.gridW, importWh: s.importWh, exportWh: s.exportWh }),
      );
      if (batch.length >= 5_000) {
        await flush();
        if ((count / 5_000) % 20 === 0)
          console.log(`  ${new Date(ts).toISOString().slice(0, 10)} (${count} samples)`);
      }
    }
    await flush();
    // The first interval is partial (no start boundary); drop it for a clean history.
    await sql`DELETE FROM intervals WHERE start = ${new Date(start).toISOString()} AND quality = 'partial'`;
    await refreshMinuteAggregate(sql, start - INTERVAL_MS, end + INTERVAL_MS);
    await addEvent(db, 'seed', `Seeded ${days} days of simulated demo data`, {
      start,
      end,
      samples: count,
    });
    console.log(`Done: ${count} samples.`);
  }
} finally {
  await sql.end();
}
