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

/** Apply Drizzle migrations, then the TimescaleDB setup. */
export async function migrateDb(url: string, retention?: RetentionOptions): Promise<void> {
  const { sql, db } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder });
    await setupTimescale(sql, retention);
  } finally {
    await sql.end();
  }
}
