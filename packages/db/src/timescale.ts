import type { Sql } from 'postgres';

export interface RetentionOptions {
  /** Compress raw samples older than this. */
  compressAfter: string;
  /** Drop raw samples older than this. */
  rawRetention: string;
  /** Drop 1-minute aggregates older than this. */
  minuteRetention: string;
}

export const DEFAULT_RETENTION: RetentionOptions = {
  compressAfter: '2 days',
  rawRetention: '90 days',
  minuteRetention: '730 days',
};

/**
 * TimescaleDB objects. Kept out of the Drizzle migrations because continuous aggregates
 * cannot be created inside a transaction (Drizzle runs migrations in one). Every
 * statement is idempotent and runs in autocommit mode after the migrations.
 */
export async function setupTimescale(
  sql: Sql,
  retention: RetentionOptions = DEFAULT_RETENTION,
): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS timescaledb`;
  await sql`SELECT create_hypertable('samples', by_range('ts', INTERVAL '1 day'), if_not_exists => TRUE, migrate_data => TRUE)`;
  await sql`ALTER TABLE samples SET (timescaledb.compress, timescaledb.compress_orderby = 'ts DESC')`;
  await sql`SELECT add_compression_policy('samples', ${retention.compressAfter}::interval, if_not_exists => TRUE)`;
  await sql`SELECT add_retention_policy('samples', ${retention.rawRetention}::interval, if_not_exists => TRUE)`;

  await sql.unsafe(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS samples_1m
    WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
    SELECT time_bucket(INTERVAL '1 minute', ts) AS bucket,
           avg(grid_w)    AS grid_w_avg,
           min(grid_w)    AS grid_w_min,
           max(grid_w)    AS grid_w_max,
           avg(load_w)    AS load_w_avg,
           avg(pv_w)      AS pv_w_avg,
           avg(battery_w) AS battery_w_avg,
           last(soc_pct, ts) AS soc_pct,
           count(*)       AS n
    FROM samples
    GROUP BY bucket
    WITH NO DATA
  `);
  await sql`SELECT add_continuous_aggregate_policy('samples_1m',
    start_offset => INTERVAL '3 hours', end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE)`;
  await sql`SELECT add_retention_policy('samples_1m', ${retention.minuteRetention}::interval, if_not_exists => TRUE)`;
}

/**
 * Materialize the 1-minute aggregate for a range. Needed after inserting history older
 * than the refresh policy's window (demo seeding, imports); real-time aggregation only
 * covers data newer than the materialization watermark.
 */
export async function refreshMinuteAggregate(
  sql: Sql,
  from: number | null = null,
  to: number | null = null,
): Promise<void> {
  const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
  await sql`CALL refresh_continuous_aggregate('samples_1m', ${iso(from)}::timestamptz, ${iso(to)}::timestamptz)`;
}
