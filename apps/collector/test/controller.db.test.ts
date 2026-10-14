/**
 * Controller against an in-memory SunSpec device and a real TimescaleDB
 * (TEST_DATABASE_URL, admin URL; database `peakguard_ctl_test` is recreated).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import postgres from 'postgres';
import { createDb, decisionsBetween, kvGet, migrateDb, type Db, type Sql } from '@peak-guard/db';
import { MemoryTransport, sunspecTestImage } from '@peak-guard/fronius';
import { DEFAULT_SETTINGS, type Settings } from '@peak-guard/shared';
import { Controller, type ControllerDeps } from '../src/control/controller.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const STOR_CTL_MOD = 40348; // model 124 at 40343 → data 40345 + 3

/** Device whose storage revert timer works (or not): reverts on the second read after a write. */
class Device extends MemoryTransport {
  private readsSinceWrite = 0;
  constructor(private readonly revertSupported: boolean) {
    super(sunspecTestImage({ socPct: 30 }));
    this.onWrite = () => (this.readsSinceWrite = 0);
  }
  override read(address: number, length: number) {
    if (this.revertSupported && this.regs.get(STOR_CTL_MOD) !== 0 && ++this.readsSinceWrite >= 2) {
      this.regs.set(STOR_CTL_MOD, 0);
    }
    return super.read(address, length);
  }
}

describe.skipIf(!adminUrl)('Controller (dry-run + revert self-test)', () => {
  let sql: Sql;
  let db: Db;
  let settings: Settings;
  let fakeNow = 0;

  beforeAll(async () => {
    const admin = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe('DROP DATABASE IF EXISTS peakguard_ctl_test WITH (FORCE)');
    await admin.unsafe('CREATE DATABASE peakguard_ctl_test');
    await admin.end();
    const u = new URL(adminUrl!);
    u.pathname = '/peakguard_ctl_test';
    await migrateDb(u.toString());
    ({ sql, db } = createDb(u.toString()));
  }, 60_000);
  afterAll(async () => {
    await sql?.end();
  });

  const make = (transport: MemoryTransport | null, patch: Partial<ControllerDeps> = {}) => {
    settings = {
      ...DEFAULT_SETTINGS,
      control: { ...DEFAULT_SETTINGS.control, mode: 'dryRun', reservePct: 40 },
    };
    let now = Date.parse('2027-01-15T17:00:00Z');
    return {
      ctl: new Controller({
        db,
        log: pino({ level: 'silent' }),
        getSettings: () => settings,
        transport,
        writesEnabled: true,
        modbusPollMs: 0,
        now: () => (now += 2_000),
        sleep: (ms) => {
          fakeNow += ms;
          return Promise.resolve();
        },
        wallClock: () => fakeNow,
        ...patch,
      }),
    };
  };

  it('dry-run: reads model 124, decides and logs, never writes', async () => {
    const dev = new Device(true);
    const { ctl } = make(dev);
    // SoC 30 % ≤ reserve 40 %: 12 kW import at the start of an interval → shave 2 kW (+0.2 kW margin)
    await ctl.tick({
      elapsedMs: 0,
      importWh: 0,
      gridW: 12_000,
      batteryW: 0,
      socPct: 99,
      monthPeakKw: null,
    });
    const part = ctl.snapshotPart();
    expect(part).toMatchObject({ mode: 'dryRun', modbus: 'ok', decision: 'shave', storCtlMod: 0 });
    expect(part.limitW).toBeCloseTo(2_200, 6);
    // low load → hold the reserve
    await ctl.tick({
      elapsedMs: 60_000,
      importWh: 50,
      gridW: 3_000,
      batteryW: 0,
      socPct: 99,
      monthPeakKw: null,
    });
    expect(ctl.snapshotPart().decision).toBe('hold');
    await ctl.close();
    expect(dev.writes).toEqual([]);
    const rows = await decisionsBetween(db, 0, Date.now() * 2);
    expect(rows.map((r) => [r.decision, r.storCtlMod, r.outWRtePct, r.applied])).toEqual([
      ['shave', 2, expect.closeTo(36.67, 2) as unknown as number, false],
      ['hold', 2, 0, false],
    ]);
    const status = await kvGet<{ modbus: { state: string } }>(db, 'control.status');
    expect(status?.modbus.state).toBe('ok');
  });

  it('uses the Modbus SoC and falls back to settings without Modbus', async () => {
    const { ctl } = make(null);
    await ctl.tick({
      elapsedMs: 0,
      importWh: 0,
      gridW: 12_000,
      batteryW: 0,
      socPct: 30,
      monthPeakKw: null,
    });
    expect(ctl.snapshotPart()).toMatchObject({ modbus: 'disabled', decision: null });
    expect(ctl.snapshotPart().note).toMatch(/battery power unknown/);
    settings = { ...settings, battery: { ...settings.battery, maxPowerKw: 5 } };
    await ctl.tick({
      elapsedMs: 0,
      importWh: 0,
      gridW: 12_000,
      batteryW: 0,
      socPct: 30,
      monthPeakKw: null,
    });
    expect(ctl.snapshotPart().decision).toBe('shave');
  });

  it('revert self-test passes when the inverter reverts and leaves defaults', async () => {
    const dev = new Device(true);
    const { ctl } = make(dev);
    const r = await ctl.runRevertTest(60);
    expect(r.status).toBe('passed');
    expect(dev.regs.get(STOR_CTL_MOD)).toBe(0);
    // the probe was harmless: discharge limit at 100 %
    expect(dev.writes).toContainEqual([40355, 10_000]);
  });

  it('revert self-test fails and restores defaults when the inverter does not revert', async () => {
    const dev = new Device(false);
    const { ctl } = make(dev);
    const r = await ctl.runRevertTest(60);
    expect(r.status).toBe('failed');
    expect(r.message).toMatch(/did NOT revert.*defaults restored/);
    expect(dev.regs.get(STOR_CTL_MOD)).toBe(0);
  });

  it('revert self-test refuses without the write kill switch and on rejected writes', async () => {
    expect(
      (await make(new Device(true), { writesEnabled: false }).ctl.runRevertTest()).message,
    ).toMatch(/CONTROL_WRITES_ENABLED/);
    const dev = new Device(true);
    dev.onWrite = () => {
      throw new Error('Modbus exception 1');
    };
    const r = await make(dev).ctl.runRevertTest();
    expect(r).toMatchObject({ status: 'failed' });
    expect(r.message).toMatch(/Inverter control via Modbus/);
  });
});
