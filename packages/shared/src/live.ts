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
  /** Label of the active time-variable grid fee window, if any. */
  feeWindow: z.string().nullable().optional(),
  /** Names of load-shedding hooks currently shedding. */
  shed: z.array(z.string()).optional(),
  /** Peak-shaving controller state (absent when the collector runs without it). */
  control: z
    .object({
      mode: z.enum(['off', 'dryRun', 'active']),
      writesEnabled: z.boolean(),
      modbus: z.enum(['disabled', 'ok', 'error']),
      decision: z.enum(['release', 'hold', 'shave', 'empty']).nullable(),
      targetKw: z.number().nullable(),
      limitW: z.number().nullable(),
      requiredW: z.number().nullable(),
      storCtlMod: z.number().nullable(),
      outWRtePct: z.number().nullable(),
      note: z.string().nullable(),
      /** true while active control holds the inverter at the desired command */
      applying: z.boolean(),
    })
    .optional(),
});

export type LiveSnapshot = z.infer<typeof liveSnapshotSchema>;
export type IntervalStateName = z.infer<typeof intervalStateSchema>;
