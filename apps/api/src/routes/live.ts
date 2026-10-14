import { z } from 'zod';
import { liveSnapshotSchema } from '@peak-guard/shared';
import type { App, RouteDeps } from './common.js';

export function liveRoutes(app: App, { hub }: RouteDeps) {
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
}
