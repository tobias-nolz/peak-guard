import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { House } from '@peak-guard/sim';
import { SolarApiClient, gridMeterFrom, powerFlowFrom } from '@peak-guard/fronius';
import { createMockServer } from './server.js';

describe('mock inverter speaks Solar API v1', () => {
  const t0 = Date.parse('2027-01-15T17:00:00Z');
  let now = t0;
  const house = new House(t0);
  const server = createMockServer(house, { now: () => now });
  let client: SolarApiClient;

  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, r));
    client = new SolarApiClient({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('serves power flow and meter data that the real client parses', async () => {
    now = t0 + 60_000;
    const pf = powerFlowFrom(await client.powerFlow());
    const meter = gridMeterFrom(await client.meters());
    expect(pf.gridW).toBeCloseTo(meter.powerW, 0);
    expect(meter.importWh).toBeGreaterThan(0);
    expect(pf.loadW).toBeCloseTo(house.current.loadW, 0);
  });

  it('simulates a communication loss', async () => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await fetch(`${base}/mock/outage`, { method: 'POST', body: JSON.stringify({ seconds: 30 }) });
    await expect(client.powerFlow()).rejects.toThrow();
    now += 31_000;
    await expect(client.powerFlow()).resolves.toBeDefined();
  });
});
