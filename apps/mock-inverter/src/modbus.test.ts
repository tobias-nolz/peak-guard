import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { House } from '@peak-guard/sim';
import {
  ModbusTcpTransport,
  discoverModels,
  readStorage,
  writeStorage,
  STORAGE_DEFAULTS,
} from '@peak-guard/fronius';
import { createModbusServer } from './modbus.js';

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as import('node:net').AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function start(controlEnabled: boolean, revertSupported = true) {
  const t0 = Date.parse('2027-01-15T17:00:00Z');
  let now = t0;
  const house = new House(t0, { revertSupported }, { socPct: 60 });
  const port = await freePort();
  const server = createModbusServer(
    house,
    { now: () => now },
    { port, host: '127.0.0.1', controlEnabled },
  );
  await new Promise<void>((r) => server.on('initialized', () => r()));
  const t = new ModbusTcpTransport({ host: '127.0.0.1', port, timeoutMs: 2_000 });
  return {
    house,
    t,
    advance: (ms: number) => (now += ms),
    close: async () => {
      await t.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('mock inverter Modbus', () => {
  let m: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => (m = await start(true)));
  afterAll(() => m.close());

  it('exposes the Gen24 chain and live model 124 values', async () => {
    const models = await discoverModels(m.t);
    const model = models.find((x) => x.id === 124)!;
    expect(model.address).toBe(40343);
    const s = await readStorage(m.t, model);
    expect(s.wChaMaxW).toBe(m.house.config.batteryMaxW);
    expect(s.chaStatePct).toBeCloseTo(m.house.current.socPct, 0);
    expect(s.storCtlMod).toBe(0);
  });

  it('applies a discharge limit to the simulated battery and reverts after the timeout', async () => {
    const model = (await discoverModels(m.t)).find((x) => x.id === 124)!;
    const s = await readStorage(m.t, model);
    await writeStorage(m.t, { storCtlMod: 2, outWRtePct: 10, inWRtePct: 100, rvrtTmsS: 60 }, s);
    expect(m.house.control).toMatchObject({ storCtlMod: 2, outWRtePct: 10, revertS: 60 });
    m.advance(30_000);
    expect(m.house.advanceTo(Date.parse('2027-01-15T17:00:30Z')).batteryW).toBeLessThanOrEqual(
      600 + 1e-6,
    );
    m.advance(40_000); // > 60 s since the last write
    expect((await readStorage(m.t, model)).storCtlMod).toBe(0);
    await writeStorage(m.t, STORAGE_DEFAULTS, s);
  });
});

describe('mock inverter with Modbus control disabled', () => {
  it('rejects writes with a Modbus exception', async () => {
    const m = await start(false);
    try {
      const model = (await discoverModels(m.t)).find((x) => x.id === 124)!;
      const s = await readStorage(m.t, model);
      await expect(
        writeStorage(m.t, { storCtlMod: 2, outWRtePct: 0, inWRtePct: 100, rvrtTmsS: 60 }, s),
      ).rejects.toThrow();
      expect(m.house.control.storCtlMod).toBe(0);
    } finally {
      await m.close();
    }
  });
});
