import {
  bigserial,
  serial,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Raw samples from the inverter (TimescaleDB hypertable on `ts`). */
export const samples = pgTable('samples', {
  ts: tstz('ts').primaryKey(),
  /** + import, − export (W) */
  gridW: real('grid_w').notNull(),
  loadW: real('load_w'),
  pvW: real('pv_w'),
  /** + discharge, − charge (W) */
  batteryW: real('battery_w'),
  socPct: real('soc_pct'),
  importWh: doublePrecision('import_wh'),
  exportWh: doublePrecision('export_wh'),
});

/** Authoritative clock-aligned quarter-hours, computed by the collector. */
export const intervals = pgTable('intervals', {
  start: tstz('start').primaryKey(),
  importWh: doublePrecision('import_wh'),
  exportWh: doublePrecision('export_wh'),
  avgImportKw: doublePrecision('avg_import_kw'),
  avgExportKw: doublePrecision('avg_export_kw'),
  completeness: real('completeness').notNull(),
  /** exact | estimated | partial | missing */
  quality: text('quality').notNull(),
  /** counter | integrated | none */
  source: text('source').notNull(),
  sampleCount: integer('sample_count').notNull(),
  maxImportW: real('max_import_w'),
  integratedImportWh: doublePrecision('integrated_import_wh').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

/** Singleton row (id = 1) holding user settings as validated JSON. */
export const settings = pgTable('settings', {
  id: smallint('id').primaryKey(),
  data: jsonb('data').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: tstz('ts').notNull().defaultNow(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
});

/** Operational events: connection loss/recovery, collector start, backfills, … */
export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: tstz('ts').notNull().defaultNow(),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  data: jsonb('data'),
});

/** Key/value store for collector state (e.g. heartbeat, device info). */
export const kv = pgTable('kv', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

/** Uploaded smart-meter portal exports (reconciliation with the billing meter). */
export const importBatches = pgTable('import_batches', {
  id: serial('id').primaryKey(),
  filename: text('filename').notNull(),
  importedAt: tstz('imported_at').notNull().defaultNow(),
  actor: text('actor').notNull(),
  rowCount: integer('row_count').notNull(),
  from: tstz('from').notNull(),
  to: tstz('to').notNull(),
  /** whether file timestamps marked interval start or end */
  alignment: text('alignment').notNull(),
});

/** Quarter-hour energies as measured by the grid operator's billing meter. */
export const billingIntervals = pgTable('billing_intervals', {
  start: tstz('start').primaryKey(),
  importWh: doublePrecision('import_wh').notNull(),
  status: text('status'),
  batchId: integer('batch_id')
    .notNull()
    .references(() => importBatches.id, { onDelete: 'cascade' }),
});
