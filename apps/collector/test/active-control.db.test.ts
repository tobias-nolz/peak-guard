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

  function rig(
    withController: boolean,
    revertSupported = true,
    { start = START, socPct = 50 }: { start?: number; socPct?: number } = {},
  ): Rig {
    const sim = { now: start, wall: 0 };
    const house = new House(
      start,
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
      { socPct },
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

  it('grid charging refills the reserve at night, stops for a load spike, then waits out the cooldown', async () => {
    const MIN = 60_000;
    const NIGHT = Date.parse('2027-01-15T21:30:00Z'); // 22:30 local, inside 22:00–06:00
    const SPIKE_FROM = NIGHT + 15 * MIN; // a quarter-hour boundary
    const SPIKE_TO = SPIKE_FROM + 20 * MIN;
    const saved = settings.control.gridCharge;
    // reserve 60 %, start level 50 %, 3 kW, cooldown 60 min
    settings.control.gridCharge = { ...saved, enabled: true };
    try {
      const r = rig(true, true, { start: NIGHT, socPct: 40 });
      expect((await r.ctl!.runRevertTest(60)).status).toBe('passed');

      // reserve empty at night → a charge session starts at 3 kW from the grid
      await run(r, SPIKE_FROM - TICK);
      expect(r.ctl!.snapshotPart()).toMatchObject({
        decision: 'charge',
        chargeW: 3_000,
        applying: true,
      });
      expect(r.house.control.outWRtePct).toBeLessThan(0);
      expect(r.house.current.batteryW).toBeCloseTo(-3_000, 0);
      const socAtSpike = r.house.current.socPct;
      expect(socAtSpike).toBeGreaterThan(40);

      // load spike → the session stops at the next tick and the battery shaves
      r.house.addDisturbance({ extraW: 11_000, until: SPIKE_TO, name: 'sauna' });
      await run(r, SPIKE_FROM + 2 * TICK);
      expect(r.ctl!.snapshotPart().decision).toBe('shave');
      expect(r.house.control.outWRtePct).toBeGreaterThan(0);
      expect(r.house.current.batteryW).toBeGreaterThan(0);

      // after the spike: hold, no new session before the cooldown has passed …
      await run(r, SPIKE_TO + 70 * MIN);
      const rows = await decisionsBetween(db, NIGHT, SPIKE_TO + 70 * MIN, 50_000);
      const charges = rows.filter((d) => d.decision === 'charge');
      const shaves = rows.filter((d) => d.decision === 'shave');
      expect(charges.some((d) => d.applied && d.chargeW === 3_000)).toBe(true);
      expect(rows.filter((d) => d.decision !== 'charge').every((d) => d.chargeW == null)).toBe(
        true,
      );
      expect(shaves.length).toBeGreaterThan(0);
      const firstShave = shaves[0]!.ts;
      const lastShave = shaves.at(-1)!.ts;
      expect(firstShave - SPIKE_FROM).toBeLessThanOrEqual(TICK);
      expect(lastShave).toBeLessThanOrEqual(SPIKE_TO + TICK);
      const between = charges.filter((d) => d.ts > firstShave && d.ts < lastShave + 60 * MIN);
      expect(between).toEqual([]);
      // … and a new session after it
      const restart = charges.find((d) => d.ts >= lastShave + 60 * MIN);
      expect(restart).toBeDefined();
      expect(restart!.ts - lastShave).toBeLessThan(61 * MIN);
      expect(r.ctl!.snapshotPart().decision).toBe('charge');

      // charging never created a quarter-hour above the target, the reserve was never exceeded
      expect(peak(r)).toBeLessThanOrEqual(10.05);
      expect(r.house.current.socPct).toBeLessThanOrEqual(60.5);

      await r.ctl!.close();
      expect(r.house.control.storCtlMod).toBe(0);
    } finally {
      settings.control.gridCharge = saved;
    }
  }, 120_000);
});
