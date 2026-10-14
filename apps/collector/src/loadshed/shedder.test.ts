import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import {
  DEFAULT_SETTINGS,
  type LiveSnapshot,
  type LoadShedRuleSettings,
  type Settings,
} from '@peak-guard/shared';
import { LoadShedder } from './shedder.js';

const wallbox: LoadShedRuleSettings = {
  id: 'wb',
  name: 'Wallbox',
  enabled: true,
  triggerRatio: 0.95,
  releaseRatio: 0.8,
  minOnMinutes: 5,
  maxOnMinutes: 60,
  minOffMinutes: 5,
  shed: { type: 'webhook', url: 'http://wallbox.local/api/set?amp=6', method: 'GET' },
  restore: { type: 'mqtt', topic: 'wallbox/set', payload: '{"amp":16}', retain: false },
};

const snap = (ts: number, projectedKw: number): LiveSnapshot => ({
  ts,
  connection: 'ok',
  power: { gridW: 0, loadW: null, pvW: null, batteryW: null, socPct: null },
  interval: {
    start: 0,
    end: 0,
    elapsedMs: 120_000,
    remainingMs: 0,
    importWh: 0,
    runningAvgKw: 0,
    committedKw: 0,
    projectedKw,
    completeness: 1,
    source: 'counter',
  },
  thresholdKw: 10,
  effectiveLimitKw: 10,
  monthPeak: null,
  state: 'safe',
  monthCostEur: 0,
  projectedExtraCostEur: 0,
});

function setup(rule: LoadShedRuleSettings, failHttp = false) {
  const settings: Settings = { ...DEFAULT_SETTINGS, loadShedding: [rule] };
  const calls: string[] = [];
  const records: string[] = [];
  const s = new LoadShedder({
    getSettings: () => settings,
    log: pino({ level: 'silent' }),
    record: (k, m) => {
      records.push(`${k}: ${m}`);
      return Promise.resolve();
    },
    fetch: ((url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return Promise.resolve(new Response('', { status: failHttp ? 503 : 200 }));
    }) as typeof fetch,
    mqttSend: (topic, payload) => {
      calls.push(`mqtt ${topic} ${payload}`);
      return Promise.resolve();
    },
  });
  return { s, calls, records, settings };
}

describe('LoadShedder', () => {
  it('sheds via webhook and restores via MQTT', async () => {
    const t = setup(wallbox);
    await t.s.evaluate(snap(0, 9.7));
    expect(t.calls).toEqual(['GET http://wallbox.local/api/set?amp=6']);
    expect(t.s.active).toEqual(['Wallbox']);
    await t.s.evaluate(snap(6 * 60_000, 7));
    expect(t.calls[1]).toBe('mqtt wallbox/set {"amp":16}');
    expect(t.s.active).toEqual([]);
    expect(t.records[0]).toMatch(
      /^load_shed: Wallbox: shed \(projected 9\.70 kW, target 10\.0 kW\)/,
    );
  });

  it('retries a failed shed and records the error', async () => {
    const t = setup(wallbox, true);
    await t.s.evaluate(snap(0, 9.9));
    expect(t.s.active).toEqual([]);
    expect(t.records[0]).toMatch(/load_shed_error: Wallbox: shed failed: HTTP 503/);
    await t.s.evaluate(snap(2_000, 9.9));
    expect(t.calls).toHaveLength(2);
  });

  it('restores everything on shutdown and when a hook is disabled', async () => {
    const t = setup(wallbox);
    await t.s.evaluate(snap(0, 10));
    await t.s.restoreAll();
    expect(t.calls.at(-1)).toMatch(/^mqtt wallbox\/set/);
    await t.s.evaluate(snap(10 * 60_000, 10));
    t.settings.loadShedding = [{ ...wallbox, enabled: false }];
    await t.s.evaluate(snap(11 * 60_000, 10));
    expect(t.s.active).toEqual([]);
  });
});
