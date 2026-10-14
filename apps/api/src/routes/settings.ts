import { getSettings, saveSettings } from '@peak-guard/db';
import { settingsSchema } from '@peak-guard/shared';
import { SETTINGS_CHANNEL } from '../live-hub.js';
import type { App, RouteDeps } from './common.js';

export function settingsRoutes(app: App, { db, sql }: RouteDeps) {
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
}
