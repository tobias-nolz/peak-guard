import { getSettings, kvGet, saveSettings } from '@peak-guard/db';
import { settingsSchema } from '@peak-guard/shared';
import { activeBlockedReason, type ControlStatus } from '../control.js';
import { SETTINGS_CHANNEL } from '../live-hub.js';
import { errorSchema, type App, type RouteDeps } from './common.js';

export function settingsRoutes(app: App, { db, sql }: RouteDeps) {
  app.get(
    '/api/settings',
    { schema: { tags: ['settings'], response: { 200: settingsSchema } } },
    async () => getSettings(db),
  );

  app.put(
    '/api/settings',
    {
      schema: {
        tags: ['settings'],
        body: settingsSchema,
        response: { 200: settingsSchema, 409: errorSchema },
      },
    },
    async (req, reply) => {
      // The general settings endpoint must not bypass the Active gate.
      const blocked = activeBlockedReason(
        req.body.control,
        await kvGet<ControlStatus>(db, 'control.status'),
      );
      if (blocked) return reply.code(409).send({ error: blocked });
      await saveSettings(db, req.body, req.user ?? 'unknown');
      await sql.notify(SETTINGS_CHANNEL, '');
      return req.body;
    },
  );
}
