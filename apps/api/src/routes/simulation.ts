import { z } from 'zod';
import { getSettings, intervalsBetween } from '@peak-guard/db';
import { MAX_RANGE_MS, type App, type RouteDeps } from './common.js';
import { summarizeYear } from '../month-summary.js';
import { series } from '../queries.js';
import { runSimulation, simulationRequestSchema, toNetPoints } from '../simulation.js';
import { localParts } from '@peak-guard/core';

export function simulationRoutes(app: App, { db, sql, env }: RouteDeps) {
  app.post(
    '/api/simulation',
    {
      schema: {
        tags: ['simulation'],
        description:
          'Replay the 1-minute history in [from, to) against a battery and peak-shaving strategy. Returns the ' +
          'measured peaks, baselines without battery and with plain self-consumption, the scenario and an ' +
          'optional threshold × reserve × capacity sweep (≤ 64 runs) with average monthly costs and savings.',
        body: simulationRequestSchema.refine(
          (r) => r.to > r.from && r.to - r.from <= MAX_RANGE_MS,
          {
            message: 'to must be after from and the range at most 400 days',
          },
        ),
      },
    },
    async (req, reply) => {
      const b = req.body;
      if (
        b.sweep &&
        b.sweep.thresholdsKw.length * b.sweep.reservesPct.length * b.sweep.capacitiesKwh.length > 64
      ) {
        return reply.code(400).send({ error: 'sweep too large (max 64 combinations)' });
      }
      const [settings, rows, pts] = await Promise.all([
        getSettings(db),
        intervalsBetween(db, b.from, b.to),
        series(sql, b.from, b.to, 60),
      ]);
      const points = toNetPoints(pts);
      if (points.length < 60)
        return reply.code(400).send({ error: 'not enough data in the selected range' });
      const result = await runSimulation(points, b, settings, env.TIME_ZONE);
      // Measured peaks for comparison (calibrated), per month of the range.
      const years = [...new Set(rows.map((r) => localParts(r.start, env.TIME_ZONE).year))];
      const actual = years
        .flatMap((y) => summarizeYear(y, rows, settings, env.TIME_ZONE).months)
        .filter((m) => m.intervalCount > 0)
        .map((m) => ({ month: m.month, peakKw: m.peakKw ?? 0, costEur: m.costEur ?? 0 }));
      return { ...result, actual };
    },
  );

  app.get(
    '/api/simulation/defaults',
    {
      schema: {
        tags: ['simulation'],
        description: 'Suggested simulation inputs from the settings.',
        response: {
          200: z.object({
            thresholdKw: z.number(),
            capacityKwh: z.number(),
            maxPowerKw: z.number(),
            minSocPct: z.number(),
          }),
        },
      },
    },
    async () => {
      const s = await getSettings(db);
      return {
        thresholdKw: s.thresholdKw,
        capacityKwh: s.battery.capacityKwh ?? 10,
        maxPowerKw: s.battery.maxPowerKw ?? 5,
        minSocPct: s.battery.minSocPct,
      };
    },
  );
}
