/**
 * Closed-loop test of active peak shaving: simulated house + simulated Gen24 (SunSpec
 * model 124 driving the battery) + interval tracker + controller, on a real TimescaleDB
 * (TEST_DATABASE_URL; database `peakguard_active_test` is recreated). Nothing here talks
 * to real hardware.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import postgres from 'postgres';
import { IntervalTracker, type ClosedInterval } from '@peak-guard/core';
import { createDb, decisionsBetween, migrateDb, type Db, type Sql } from '@peak-guard/db';
import { DEFAULT_SETTINGS, type Settings } from '@peak-guard/shared';
import { DEFAULT_PROFILE, DeviceTransport, House, SunSpecDevice } from '@peak-guard/sim';
import { Controller } from '../src/control/controller.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const START = Date.parse('2027-01-15T15:00:00Z'); // 16:00 local
const EV_FROM = Date.parse('2027-01-15T17:00:00Z'); // 18:00 local
const EV_TO = Date.parse('2027-01-15T18:00:00Z');
const TICK = 2_000;

interface Rig {
  house: House;
  transport: DeviceTransport;
  ctl: Controller | null;
  tracker: IntervalTracker;
  closed: ClosedInterval[];
  sim: { now: number; wall: number };
  evAdded: boolean;
}

describe.skipIf(!adminUrl)('active peak shaving (closed loop)', () => {
  let sql: Sql;
  let db: Db;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe('DROP DATABASE IF EXISTS peakguard_active_test WITH (FORCE)');
    await admin.unsafe('CREATE DATABASE peakguard_active_test');
    await admin.end();
    const u = new URL(adminUrl!);
    u.pathname = '/peakguard_active_test';
    await migrateDb(u.toString());
    ({ sql, db } = createDb(u.toString()));
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    thresholdKw: 10,
    control: {
      ...DEFAULT_SETTINGS.control,
      mode: 'active',
      reservePct: 60,
      adaptive: false,
      marginKw: 0.2,
      minUpdateIntervalS: 10,
      minChangeW: 200,
      revertTimeoutS: 120,
    },
  };

  function rig(withController: boolean, revertSupported = true): Rig {
    const sim = { now: START, wall: 0 };
    const house = new House(
      START,
      {
        // January evening: no PV; no random appliances, EV or heat pump — the EV is injected below
        profile: { ...DEFAULT_PROFILE, evW: 0, heatPumpW: 0, appliances: false },
        pvPeakW: 0,
        batteryWh: 10_240,
        batteryMaxW: 6_000,
        revertSupported,
      },
      // below the 60 % reserve from the start: self-consumption would use it before the EV,
      // the controller holds it for the evening
      { socPct: 50 },
    );
    const device = new SunSpecDevice(house, () => sim.now, { controlEnabled: true });
    const transport = new DeviceTransport(device);
    const ctl = withController
      ? new Controller({
          db,
          log: pino({ level: 'silent' }),
          getSettings: () => settings,
          transport,
          writesEnabled: true,
          modbusPollMs: 0,
          now: () => sim.now,
          wallClock: () => sim.wall,
          sleep: (ms) => {
            sim.now += ms;
            sim.wall += ms;
            return Promise.resolve();
          },
          staleAfterMs: 30_000,
        })
      : null;
    return {
      house,
      transport,
      ctl,
      tracker: new IntervalTracker(),
      closed: [],
      sim,
      evAdded: false,
    };
  }

  /** Advance the loop to `until`, ticking the controller every 2 s (unless `tick` is false). */
  async function run(r: Rig, until: number, tick = true) {
    while (r.sim.now < until) {
      r.sim.now += TICK;
      r.sim.wall += TICK;
      // EV charging 18:00–19:00 local (one disturbance for the whole hour)
      if (!r.evAdded && r.sim.now >= EV_FROM) {
        r.house.addDisturbance({ extraW: 11_000, until: EV_TO, name: 'EV' });
        r.evAdded = true;
      }
      const s = r.house.advanceTo(r.sim.now);
      r.closed.push(
        ...r.tracker.push({
          ts: s.ts,
          gridPowerW: s.gridW,
          importWh: s.importWh,
          exportWh: s.exportWh,
        }),
      );
      if (tick && r.ctl) {
        const live = r.tracker.live(r.sim.now)!;
        await r.ctl.tick({
          elapsedMs: live.elapsedMs,
          importWh: live.importWh,
          gridW: s.gridW,
          batteryW: s.batteryW,
          socPct: s.socPct,
          monthPeakKw: null,
        });
      }
    }
  }

  const peak = (r: Rig) =>
    Math.max(...r.closed.filter((c) => c.quality === 'exact').map((c) => c.avgImportKw ?? 0));

  it('without control, self-consumption runs dry during the EV hour and exceeds 10 kW', async () => {
    const r = rig(false);
    await run(r, EV_TO + 30 * 60_000);
    expect(peak(r)).toBeGreaterThan(10.5);
  });

  it('active control keeps every quarter-hour at or below the target, then restores defaults', async () => {
    const r = rig(true);
    const test = await r.ctl!.runRevertTest(60);
    expect(test.status).toBe('passed');
    await run(r, EV_TO + 30 * 60_000);

    expect(peak(r)).toBeLessThanOrEqual(10.05);
    expect(r.closed.filter((c) => (c.avgImportKw ?? 0) > 10.05)).toEqual([]);
    expect(r.transport.writes.length).toBeGreaterThan(0);
    const rows = await decisionsBetween(db, START, EV_TO + 3_600_000, 50_000);
    expect(rows.some((d) => d.decision === 'shave' && d.applied)).toBe(true);
    expect(rows.some((d) => d.decision === 'hold' && d.applied)).toBe(true);
    // the reserve was held before the EV started (SoC stayed above the floor)
    expect(r.house.current.socPct).toBeGreaterThan(5);

    await r.ctl!.close();
    expect(r.house.control.storCtlMod).toBe(0);
  }, 120_000);

  it('if the controller crashes mid-shave, the inverter reverts by itself', async () => {
    const r = rig(true);
    expect((await r.ctl!.runRevertTest(60)).status).toBe('passed');
    await run(r, EV_FROM + 20 * 60_000);
    expect(r.house.control.storCtlMod).toBe(2);
    // controller dead: no ticks, no writes for 3 minutes (> 120 s revert timeout)
    await run(r, EV_FROM + 23 * 60_000, false);
    expect(r.house.control.storCtlMod).toBe(0);
  }, 120_000);

  it('on communication loss the controller reports it and the inverter reverts', async () => {
    const r = rig(true);
    expect((await r.ctl!.runRevertTest(60)).status).toBe('passed');
    await run(r, EV_FROM - 10 * 60_000); // holding the reserve
    expect(r.house.control.storCtlMod).toBe(2);
    r.transport.failing = true;
    await run(r, EV_FROM - 6 * 60_000);
    expect(r.ctl!.snapshotPart()).toMatchObject({ modbus: 'error', applying: false });
    expect(r.ctl!.snapshotPart().note).toMatch(/Modbus unavailable/);
    expect(r.house.control.storCtlMod).toBe(0); // inverter revert timer
    r.transport.failing = false;
    await run(r, EV_FROM - 5 * 60_000);
    expect(r.ctl!.snapshotPart().applying).toBe(true); // recovered
  }, 120_000);

  it('the watchdog restores defaults when control ticks stop', async () => {
    const r = rig(true, false); // firmware without revert timer: only the watchdog helps
    settings.control.acknowledgeNoRevert = true;
    try {
      await run(r, EV_FROM - 10 * 60_000);
      expect(r.house.control.storCtlMod).toBe(2);
      r.sim.wall += 31_000; // no ticks for 31 s
      await r.ctl!.watchdog();
      expect(r.house.control.storCtlMod).toBe(0);
    } finally {
      settings.control.acknowledgeNoRevert = false;
    }
  }, 120_000);
});
