import { collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import { kvGet } from '@peak-guard/db';
import type { App, RouteDeps } from './common.js';

const STATE = { safe: 0, warning: 1, over: 2 } as const;
const CONNECTION = { ok: 1, stale: 0.5, down: 0 } as const;

/** Prometheus metrics at /api/metrics (protected like the API, or via METRICS_TOKEN). */
export function metricsRoutes(app: App, { db, hub }: RouteDeps) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'peakguard_api_' });

  const http = new Histogram({
    name: 'peakguard_api_http_request_duration_seconds',
    help: 'API request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    if (route === '/api/live/stream') return; // long-lived
    http.observe(
      { method: req.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  const g = (
    name: string,
    help: string,
    read: (s: NonNullable<typeof hub.snapshot>) => number | null,
  ) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.reset();
        const s = hub.snapshot;
        const v = s ? read(s) : null;
        if (v != null && Number.isFinite(v)) this.set(v);
      },
    });

  g('peakguard_grid_power_watts', 'Grid power (+ import, − export)', (s) => s.power.gridW);
  g('peakguard_load_power_watts', 'House consumption', (s) => s.power.loadW);
  g('peakguard_pv_power_watts', 'PV production', (s) => s.power.pvW);
  g(
    'peakguard_battery_power_watts',
    'Battery power (+ discharge, − charge)',
    (s) => s.power.batteryW,
  );
  g('peakguard_battery_soc_percent', 'Battery state of charge', (s) => s.power.socPct);
  g(
    'peakguard_interval_projected_kw',
    'Projected average of the running quarter-hour (calibrated)',
    (s) => s.interval.projectedKw,
  );
  g(
    'peakguard_interval_committed_kw',
    'Energy of the running quarter-hour so far, as average kW',
    (s) => s.interval.committedKw,
  );
  g(
    'peakguard_interval_state',
    'Running quarter-hour state: 0 safe, 1 warning, 2 over',
    (s) => STATE[s.state],
  );
  g(
    'peakguard_month_peak_kw',
    'Highest quarter-hour of the month so far (calibrated)',
    (s) => s.monthPeak?.kw ?? 0,
  );
  g('peakguard_threshold_kw', 'Configured threshold', (s) => s.thresholdKw);
  g(
    'peakguard_effective_limit_kw',
    'max(threshold, minimum billed power)',
    (s) => s.effectiveLimitKw,
  );
  g(
    'peakguard_month_cost_eur',
    'Capacity charge of the month if it ended now',
    (s) => s.monthCostEur,
  );
  g(
    'peakguard_inverter_connection',
    'Inverter connection: 1 ok, 0.5 stale, 0 down',
    (s) => CONNECTION[s.connection],
  );
  g(
    'peakguard_snapshot_age_seconds',
    'Age of the latest live snapshot',
    (s) => (Date.now() - s.ts) / 1000,
  );
  new Gauge({
    name: 'peakguard_live_clients',
    help: 'Connected live-stream clients',
    registers: [registry],
    collect() {
      this.set(hub.clientCount);
    },
  });
  const heartbeat = new Gauge({
    name: 'peakguard_collector_heartbeat_age_seconds',
    help: 'Seconds since the collector last wrote samples',
    registers: [registry],
  });

  app.get(
    '/api/metrics',
    { schema: { tags: ['system'], description: 'Prometheus metrics', hide: true } },
    async (_req, reply) => {
      const hb = await kvGet<{ ts: number }>(db, 'collector.heartbeat').catch(() => null);
      heartbeat.reset();
      if (hb) heartbeat.set((Date.now() - hb.ts) / 1000);
      reply.type(registry.contentType);
      return registry.metrics();
    },
  );
}
