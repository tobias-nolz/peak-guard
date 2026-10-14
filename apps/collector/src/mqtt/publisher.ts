import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import type { Logger } from 'pino';
import type { LiveSnapshot } from '@peak-guard/shared';

export interface MqttConfig {
  url: string;
  /** Base topic, e.g. "peakguard". */
  prefix: string;
  /** Home Assistant discovery prefix; empty disables discovery. */
  discoveryPrefix: string;
  /** Minimum time between state publications. */
  intervalMs: number;
}

/** Flat state published as JSON to `<prefix>/state` (retained). */
export function stateFromSnapshot(s: LiveSnapshot) {
  const r = (v: number | null | undefined, d = 3) =>
    v == null ? null : Math.round(v * 10 ** d) / 10 ** d;
  return {
    ts: new Date(s.ts).toISOString(),
    connection: s.connection,
    grid_power_w: r(s.power.gridW, 0),
    load_power_w: r(s.power.loadW, 0),
    pv_power_w: r(s.power.pvW, 0),
    battery_power_w: r(s.power.batteryW, 0),
    battery_soc: r(s.power.socPct, 1),
    interval_start: new Date(s.interval.start).toISOString(),
    interval_projected_kw: r(s.interval.projectedKw),
    interval_committed_kw: r(s.interval.committedKw),
    interval_state: s.state,
    threshold_kw: r(s.thresholdKw),
    effective_limit_kw: r(s.effectiveLimitKw),
    month_peak_kw: r(s.monthPeak?.kw ?? 0),
    month_cost_eur: r(s.monthCostEur, 2),
    control_mode: s.control?.mode ?? 'off',
    control_decision: s.control?.decision ?? null,
    control_limit_w: r(s.control?.limitW, 0),
  };
}

type Key = keyof ReturnType<typeof stateFromSnapshot>;

/** Home Assistant sensors: [key, name, unit, device_class, state_class, icon] */
const SENSORS: [Key, string, string | null, string | null, string | null, string | null][] = [
  ['grid_power_w', 'Grid power', 'W', 'power', 'measurement', null],
  ['load_power_w', 'House consumption', 'W', 'power', 'measurement', null],
  ['pv_power_w', 'PV power', 'W', 'power', 'measurement', null],
  ['battery_power_w', 'Battery power', 'W', 'power', 'measurement', null],
  ['battery_soc', 'Battery SoC', '%', 'battery', 'measurement', null],
  [
    'interval_projected_kw',
    'Quarter-hour projection',
    'kW',
    'power',
    'measurement',
    'mdi:chart-timeline-variant',
  ],
  ['interval_committed_kw', 'Quarter-hour so far', 'kW', 'power', 'measurement', null],
  ['interval_state', 'Quarter-hour state', null, null, null, 'mdi:traffic-light'],
  ['month_peak_kw', 'Month peak', 'kW', 'power', null, 'mdi:summit'],
  ['threshold_kw', 'Peak threshold', 'kW', 'power', null, 'mdi:target'],
  ['effective_limit_kw', 'Effective limit', 'kW', 'power', null, 'mdi:target'],
  ['month_cost_eur', 'Capacity charge (month)', 'EUR', 'monetary', null, null],
  ['control_mode', 'Control mode', null, null, null, 'mdi:battery-charging'],
  ['control_decision', 'Control decision', null, null, null, 'mdi:battery-sync'],
  ['control_limit_w', 'Discharge limit', 'W', 'power', 'measurement', null],
  ['connection', 'Inverter connection', null, null, null, 'mdi:lan-connect'],
];

/** Home Assistant MQTT discovery messages (topic → retained payload). */
export function discoveryMessages(cfg: MqttConfig): [string, string][] {
  const device = {
    identifiers: ['peak_guard'],
    name: 'Peak Guard',
    manufacturer: 'Peak Guard',
    model: '15-minute peak monitor',
  };
  return SENSORS.map(([key, name, unit, deviceClass, stateClass, icon]) => [
    `${cfg.discoveryPrefix}/sensor/peak_guard/${key}/config`,
    JSON.stringify({
      name,
      unique_id: `peak_guard_${key}`,
      object_id: `peak_guard_${key}`,
      state_topic: `${cfg.prefix}/state`,
      value_template: `{{ value_json.${key} }}`,
      availability_topic: `${cfg.prefix}/status`,
      device,
      ...(unit ? { unit_of_measurement: unit } : {}),
      ...(deviceClass ? { device_class: deviceClass } : {}),
      ...(stateClass ? { state_class: stateClass } : {}),
      ...(icon ? { icon } : {}),
    }),
  ]);
}

/** Publishes live state (throttled) and Home Assistant discovery to an MQTT broker. */
export class MqttPublisher {
  private client: MqttClient | null = null;
  private lastPublish = 0;

  constructor(
    private readonly cfg: MqttConfig,
    private readonly log: Logger,
  ) {}

  start(extra: IClientOptions = {}): void {
    const status = `${this.cfg.prefix}/status`;
    this.client = connect(this.cfg.url, {
      clientId: `peak-guard-${Math.random().toString(16).slice(2, 8)}`,
      will: { topic: status, payload: Buffer.from('offline'), retain: true, qos: 1 },
      reconnectPeriod: 5_000,
      ...extra,
    });
    this.client.on('connect', () => {
      this.log.info({ url: redact(this.cfg.url) }, 'MQTT connected');
      this.client!.publish(status, 'online', { retain: true, qos: 1 });
      if (this.cfg.discoveryPrefix) {
        for (const [topic, payload] of discoveryMessages(this.cfg))
          this.client!.publish(topic, payload, { retain: true, qos: 1 });
      }
    });
    this.client.on('error', (err) => this.log.warn({ err: err.message }, 'MQTT error'));
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** Publish the snapshot if connected and not throttled. */
  publish(s: LiveSnapshot, now = Date.now()): void {
    if (!this.client?.connected || now - this.lastPublish < this.cfg.intervalMs) return;
    this.lastPublish = now;
    this.client.publish(`${this.cfg.prefix}/state`, JSON.stringify(stateFromSnapshot(s)), {
      retain: true,
      qos: 0,
    });
  }

  /** Publish an arbitrary message (used by load-shedding actions). */
  async send(topic: string, payload: string, retain = false): Promise<void> {
    if (!this.client?.connected) throw new Error('MQTT not connected');
    await this.client.publishAsync(topic, payload, { retain, qos: 1 });
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    if (this.client.connected)
      await this.client.publishAsync(`${this.cfg.prefix}/status`, 'offline', {
        retain: true,
        qos: 1,
      });
    await this.client.endAsync();
  }
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}
