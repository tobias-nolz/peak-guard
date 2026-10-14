import { z } from 'zod';

export const intervalStateSchema = z.enum(['safe', 'warning', 'over']);

/** Live snapshot pushed by the collector and streamed to the UI via SSE. */
export const liveSnapshotSchema = z.object({
  ts: z.number(),
  /** Connection to the inverter: ok, stale (no fresh sample), down. */
  connection: z.enum(['ok', 'stale', 'down']),
  power: z.object({
    /** + import, − export (W) */
    gridW: z.number(),
    /** house consumption (W, positive) */
    loadW: z.number().nullable(),
    pvW: z.number().nullable(),
    /** + discharge, − charge (W) */
    batteryW: z.number().nullable(),
    socPct: z.number().nullable(),
  }),
  interval: z.object({
    start: z.number(),
    end: z.number(),
    elapsedMs: z.number(),
    remainingMs: z.number(),
    importWh: z.number(),
    runningAvgKw: z.number(),
    committedKw: z.number(),
    projectedKw: z.number(),
    completeness: z.number(),
    source: z.enum(['counter', 'integrated', 'none']),
  }),
  thresholdKw: z.number(),
  /** max(threshold, minBilledKw) — the level below which shaving saves nothing. */
  effectiveLimitKw: z.number(),
  monthPeak: z.object({ start: z.number(), kw: z.number() }).nullable(),
  state: intervalStateSchema,
  /** Capacity charge for the month if the month ended now (€). */
  monthCostEur: z.number(),
  /** Extra monthly cost if the projected value became the new month peak (€). */
  projectedExtraCostEur: z.number(),
});

export type LiveSnapshot = z.infer<typeof liveSnapshotSchema>;
export type IntervalStateName = z.infer<typeof intervalStateSchema>;
