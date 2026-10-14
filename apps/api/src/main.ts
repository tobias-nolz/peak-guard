import { createDb, migrateWithRetry } from '@peak-guard/db';
import { buildApp } from './app.js';
import { loadEnv } from './config.js';
import { LiveHub } from './live-hub.js';

const env = loadEnv();
// The API may start before (or be newer than) the collector: make sure the schema is current.
await migrateWithRetry(env.DATABASE_URL, (err, attempt) =>
  console.warn(
    `database not ready (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`,
  ),
);
const { sql, db } = createDb(env.DATABASE_URL, { max: 10 });
const hub = new LiveHub();
await hub.listen(sql);

const app = await buildApp({
  env,
  db,
  sql,
  hub,
  logger: { level: env.LOG_LEVEL, base: { service: 'api' } },
});
await app.listen({ host: env.HOST, port: env.PORT });

const shutdown = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
