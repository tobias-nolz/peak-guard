import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { setupTimescale, type RetentionOptions } from './timescale.js';

export type Db = ReturnType<typeof createDb>['db'];
export type { Sql } from 'postgres';

export function createDb(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, { max: options.max ?? 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Arbitrary but fixed key for the migration advisory lock. */
const MIGRATION_LOCK = 74_131_517;

/**
 * Apply Drizzle migrations, then the TimescaleDB setup. Both the collector and the API
 * call this on start; a session advisory lock serializes concurrent runs.
 */
export async function migrateDb(url: string, retention?: RetentionOptions): Promise<void> {
  // max: 1 keeps lock, migrations and unlock on the same session.
  const { sql, db } = createDb(url, { max: 1 });
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(db, { migrationsFolder });
    await setupTimescale(sql, retention);
    await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
  } finally {
    await sql.end();
  }
}

/** Run migrateDb, retrying while the database is still starting up. */
export async function migrateWithRetry(
  url: string,
  onRetry: (err: unknown, attempt: number) => void,
  attempts = 30,
  delayMs = 2_000,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrateDb(url);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      onRetry(err, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
