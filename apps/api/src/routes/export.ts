import { z } from 'zod';
import { intervalsBetween, getSettings } from '@peak-guard/db';
import { localTimestamp, toCsv } from '../csv.js';
import { series } from '../queries.js';
import { rangeQuery, type App, type RouteDeps } from './common.js';

const formatQuery = z.object({ format: z.enum(['csv', 'json']).default('csv') });

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export function exportRoutes(app: App, { db, sql, env }: RouteDeps) {
  const tz = env.TIME_ZONE;

  app.get(
    '/api/export/intervals',
    {
      schema: {
        tags: ['export'],
        description: 'Quarter-hours in [from, to) as CSV or JSON (raw and calibrated kW).',
        querystring: rangeQuery.and(formatQuery),
      },
    },
    async (req, reply) => {
      const { from, to, format } = req.query;
      const [rows, settings] = await Promise.all([intervalsBetween(db, from, to), getSettings(db)]);
      const cal = settings.calibrationFactor;
      const name = `peak-guard-intervals_${stamp(from)}_${stamp(to)}.${format}`;
      reply.header('content-disposition', `attachment; filename="${name}"`);
      if (format === 'json') {
        return rows.map((r) => ({
          ...r,
          startIso: new Date(r.start).toISOString(),
          startLocal: localTimestamp(r.start, tz),
          avgImportKwCalibrated: r.avgImportKw == null ? null : r.avgImportKw * cal,
        }));
      }
      reply.type('text/csv; charset=utf-8');
      return toCsv(
        [
          'start_utc',
          'start_local',
          'avg_import_kw',
          'avg_import_kw_calibrated',
          'import_kwh',
          'export_kwh',
          'max_import_kw',
          'quality',
          'source',
          'completeness',
        ],
        rows.map((r) => [
          new Date(r.start).toISOString(),
          localTimestamp(r.start, tz),
          r.avgImportKw?.toFixed(4),
          r.avgImportKw == null ? null : (r.avgImportKw * cal).toFixed(4),
          r.importWh == null ? null : (r.importWh / 1000).toFixed(4),
          r.exportWh == null ? null : (r.exportWh / 1000).toFixed(4),
          r.maxImportW == null ? null : (r.maxImportW / 1000).toFixed(3),
          r.quality,
          r.source,
          r.completeness.toFixed(3),
        ]),
      );
    },
  );

  app.get(
    '/api/export/series',
    {
      schema: {
        tags: ['export'],
        description:
          'Power time series in [from, to) at 1-minute (default) or 15-minute resolution.',
        querystring: rangeQuery.and(formatQuery).and(
          z.object({
            resolution: z.coerce
              .number()
              .int()
              .pipe(z.union([z.literal(60), z.literal(900)]))
              .default(60),
          }),
        ),
      },
    },
    async (req, reply) => {
      const { from, to, format, resolution } = req.query;
      const points = await series(sql, from, to, resolution);
      const name = `peak-guard-power_${stamp(from)}_${stamp(to)}.${format}`;
      reply.header('content-disposition', `attachment; filename="${name}"`);
      if (format === 'json') return { resolutionS: resolution, points };
      reply.type('text/csv; charset=utf-8');
      return toCsv(
        ['ts_utc', 'ts_local', 'grid_w', 'load_w', 'pv_w', 'battery_w', 'soc_pct'],
        points.map(([ts, ...rest]) => [
          new Date(ts).toISOString(),
          localTimestamp(ts, tz),
          ...rest,
        ]),
      );
    },
  );
}
