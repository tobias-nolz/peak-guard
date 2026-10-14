import { createServer } from 'node:http';
import { createDb, getSettings, migrateDb, addEvent } from '@peak-guard/db';
import { SolarApiClient } from '@peak-guard/fronius';
import { DEFAULT_SETTINGS, type Settings } from '@peak-guard/shared';
import { pino } from 'pino';
import { Collector, errorMessage } from './collector.js';
import { loadEnv } from './config.js';

export const LIVE_CHANNEL = 'live';
export const SETTINGS_CHANNEL = 'settings_changed';

const env = loadEnv();
const log = pino({
  level: env.LOG_LEVEL,
  base: { service: 'collector' },
  ...(env.LOG_PRETTY ? { transport: { target: 'pino-pretty' } } : {}),
});

async function waitForDb(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrateDb(env.DATABASE_URL);
      return;
    } catch (err) {
      if (attempt >= 30) throw err;
      log.warn({ err: errorMessage(err), attempt }, 'database not ready, retrying');
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

await waitForDb();
log.info('database migrated');

const { sql, db } = createDb(env.DATABASE_URL);
let settings: Settings = await getSettings(db).catch(() => DEFAULT_SETTINGS);
await sql.listen(SETTINGS_CHANNEL, () => {
  getSettings(db)
    .then((s) => {
      settings = s;
      log.info('settings reloaded');
    })
    .catch((err: unknown) => log.error({ err: errorMessage(err) }, 'settings reload failed'));
});

const collector = new Collector({
  env,
  db,
  log,
  api: new SolarApiClient({ baseUrl: env.FRONIUS_URL, timeoutMs: env.REQUEST_TIMEOUT_MS }),
  getSettings: () => settings,
  publish: async (snap) => {
    await sql.notify(LIVE_CHANNEL, JSON.stringify(snap));
  },
});

await collector.recover();
await addEvent(db, 'collector', 'Collector started', {
  fronius: env.FRONIUS_URL,
  pollMs: env.POLL_INTERVAL_MS,
});
collector.start();
log.info({ fronius: env.FRONIUS_URL, pollMs: env.POLL_INTERVAL_MS }, 'collector running');

// Health endpoint for Docker: healthy while the poll loop is alive. An unreachable
// inverter is reported (connection) but doesn't make the collector unhealthy.
const health = createServer((_req, res) => {
  const loopAge = Date.now() - collector.lastLoopAt;
  const ok = loopAge < Math.max(30_000, 5 * env.POLL_INTERVAL_MS + env.REQUEST_TIMEOUT_MS);
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      ok,
      loopAgeMs: loopAge,
      lastSuccessAgeMs: Date.now() - collector.lastSuccessAt,
      connection: collector.snapshot?.connection ?? 'down',
    }),
  );
});
health.listen(env.HEALTH_PORT);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  health.close();
  await collector.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
