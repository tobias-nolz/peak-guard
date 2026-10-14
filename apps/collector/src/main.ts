import { createServer } from 'node:http';
import { addEvent, createDb, getSettings, kvSet, migrateWithRetry } from '@peak-guard/db';
import { ModbusTcpTransport, SolarApiClient } from '@peak-guard/fronius';
import { DEFAULT_SETTINGS, type Settings } from '@peak-guard/shared';
import { pino } from 'pino';
import { Collector, errorMessage } from './collector.js';
import { loadEnv, modbusHost } from './config.js';
import { Controller } from './control/controller.js';
import { CollectorMetrics } from './metrics.js';
import { Notifier } from './notify/notifier.js';

export const LIVE_CHANNEL = 'live';
export const SETTINGS_CHANNEL = 'settings_changed';

const env = loadEnv();
const log = pino({
  level: env.LOG_LEVEL,
  base: { service: 'collector' },
  ...(env.LOG_PRETTY ? { transport: { target: 'pino-pretty' } } : {}),
});

await migrateWithRetry(env.DATABASE_URL, (err, attempt) =>
  log.warn({ err: errorMessage(err), attempt }, 'database not ready, retrying'),
);
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

export const CONTROL_COMMAND_CHANNEL = 'control_command';

const notifier = new Notifier({
  config: {
    ntfyUrl: env.NOTIFY_NTFY_URL,
    ntfyToken: env.NOTIFY_NTFY_TOKEN,
    telegramBotToken: env.NOTIFY_TELEGRAM_BOT_TOKEN,
    telegramChatId: env.NOTIFY_TELEGRAM_CHAT_ID,
    webhookUrl: env.NOTIFY_WEBHOOK_URL,
    smtpUrl: env.NOTIFY_SMTP_URL,
    emailFrom: env.NOTIFY_EMAIL_FROM,
    emailTo: env.NOTIFY_EMAIL_TO,
  },
  getSettings: () => settings,
  log: log.child({ component: 'notify' }),
  record: (kind, message, data) => addEvent(db, kind, message, data),
});
await kvSet(db, 'notify.channels', notifier.channelNames);
log.info({ channels: notifier.channelNames }, 'notification channels');

const transport = env.MODBUS_ENABLED
  ? new ModbusTcpTransport({
      host: modbusHost(env),
      port: env.MODBUS_PORT,
      unitId: env.MODBUS_UNIT_ID,
      timeoutMs: env.REQUEST_TIMEOUT_MS,
    })
  : null;
const controller = new Controller({
  db,
  log: log.child({ component: 'controller' }),
  getSettings: () => settings,
  transport,
  writesEnabled: env.CONTROL_WRITES_ENABLED,
  modbusPollMs: env.MODBUS_POLL_MS,
  now: () => collector.snapshot?.ts ?? Date.now(),
  staleAfterMs: Math.max(30_000, 3 * env.STALE_AFTER_MS),
  alert: (n, key) => void notifier.notify(n, key),
});
log.info(
  {
    modbus: env.MODBUS_ENABLED ? `${modbusHost(env)}:${env.MODBUS_PORT}` : 'disabled',
    writesEnabled: env.CONTROL_WRITES_ENABLED,
  },
  'controller configured',
);

// Commands from the API (currently: the revert self-test).
await sql.listen(CONTROL_COMMAND_CHANNEL, (payload: string) => {
  let cmd: { type?: string; revertS?: number; minutes?: number } = {};
  try {
    cmd = JSON.parse(payload) as typeof cmd;
  } catch {
    return;
  }
  switch (cmd.type) {
    case 'revertTest':
      log.warn('revert self-test requested');
      void controller
        .runRevertTest(cmd.revertS ?? 60)
        .then((r) => log.info({ result: r }, 'revert self-test finished'));
      break;
    case 'pause':
      void controller.pause(Date.now() + (cmd.minutes ?? 60) * 60_000);
      break;
    case 'resume':
      void controller.pause(null);
      break;
    case 'notifyTest':
      void notifier.notify({
        kind: 'test',
        title: 'Test notification',
        message: 'Peak Guard notifications are working.',
      });
      break;
    case 'clearFault':
      controller.clearFault();
      break;
  }
});

const metrics = new CollectorMetrics();
const collector: Collector = new Collector({
  metrics,
  controller,
  notifier,
  env,
  db,
  log,
  api: new SolarApiClient({ baseUrl: env.FRONIUS_URL, timeoutMs: env.REQUEST_TIMEOUT_MS }),
  getSettings: () => settings,
  publish: async (snap) => {
    await sql.notify(LIVE_CHANNEL, JSON.stringify(snap));
  },
});

await controller.init();
// Watchdog (wall clock): restores the inverter's own mode if control ticks stop while limits are active.
const watchdog = setInterval(() => void controller.watchdog(), 5_000);
watchdog.unref();

await collector.recover();
await addEvent(db, 'collector', 'Collector started', {
  fronius: env.FRONIUS_URL,
  pollMs: env.POLL_INTERVAL_MS,
});
collector.start();
log.info({ fronius: env.FRONIUS_URL, pollMs: env.POLL_INTERVAL_MS }, 'collector running');

// Health endpoint for Docker: healthy while the poll loop is alive. An unreachable
// inverter is reported (connection) but doesn't make the collector unhealthy.
const health = createServer((req, res) => {
  if (req.url === '/metrics') {
    void metrics.registry.metrics().then((text) => {
      res.writeHead(200, { 'content-type': metrics.registry.contentType });
      res.end(text);
    });
    return;
  }
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
  clearInterval(watchdog);
  await collector.stop();
  await controller.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
