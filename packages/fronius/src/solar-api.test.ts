import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SolarApiClient,
  SolarApiError,
  gridMeterFrom,
  meterSystemSchema,
  powerFlowFrom,
  powerFlowSchema,
} from './solar-api.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8'));

describe('Solar API mapping', () => {
  it('maps a Gen24 power flow response', () => {
    const r = powerFlowFrom(powerFlowSchema.parse(fixture('gen24-powerflow.json')));
    expect(r).toEqual({
      gridW: 4120.7,
      loadW: 6431.2,
      pvW: 1498.1,
      batteryW: 812.4,
      socPct: 63.2,
      batteryMode: 'normal',
    });
  });

  it('selects the grid meter and reads its counters', () => {
    const m = gridMeterFrom(meterSystemSchema.parse(fixture('gen24-meter-system.json')));
    expect(m).toEqual({
      meterId: '0',
      model: 'Smart Meter TS 65A-3',
      powerW: 4118.9,
      importWh: 5122871,
      exportWh: 8412233,
    });
  });

  it('prefers the meter at the feed-in point when several are present', () => {
    const base = fixture('gen24-meter-system.json') as { Body: { Data: Record<string, object> } };
    const sub = { ...base.Body.Data['0'], Meter_Location_Current: 256, PowerReal_P_Sum: 900 };
    base.Body.Data = { '1': sub, '0': base.Body.Data['0']! };
    expect(gridMeterFrom(meterSystemSchema.parse(base)).meterId).toBe('0');
  });
});

describe('SolarApiClient', () => {
  const okFetch =
    (body: unknown): typeof fetch =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it('requests the documented endpoint', async () => {
    let url = '';
    const client = new SolarApiClient({
      baseUrl: 'http://inverter/',
      fetch: ((u: string) => {
        url = u;
        return okFetch(fixture('gen24-meter-system.json'))(u);
      }) as typeof fetch,
    });
    await client.meters();
    expect(url).toBe('http://inverter/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System');
  });

  it('raises on a non-zero status code', async () => {
    const body = fixture('gen24-powerflow.json') as {
      Head: { Status: { Code: number; Reason: string } };
    };
    body.Head.Status = { Code: 255, Reason: 'not supported' };
    const client = new SolarApiClient({ baseUrl: 'http://x', fetch: okFetch(body) });
    await expect(client.powerFlow()).rejects.toBeInstanceOf(SolarApiError);
  });
});
