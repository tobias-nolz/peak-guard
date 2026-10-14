import { z } from 'zod';
import { inferCauses, intervalStart, type PeakCause } from '@peak-guard/core';
import { getSettings, intervalsBetween } from '@peak-guard/db';
import { analyzeRange } from '../analysis.js';
import { currentMonth, monthRange, summarizeMonth, summarizeYear } from '../month-summary.js';
import { autoResolution, flowsForIntervals, series } from '../queries.js';
import {
  errorSchema,
  intervalSchema,
  rangeQuery,
  seriesPointSchema,
  type App,
  type RouteDeps,
} from './common.js';

const monthParam = z.object({
  month: z.union([z.literal('current'), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)]),
});

export function historyRoutes(app: App, { db, sql, env }: RouteDeps) {
  const tz = env.TIME_ZONE;

  app.get(
    '/api/intervals',
    {
      schema: {
        tags: ['history'],
        description: 'Closed 15-min intervals in [from, to). Raw meter values (no calibration).',
        querystring: rangeQuery,
        response: { 200: z.array(intervalSchema), 400: errorSchema },
      },
    },
    async (req) => intervalsBetween(db, req.query.from, req.query.to),
  );

  app.get(
    '/api/series',
    {
      schema: {
        tags: ['history'],
        description:
          'Power time series [ts, gridW, loadW, pvW, batteryW, socPct]. Resolution: raw (10 s) ≤ 6 h, 1 min ≤ 8 days, else 15 min, unless given.',
        querystring: rangeQuery.and(
          z.object({
            resolution: z.coerce
              .number()
              .int()
              .pipe(z.union([z.literal(10), z.literal(60), z.literal(900)]))
              .optional(),
          }),
        ),
        response: {
          200: z.object({ resolutionS: z.number(), points: z.array(seriesPointSchema) }),
          400: errorSchema,
        },
      },
    },
    async (req) => {
      const { from, to } = req.query;
      const resolutionS = req.query.resolution ?? autoResolution(to - from);
      return { resolutionS, points: await series(sql, from, to, resolutionS) };
    },
  );

  app.get(
    '/api/months/:month',
    {
      schema: {
        tags: ['history'],
        description:
          'Monthly peak analysis (calibrated): peak, billed power, cost, daily peaks and the top-N quarter-hours with likely causes. Use "current" for the current month.',
        params: monthParam,
        querystring: z.object({ top: z.coerce.number().int().min(1).max(100).default(10) }),
      },
    },
    async (req) => {
      const month =
        req.params.month === 'current' ? currentMonth(Date.now(), tz) : req.params.month;
      const { from, to } = monthRange(month, tz);
      const [rows, settings] = await Promise.all([intervalsBetween(db, from, to), getSettings(db)]);
      const summary = summarizeMonth(month, rows, settings, tz, req.query.top);
      const flows = await flowsForIntervals(
        sql,
        summary.top.map((t) => intervalStart(t.start)),
      );
      const kw = (w: number | null) => (w == null ? null : w / 1000);
      return {
        ...summary,
        top: summary.top.map((t) => {
          const a = inferCauses(flows.get(t.start) ?? [], {
            batteryMaxW:
              settings.battery.maxPowerKw == null ? null : settings.battery.maxPowerKw * 1000,
            minSocPct: settings.battery.minSocPct,
          });
          return {
            ...t,
            causes: a?.causes ?? ([] as PeakCause[]),
            flows: a
              ? {
                  avgLoadKw: kw(a.avgLoadW),
                  avgPvKw: kw(a.avgPvW),
                  avgBatteryKw: kw(a.avgBatteryW),
                  socStart: a.socStart,
                  socEnd: a.socEnd,
                  sustainedMinutes: a.sustainedMinutes,
                }
              : null,
          };
        }),
      };
    },
  );

  app.get(
    '/api/years/:year',
    {
      schema: {
        tags: ['history'],
        description: 'Monthly peaks and capacity charges of a year (calibrated).',
        params: z.object({ year: z.coerce.number().int().min(2000).max(2100) }),
      },
    },
    async (req) => {
      const year = req.params.year;
      const from = monthRange(`${year}-01`, tz).from;
      const to = monthRange(`${year}-12`, tz).to;
      const [rows, settings] = await Promise.all([intervalsBetween(db, from, to), getSettings(db)]);
      return summarizeYear(year, rows, settings, tz);
    },
  );

  app.get(
    '/api/analysis',
    {
      schema: {
        tags: ['history'],
        description:
          'Distribution of quarter-hour powers in [from, to): weekday×hour heatmap, histogram, duration curve and percentiles (calibrated).',
        querystring: rangeQuery.and(
          z.object({
            agg: z.enum(['max', 'avg']).default('max'),
            bin: z.coerce.number().min(0.05).max(10).default(0.5),
          }),
        ),
      },
    },
    async (req) => {
      const { from, to, agg, bin } = req.query;
      const [rows, settings] = await Promise.all([intervalsBetween(db, from, to), getSettings(db)]);
      return analyzeRange(rows, settings, tz, agg, bin);
    },
  );
}
