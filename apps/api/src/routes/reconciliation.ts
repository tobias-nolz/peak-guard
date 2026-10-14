import { z } from 'zod';
import {
  billingIntervalsBetween,
  deleteImportBatch,
  importBillingIntervals,
  intervalsBetween,
  listImportBatches,
  addEvent,
} from '@peak-guard/db';
import { detectAlignment, parseMeterCsv, toIntervalStarts } from '../import/meter-csv.js';
import { reconcile } from '../reconcile.js';
import { errorSchema, rangeQuery, type App, type RouteDeps } from './common.js';

export function reconciliationRoutes(app: App, { db, env }: RouteDeps) {
  // Raw CSV uploads (the browser sends the file content as the body).
  app.addContentTypeParser(
    ['text/csv', 'text/plain'],
    { parseAs: 'string', bodyLimit: 20 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.post(
    '/api/reconciliation/import',
    {
      schema: {
        tags: ['reconciliation'],
        description:
          'Import a smart-meter portal CSV export (body: file content, content-type text/csv). Columns are auto-detected; ' +
          'alignment=auto decides whether timestamps mark interval start or end by matching own measurements.',
        querystring: z.object({
          filename: z.string().max(200).default('upload.csv'),
          alignment: z.enum(['auto', 'start', 'end']).default('auto'),
        }),
        body: z.string().min(1),
        response: {
          200: z.object({
            batchId: z.number(),
            rows: z.number(),
            from: z.number(),
            to: z.number(),
            alignment: z.enum(['start', 'end']),
            columns: z.object({ time: z.string(), value: z.string(), unit: z.string() }),
            warnings: z.array(z.string()),
          }),
          400: errorSchema,
        },
      },
    },
    async (req, reply) => {
      let parsed;
      try {
        parsed = parseMeterCsv(req.body);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      let alignment =
        parsed.alignment ?? (req.query.alignment === 'auto' ? null : req.query.alignment);
      if (alignment == null) {
        const first = parsed.rows[0]!.ts - 3_600_000;
        const last = parsed.rows.at(-1)!.ts + 3_600_000;
        const own = await intervalsBetween(db, first, last);
        alignment = detectAlignment(
          parsed.rows,
          new Map(own.filter((o) => o.importWh != null).map((o) => [o.start, o.importWh!])),
        );
      }
      const rows = toIntervalStarts(parsed.rows, alignment).map((r) => ({
        start: r.start,
        importWh: r.wh,
        status: r.status,
      }));
      const actor = (req.headers['remote-user'] as string | undefined) ?? 'local';
      const { batchId, from, to } = await importBillingIntervals(
        db,
        { filename: req.query.filename, actor, alignment },
        rows,
      );
      await addEvent(
        db,
        'import',
        `Imported ${rows.length} billing-meter quarter-hours from ${req.query.filename}`,
        {
          batchId,
          alignment,
        },
      );
      return {
        batchId,
        rows: rows.length,
        from,
        to,
        alignment,
        columns: parsed.columns,
        warnings: parsed.warnings,
      };
    },
  );

  app.get('/api/reconciliation/batches', { schema: { tags: ['reconciliation'] } }, () =>
    listImportBatches(db),
  );

  app.delete(
    '/api/reconciliation/batches/:id',
    {
      schema: {
        tags: ['reconciliation'],
        params: z.object({ id: z.coerce.number().int() }),
        response: { 204: z.null(), 404: errorSchema },
      },
    },
    async (req, reply) => {
      if (!(await deleteImportBatch(db, req.params.id)))
        return reply.code(404).send({ error: 'batch not found' });
      return reply.code(204).send(null);
    },
  );

  app.get(
    '/api/reconciliation',
    {
      schema: {
        tags: ['reconciliation'],
        description:
          'Compare own (raw) quarter-hours with the imported billing-meter values in [from, to).',
        querystring: rangeQuery,
      },
    },
    async (req) => {
      const { from, to } = req.query;
      const [own, official] = await Promise.all([
        intervalsBetween(db, from, to),
        billingIntervalsBetween(db, from, to),
      ]);
      return reconcile(own, official, env.TIME_ZONE);
    },
  );
}
