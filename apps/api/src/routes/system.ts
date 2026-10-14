import { z } from 'zod';
import { kvGet, ping, recentEvents } from '@peak-guard/db';
import type { App, RouteDeps } from './common.js';

export function systemRoutes(app: App, { db, hub, env }: RouteDeps) {
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
    '/api/config',
    {
      schema: {
        tags: ['system'],
        description: 'Static configuration the UI needs (time zone).',
        response: { 200: z.object({ timeZone: z.string() }) },
      },
    },
    () => ({ timeZone: env.TIME_ZONE }),
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
}
