import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gen24Image, startModbusServer } from '../../test/modbus-fixture.js';
import {
  STORAGE_DEFAULTS,
  discoverModels,
  encodeStorageCommand,
  readStorage,
  writeStorage,
} from './sunspec.js';
import { ModbusTcpTransport } from './transport.js';

describe('SunSpec over Modbus TCP (Gen24-like image)', () => {
  const regs = gen24Image();
  const writes: [number, number][] = [];
  let server: Awaited<ReturnType<typeof startModbusServer>>;
  let t: ModbusTcpTransport;

  beforeAll(async () => {
    server = await startModbusServer(regs, writes);
    t = new ModbusTcpTransport({ host: '127.0.0.1', port: server.port, timeoutMs: 2_000 });
  });
  afterAll(async () => {
    await t.close();
    await server.close();
  });

  it('walks the model chain and finds model 124 at 40343', async () => {
    const models = await discoverModels(t);
    expect(models.map((m) => m.id)).toEqual([1, 103, 120, 121, 122, 123, 160, 124]);
    expect(models.find((m) => m.id === 124)).toEqual({ id: 124, address: 40343, length: 24 });
  });

  it('decodes model 124 with scale factors', async () => {
    const model = (await discoverModels(t)).find((m) => m.id === 124)!;
    const s = await readStorage(t, model);
    expect(s).toMatchObject({
      dataAddress: 40345,
      wChaMaxW: 10_000,
      storCtlMod: 0,
      minRsvPct: 5,
      chaSt: 'CHARGING',
      outWRtePct: 100,
      inWRtePct: 100,
      rvrtTmsS: 0,
      inOutWRteSf: -2,
    });
    expect(s.chaStatePct).toBeCloseTo(63.2, 6);
  });

  it('writes a discharge limit to the documented Gen24 registers', async () => {
    const model = (await discoverModels(t)).find((m) => m.id === 124)!;
    const s = await readStorage(t, model);
    writes.length = 0;
    await writeStorage(t, { storCtlMod: 2, outWRtePct: 37.5, inWRtePct: 100, rvrtTmsS: 120 }, s);
    // OutWRte 40355, InWRte 40356, WinTms 40357, RvrtTms 40358, then StorCtl_Mod 40348
    expect(writes).toEqual([
      [40355, 3750],
      [40356, 10_000],
      [40357, 0],
      [40358, 120],
      [40348, 2],
    ]);
    const after = await readStorage(t, model);
    expect(after).toMatchObject({ storCtlMod: 2, outWRtePct: 37.5, rvrtTmsS: 120 });
    await writeStorage(t, STORAGE_DEFAULTS, s);
    expect((await readStorage(t, model)).storCtlMod).toBe(0);
  });
});

describe('encodeStorageCommand', () => {
  const state = { dataAddress: 100, inOutWRteSf: -2 };
  it('refuses forced charging or discharging', () => {
    expect(() =>
      encodeStorageCommand({ storCtlMod: 2, outWRtePct: -50, inWRtePct: 100, rvrtTmsS: 60 }, state),
    ).toThrow(/forced/);
    expect(() =>
      encodeStorageCommand({ storCtlMod: 1, outWRtePct: 100, inWRtePct: -10, rvrtTmsS: 60 }, state),
    ).toThrow(/forced/);
    expect(() =>
      encodeStorageCommand({ storCtlMod: 7, outWRtePct: 0, inWRtePct: 100, rvrtTmsS: 60 }, state),
    ).toThrow(/StorCtl_Mod/);
  });
});
