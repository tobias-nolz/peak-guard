import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Aedes } from 'aedes';
import { connectAsync } from 'mqtt';
import { pino } from 'pino';
import type { LiveSnapshot } from '@peak-guard/shared';
import { MqttPublisher, discoveryMessages } from './publisher.js';

const snap: LiveSnapshot = {
  ts: Date.parse('2027-01-15T17:05:00Z'),
  connection: 'ok',
  power: { gridW: 4_200.4, loadW: 5_000, pvW: 800, batteryW: 0, socPct: 55.55 },
  interval: {
    start: Date.parse('2027-01-15T17:00:00Z'),
    end: 0,
    elapsedMs: 300_000,
    remainingMs: 600_000,
    importWh: 350,
    runningAvgKw: 4.2,
    committedKw: 1.4,
    projectedKw: 4.21234,
    completeness: 1,
    source: 'counter',
  },
  thresholdKw: 10,
  effectiveLimitKw: 10,
  monthPeak: { start: 0, kw: 12.4 },
  state: 'safe',
  monthCostEur: 23.4,
  projectedExtraCostEur: 0,
};

describe('MQTT publisher', () => {
  let broker: Aedes;
  let server: ReturnType<typeof createServer>;
  let url: string;

  beforeAll(async () => {
    broker = await Aedes.createBroker();
    server = createServer(broker.handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => broker.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('builds Home Assistant discovery configs', () => {
    const msgs = discoveryMessages({
      url,
      prefix: 'pg',
      discoveryPrefix: 'homeassistant',
      intervalMs: 0,
    });
    const grid = msgs.find(([t]) => t === 'homeassistant/sensor/peak_guard/grid_power_w/config')!;
    expect(JSON.parse(grid[1])).toMatchObject({
      unique_id: 'peak_guard_grid_power_w',
      state_topic: 'pg/state',
      value_template: '{{ value_json.grid_power_w }}',
      unit_of_measurement: 'W',
      device_class: 'power',
      availability_topic: 'pg/status',
      device: { identifiers: ['peak_guard'] },
    });
  });

  it('announces itself, publishes discovery and state, and goes offline on stop', async () => {
    const sub = await connectAsync(url);
    const got = new Map<string, string>();
    sub.on('message', (topic, payload) => got.set(topic, payload.toString()));
    await sub.subscribeAsync(['pg/#', 'homeassistant/#']);

    const p = new MqttPublisher(
      { url, prefix: 'pg', discoveryPrefix: 'homeassistant', intervalMs: 5_000 },
      pino({ level: 'silent' }),
    );
    p.start();
    await expect.poll(() => p.connected).toBe(true);
    p.publish(snap, 10_000);
    p.publish({ ...snap, power: { ...snap.power, gridW: 1 } }, 11_000); // throttled
    await expect.poll(() => got.get('pg/state')).toBeDefined();
    const state = JSON.parse(got.get('pg/state')!) as Record<string, unknown>;
    expect(state).toMatchObject({
      grid_power_w: 4200,
      battery_soc: 55.6,
      interval_projected_kw: 4.212,
      month_peak_kw: 12.4,
      control_mode: 'off',
    });
    expect(got.get('pg/status')).toBe('online');
    expect([...got.keys()].filter((t) => t.startsWith('homeassistant/')).length).toBe(16);

    await p.stop();
    await expect.poll(() => got.get('pg/status')).toBe('offline');
    await sub.endAsync();
  });
});
