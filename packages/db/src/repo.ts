import { and, asc, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import type { ClosedInterval, GridSample } from '@peak-guard/core';
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '@peak-guard/shared';
import type { Db } from './client.js';
import {
  auditLog,
  billingIntervals,
  controlDecisions,
  events,
  importBatches,
  intervals,
  kv,
  samples,
  settings,
} from './schema.js';

export interface SampleRow {
  ts: number;
  gridW: number;
  loadW: number | null;
  pvW: number | null;
  batteryW: number | null;
  socPct: number | null;
  importWh: number | null;
  exportWh: number | null;
}

export async function insertSamples(db: Db, rows: readonly SampleRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(samples)
    .values(rows.map((r) => ({ ...r, ts: new Date(r.ts) })))
    .onConflictDoNothing();
}

export async function lastSample(db: Db): Promise<SampleRow | null> {
  const [row] = await db.select().from(samples).orderBy(desc(samples.ts)).limit(1);
  return row ? { ...row, ts: row.ts.getTime() } : null;
}

/** Grid samples in [from, to), oldest first, in the tracker's format. */
export async function gridSamplesBetween(db: Db, from: number, to: number): Promise<GridSample[]> {
  const rows = await db
    .select({
      ts: samples.ts,
      gridW: samples.gridW,
      importWh: samples.importWh,
      exportWh: samples.exportWh,
    })
    .from(samples)
    .where(and(gte(samples.ts, new Date(from)), lt(samples.ts, new Date(to))))
    .orderBy(asc(samples.ts));
  return rows.map((r) => ({
    ts: r.ts.getTime(),
    gridPowerW: r.gridW,
    importWh: r.importWh,
    exportWh: r.exportWh,
  }));
}

export async function upsertIntervals(db: Db, rows: readonly ClosedInterval[]): Promise<void> {
  if (rows.length === 0) return;
  // One statement can't update the same row twice: keep the last version per start.
  const unique = [...new Map(rows.map((r) => [r.start, r])).values()];
  const values = unique.map((i) => ({
    start: new Date(i.start),
    importWh: i.importWh,
    exportWh: i.exportWh,
    avgImportKw: i.avgImportKw,
    avgExportKw: i.avgExportKw,
    completeness: i.completeness,
    quality: i.quality,
    source: i.source,
    sampleCount: i.sampleCount,
    maxImportW: i.maxImportW,
    integratedImportWh: i.integratedImportWh,
  }));
  await db
    .insert(intervals)
    .values(values)
    .onConflictDoUpdate({
      target: intervals.start,
      set: {
        importWh: sql`excluded.import_wh`,
        exportWh: sql`excluded.export_wh`,
        avgImportKw: sql`excluded.avg_import_kw`,
        avgExportKw: sql`excluded.avg_export_kw`,
        completeness: sql`excluded.completeness`,
        quality: sql`excluded.quality`,
        source: sql`excluded.source`,
        sampleCount: sql`excluded.sample_count`,
        maxImportW: sql`excluded.max_import_w`,
        integratedImportWh: sql`excluded.integrated_import_wh`,
        updatedAt: sql`now()`,
      },
    });
}

export interface IntervalRow extends ClosedInterval {
  updatedAt: number;
}

export async function intervalsBetween(db: Db, from: number, to: number): Promise<IntervalRow[]> {
  const rows = await db
    .select()
    .from(intervals)
    .where(and(gte(intervals.start, new Date(from)), lt(intervals.start, new Date(to))))
    .orderBy(asc(intervals.start));
  return rows.map(toInterval);
}

/** Highest billable interval in [from, to). */
export async function peakBetween(db: Db, from: number, to: number): Promise<IntervalRow | null> {
  const [row] = await db
    .select()
    .from(intervals)
    .where(
      and(
        gte(intervals.start, new Date(from)),
        lt(intervals.start, new Date(to)),
        ne(intervals.quality, 'missing'),
        sql`${intervals.avgImportKw} IS NOT NULL`,
      ),
    )
    .orderBy(desc(intervals.avgImportKw), asc(intervals.start))
    .limit(1);
  return row ? toInterval(row) : null;
}

function toInterval(r: typeof intervals.$inferSelect): IntervalRow {
  return {
    start: r.start.getTime(),
    importWh: r.importWh,
    exportWh: r.exportWh,
    avgImportKw: r.avgImportKw,
    avgExportKw: r.avgExportKw,
    completeness: r.completeness,
    quality: r.quality as ClosedInterval['quality'],
    source: r.source as ClosedInterval['source'],
    sampleCount: r.sampleCount,
    maxImportW: r.maxImportW,
    integratedImportWh: r.integratedImportWh,
    updatedAt: r.updatedAt.getTime(),
  };
}

export async function getSettings(db: Db): Promise<Settings> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!row) return DEFAULT_SETTINGS;
  const data = row.data as Partial<Settings>;
  // Shallow-merge nested objects so settings stored before a field existed get its default.
  const parsed = settingsSchema.safeParse({
    ...DEFAULT_SETTINGS,
    ...data,
    battery: { ...DEFAULT_SETTINGS.battery, ...data.battery },
    control: { ...DEFAULT_SETTINGS.control, ...data.control },
  });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(db: Db, next: Settings, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [prev] = await tx.select().from(settings).where(eq(settings.id, 1));
    await tx
      .insert(settings)
      .values({ id: 1, data: next })
      .onConflictDoUpdate({ target: settings.id, set: { data: next, updatedAt: sql`now()` } });
    await tx
      .insert(auditLog)
      .values({ actor, action: 'settings.update', before: prev?.data ?? null, after: next });
  });
}

export async function addEvent(
  db: Db,
  kind: string,
  message: string,
  data?: unknown,
): Promise<void> {
  await db.insert(events).values({ kind, message, data: data ?? null });
}

export async function recentEvents(db: Db, limit = 50) {
  return db.select().from(events).orderBy(desc(events.ts)).limit(limit);
}

export async function kvGet<T>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, key));
  return row ? (row.value as T) : null;
}

export async function kvSet(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(kv)
    .values({ key, value })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: sql`now()` } });
}

export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

export interface BillingRow {
  start: number;
  importWh: number;
  status: string | null;
}

/** Store an imported file; existing quarter-hours are overwritten by the newer import. */
export async function importBillingIntervals(
  db: Db,
  meta: { filename: string; actor: string; alignment: string },
  rows: readonly BillingRow[],
): Promise<{ batchId: number; from: number; to: number }> {
  if (rows.length === 0) throw new Error('no rows');
  const unique = [...new Map(rows.map((r) => [r.start, r])).values()].sort(
    (a, b) => a.start - b.start,
  );
  const from = unique[0]!.start;
  const to = unique.at(-1)!.start + 15 * 60_000;
  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(importBatches)
      .values({ ...meta, rowCount: unique.length, from: new Date(from), to: new Date(to) })
      .returning({ id: importBatches.id });
    const batchId = batch!.id;
    for (let i = 0; i < unique.length; i += 2_000) {
      await tx
        .insert(billingIntervals)
        .values(
          unique.slice(i, i + 2_000).map((r) => ({
            start: new Date(r.start),
            importWh: r.importWh,
            status: r.status,
            batchId,
          })),
        )
        .onConflictDoUpdate({
          target: billingIntervals.start,
          set: {
            importWh: sql`excluded.import_wh`,
            status: sql`excluded.status`,
            batchId: sql`excluded.batch_id`,
          },
        });
    }
    return { batchId, from, to };
  });
}

export async function billingIntervalsBetween(
  db: Db,
  from: number,
  to: number,
): Promise<BillingRow[]> {
  const rows = await db
    .select()
    .from(billingIntervals)
    .where(
      and(gte(billingIntervals.start, new Date(from)), lt(billingIntervals.start, new Date(to))),
    )
    .orderBy(asc(billingIntervals.start));
  return rows.map((r) => ({ start: r.start.getTime(), importWh: r.importWh, status: r.status }));
}

export async function listImportBatches(db: Db) {
  const rows = await db.select().from(importBatches).orderBy(desc(importBatches.importedAt));
  return rows.map((r) => ({
    ...r,
    importedAt: r.importedAt.getTime(),
    from: r.from.getTime(),
    to: r.to.getTime(),
  }));
}

/** Delete a batch and the quarter-hours it currently owns. Returns false if unknown. */
export async function deleteImportBatch(db: Db, id: number): Promise<boolean> {
  const deleted = await db
    .delete(importBatches)
    .where(eq(importBatches.id, id))
    .returning({ id: importBatches.id });
  return deleted.length > 0;
}

export async function recentAudit(db: Db, limit = 50) {
  const rows = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
  return rows.map((r) => ({ ...r, ts: r.ts.getTime() }));
}

export type DecisionRow = Omit<typeof controlDecisions.$inferInsert, 'ts'> & { ts: number };

export async function insertDecisions(db: Db, rows: readonly DecisionRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(controlDecisions)
    .values(rows.map((r) => ({ ...r, ts: new Date(r.ts) })))
    .onConflictDoNothing();
}

export async function decisionsBetween(db: Db, from: number, to: number, limit = 5_000) {
  const rows = await db
    .select()
    .from(controlDecisions)
    .where(and(gte(controlDecisions.ts, new Date(from)), lt(controlDecisions.ts, new Date(to))))
    .orderBy(asc(controlDecisions.ts))
    .limit(limit);
  return rows.map((r) => ({ ...r, ts: r.ts.getTime() }));
}
