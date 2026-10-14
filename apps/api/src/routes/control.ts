import { z } from 'zod';
import { monthlyCost, tariffFor } from '@peak-guard/core';
import {
  addEvent,
  decisionsBetween,
  getSettings,
  intervalsBetween,
  kvGet,
  saveSettings,
} from '@peak-guard/db';
import { controlSchema } from '@peak-guard/shared';
import { activeBlockedReason, dryRunEstimate, type ControlStatus } from '../control.js';
import { SETTINGS_CHANNEL } from '../live-hub.js';
import { currentMonth, monthRange } from '../month-summary.js';
import { errorSchema, rangeQuery, type App, type RouteDeps } from './common.js';

export const CONTROL_COMMAND_CHANNEL = 'control_command';

export function controlRoutes(app: App, { db, sql, env }: RouteDeps) {
  const status = () => kvGet<ControlStatus>(db, 'control.status');

  app.get(
    '/api/control/status',
    {
      schema: {
        tags: ['control'],
        description: 'Controller status from the collector, plus the control settings.',
      },
    },
    async () => {
      const [s, settings] = await Promise.all([status(), getSettings(db)]);
      return { status: s, statusAgeMs: s ? Date.now() - s.ts : null, settings: settings.control };
    },
  );

  app.put(
    '/api/control',
    {
      schema: {
        tags: ['control'],
        description:
          'Update the control settings. Switching to active is gated (see activeBlockedReason).',
        body: controlSchema,
        response: { 200: controlSchema, 409: errorSchema },
      },
    },
    async (req, reply) => {
      const blocked = activeBlockedReason(req.body, await status());
      if (blocked) return reply.code(409).send({ error: blocked });
      const settings = await getSettings(db);
      await saveSettings(db, { ...settings, control: req.body }, req.user ?? 'unknown');
      await sql.notify(SETTINGS_CHANNEL, '');
      if (req.body.mode !== settings.control.mode) {
        await addEvent(
          db,
          'control_mode',
          `Control mode ${settings.control.mode} → ${req.body.mode}`,
          { actor: req.user },
        );
      }
      return req.body;
    },
  );

  app.post(
    '/api/control/revert-test',
    {
      schema: {
        tags: ['control'],
        description:
          'Ask the collector to run the revert self-test (harmless 100 % discharge limit with a 60 s revert timeout, then watch for the inverter to revert).',
        response: { 202: z.object({ requested: z.boolean() }), 409: errorSchema },
      },
    },
    async (req, reply) => {
      const s = await status();
      if (!s || Date.now() - s.ts > 60_000)
        return reply.code(409).send({ error: 'collector status unavailable' });
      if (!s.writesEnabled)
        return reply
          .code(409)
          .send({ error: 'writes are disabled (CONTROL_WRITES_ENABLED=false)' });
      if (s.modbus.state !== 'ok')
        return reply.code(409).send({ error: `Modbus is not available (${s.modbus.state})` });
      if (s.revertTest?.status === 'running')
        return reply.code(409).send({ error: 'a revert test is already running' });
      await sql.notify(
        CONTROL_COMMAND_CHANNEL,
        JSON.stringify({ type: 'revertTest', revertS: 60, actor: req.user }),
      );
      await addEvent(db, 'revert_test', 'Revert self-test requested', { actor: req.user });
      return reply.code(202).send({ requested: true });
    },
  );

  app.post(
    '/api/control/pause',
    {
      schema: {
        tags: ['control'],
        description:
          'Pause active control for some minutes (the inverter runs its own mode), or resume with minutes = 0.',
        body: z.object({
          minutes: z
            .number()
            .int()
            .min(0)
            .max(24 * 60),
        }),
        response: { 202: z.object({ requested: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const m = req.body.minutes;
      await sql.notify(
        CONTROL_COMMAND_CHANNEL,
        JSON.stringify(m > 0 ? { type: 'pause', minutes: m } : { type: 'resume' }),
      );
      await addEvent(
        db,
        'control_pause',
        m > 0 ? `Pause for ${m} min requested` : 'Resume requested',
        { actor: req.user },
      );
      return reply.code(202).send({ requested: true });
    },
  );

  app.post(
    '/api/control/clear-fault',
    {
      schema: {
        tags: ['control'],
        description: 'Clear a latched controller fault.',
        response: { 202: z.object({ requested: z.boolean() }) },
      },
    },
    async (req, reply) => {
      await sql.notify(CONTROL_COMMAND_CHANNEL, JSON.stringify({ type: 'clearFault' }));
      await addEvent(db, 'control_fault', 'Fault reset requested', { actor: req.user });
      return reply.code(202).send({ requested: true });
    },
  );

  app.get(
    '/api/control/decisions',
    {
      schema: {
        tags: ['control'],
        description: 'Logged controller decisions in [from, to) (at most 5000).',
        querystring: rangeQuery,
      },
    },
    async (req) => decisionsBetween(db, req.query.from, req.query.to),
  );

  app.get(
    '/api/control/summary/:month',
    {
      schema: {
        tags: ['control'],
        description:
          'Dry-run estimate for a month: measured peak vs. the peak with the logged shave decisions applied.',
        params: z.object({
          month: z.union([z.literal('current'), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)]),
        }),
      },
    },
    async (req) => {
      const month =
        req.params.month === 'current' ? currentMonth(Date.now(), env.TIME_ZONE) : req.params.month;
      const { from, to } = monthRange(month, env.TIME_ZONE);
      const [settings, intervals, decisions] = await Promise.all([
        getSettings(db),
        intervalsBetween(db, from, to),
        decisionsBetween(db, from, to, 200_000),
      ]);
      const est = dryRunEstimate(intervals, decisions, settings.calibrationFactor);
      const tariff = tariffFor(`${month}-01`, settings.tariffs);
      const actualPeak = Math.max(0, ...est.map((e) => e.actualKw));
      const predictedPeak = Math.max(0, ...est.map((e) => e.predictedKw));
      const shaved = est.filter((e) => e.shaveWh > 0);
      return {
        month,
        decisions: decisions.length,
        shaveIntervals: shaved.length,
        shaveKwh: shaved.reduce((s, e) => s + e.shaveWh / 1000, 0),
        actualPeakKw: actualPeak,
        predictedPeakKw: predictedPeak,
        actualCostEur: monthlyCost(actualPeak, tariff),
        predictedCostEur: monthlyCost(predictedPeak, tariff),
        savingEur: monthlyCost(actualPeak, tariff) - monthlyCost(predictedPeak, tariff),
        top: [...shaved].sort((a, b) => b.actualKw - a.actualKw).slice(0, 10),
      };
    },
  );
}
