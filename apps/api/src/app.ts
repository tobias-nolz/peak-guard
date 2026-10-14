import Fastify, { type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { zonedToEpoch } from '@peak-guard/core';
import {
  getSettings,
  intervalsBetween,
  kvGet,
  ping,
  recentEvents,
  saveSettings,
  type Db,
  type Sql,
} from '@peak-guard/db';
import { liveSnapshotSchema, settingsSchema } from '@peak-guard/shared';
import type { ApiEnv } from './config.js';
import { SETTINGS_CHANNEL, type LiveHub } from './live-hub.js';
import { currentMonth, parseMonth, summarizeMonth } from './month-summary.js';

export interface AppDeps {
  env: ApiEnv;
  db: Db;
  sql: Sql;
  hub: LiveHub;
  logger?: FastifyServerOptions['logger'];
}

const isoOrEpoch = z
  .union([z.coerce.number(), z.iso.datetime({ offset: true })])
  .transform((v) => (typeof v === 'number' ? v : Date.parse(v)));

const intervalSchema = z.object({
  start: z.number(),
  importWh: z.number().nullable(),
  exportWh: z.number().nullable(),
  avgImportKw: z.number().nullable(),
  avgExportKw: z.number().nullable(),
  completeness: z.number(),
  quality: z.enum(['exact', 'estimated', 'partial', 'missing']),
  source: z.enum(['counter', 'integrated', 'none']),
  sampleCount: z.number(),
  maxImportW: z.number().nullable(),
});

const errorSchema = z.object({ error: z.string() });

const MAX_RANGE_MS = 400 * 86_400_000;

export async function buildApp(deps: AppDeps) {
  const { db, sql, hub, env } = deps;
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Peak Guard API',
        version: '0.1.0',
        description: '15-minute peak monitoring and shaving',
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.get(
    '/api/health',
    {
      schema: {
        tags: ['system'],
        response: {
          200: z.object({
            ok: z.boolean(),
            db: z.boolean(),
            collectorHeartbeatAgeMs: z.number().nullable(),
            liveClients: z.number(),
          }),
        },
      },
    },
    async () => {
      let dbOk = true;
      let heartbeat: { ts: number } | null = null;
      try {
        await ping(db);
        heartbeat = await kvGet<{ ts: number }>(db, 'collector.heartbeat');
      } catch {
        dbOk = false;
      }
      return {
        ok: dbOk,
        db: dbOk,
        collectorHeartbeatAgeMs: heartbeat ? Date.now() - heartbeat.ts : null,
        liveClients: hub.clientCount,
      };
    },
  );

  app.get(
    '/api/live',
    {
      schema: {
        tags: ['live'],
        description: 'Latest live snapshot',
        response: { 200: liveSnapshotSchema, 204: z.null() },
      },
    },
    async (_req, reply) => {
      const s = hub.snapshot;
      if (!s) return reply.code(204).send(null);
      return s;
    },
  );

  app.get(
    '/api/live/stream',
    {
      schema: {
        tags: ['live'],
        description: 'Server-Sent Events stream of live snapshots (event: snapshot)',
      },
    },
    (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (data: unknown) =>
        res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
      if (hub.snapshot) send(hub.snapshot);
      const unsubscribe = hub.subscribe(send);
      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      req.raw.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    },
  );

  app.get(
    '/api/settings',
    { schema: { tags: ['settings'], response: { 200: settingsSchema } } },
    async () => getSettings(db),
  );

  app.put(
    '/api/settings',
    { schema: { tags: ['settings'], body: settingsSchema, response: { 200: settingsSchema } } },
    async (req) => {
      const actor = (req.headers['remote-user'] as string | undefined) ?? 'local';
      await saveSettings(db, req.body, actor);
      await sql.notify(SETTINGS_CHANNEL, '');
      return req.body;
    },
  );

  app.get(
    '/api/intervals',
    {
      schema: {
        tags: ['history'],
        description: 'Closed 15-min intervals in [from, to). Raw meter values (no calibration).',
        querystring: z.object({ from: isoOrEpoch, to: isoOrEpoch }),
        response: { 200: z.array(intervalSchema), 400: errorSchema },
      },
    },
    async (req, reply) => {
      const { from, to } = req.query;
      if (!(to > from) || to - from > MAX_RANGE_MS)
        return reply.code(400).send({ error: 'invalid range' });
      return intervalsBetween(db, from, to);
    },
  );

  app.get(
    '/api/months/:month',
    {
      schema: {
        tags: ['history'],
        description: 'Monthly peak analysis (calibrated). Use "current" for the current month.',
        params: z.object({ month: z.string() }),
        querystring: z.object({ top: z.coerce.number().int().min(1).max(100).default(10) }),
      },
    },
    async (req, reply) => {
      const month =
        req.params.month === 'current' ? currentMonth(Date.now(), env.TIME_ZONE) : req.params.month;
      let ym: { year: number; month: number };
      try {
        ym = parseMonth(month);
      } catch {
        return reply.code(400).send({ error: 'month must be YYYY-MM or "current"' });
      }
      const from = zonedToEpoch(ym.year, ym.month, 1, 0, 0, env.TIME_ZONE);
      const to = zonedToEpoch(
        ym.month === 12 ? ym.year + 1 : ym.year,
        ym.month === 12 ? 1 : ym.month + 1,
        1,
        0,
        0,
        env.TIME_ZONE,
      );
      const [rows, settings] = await Promise.all([intervalsBetween(db, from, to), getSettings(db)]);
      return summarizeMonth(month, rows, settings, env.TIME_ZONE, req.query.top);
    },
  );

  app.get(
    '/api/series',
    {
      schema: {
        tags: ['history'],
        description:
          'Power time series with automatic resolution (raw ≤ 6 h, 1 min ≤ 8 days, else 15 min).',
        querystring: z.object({ from: isoOrEpoch, to: isoOrEpoch }),
        response: {
          400: errorSchema,
          200: z.object({
            resolutionS: z.number(),
            points: z.array(
              z.tuple([
                z.number(),
                z.number().nullable(),
                z.number().nullable(),
                z.number().nullable(),
                z.number().nullable(),
                z.number().nullable(),
              ]),
            ),
          }),
        },
      },
    },
    async (req, reply) => {
      const { from, to } = req.query;
      if (!(to > from) || to - from > MAX_RANGE_MS)
        return reply.code(400).send({ error: 'invalid range' });
      const span = to - from;
      // ISO strings: Drizzle replaces postgres.js' Date serializers on the shared client.
      const f = new Date(from).toISOString();
      const t = new Date(to).toISOString();
      type Row = {
        ts: Date | string;
        grid: number | null;
        load: number | null;
        pv: number | null;
        bat: number | null;
        soc: number | null;
      };
      let rows: Row[];
      let resolutionS: number;
      if (span <= 6 * 3_600_000) {
        resolutionS = 10;
        rows = await sql<Row[]>`
          SELECT time_bucket('10 seconds', ts) AS ts, avg(grid_w) AS grid, avg(load_w) AS load, avg(pv_w) AS pv,
                 avg(battery_w) AS bat, last(soc_pct, ts) AS soc
          FROM samples WHERE ts >= ${f} AND ts < ${t} GROUP BY 1 ORDER BY 1`;
      } else {
        resolutionS = span <= 8 * 86_400_000 ? 60 : 900;
        rows = await sql<Row[]>`
          SELECT time_bucket(${`${resolutionS} seconds`}::interval, bucket) AS ts, avg(grid_w_avg) AS grid,
                 avg(load_w_avg) AS load, avg(pv_w_avg) AS pv, avg(battery_w_avg) AS bat, last(soc_pct, bucket) AS soc
          FROM samples_1m WHERE bucket >= ${f} AND bucket < ${t} GROUP BY 1 ORDER BY 1`;
      }
      const n = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
      return {
        resolutionS,
        points: rows.map(
          (r) =>
            [new Date(r.ts).getTime(), n(r.grid), n(r.load), n(r.pv), n(r.bat), n(r.soc)] as [
              number,
              number | null,
              number | null,
              number | null,
              number | null,
              number | null,
            ],
        ),
      };
    },
  );

  app.get(
    '/api/events',
    {
      schema: {
        tags: ['system'],
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
      },
    },
    async (req) => {
      const rows = await recentEvents(db, req.query.limit);
      return rows.map((r) => ({ ...r, ts: r.ts.getTime() }));
    },
  );

  return app;
}
