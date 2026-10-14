import { z } from 'zod';

/** A capacity tariff period (see @peak-guard/core tariff maths). */
export const tariffSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  minBilledKw: z.number().min(0).max(1000),
  tiers: z
    .array(
      z.object({
        upToKw: z.number().positive().nullable(),
        eurPerKwYear: z.number().min(0),
      }),
    )
    .min(1),
});

/**
 * User-editable runtime settings (stored in the database, edited in the UI).
 * Deployment settings (hosts, ports, secrets) live in the environment instead.
 */
export const settingsSchema = z.object({
  /** Peak threshold the user wants to stay below (kW). Never effective below minBilledKw. */
  thresholdKw: z.number().min(0).max(1000).default(10),
  /** Projection above this fraction of the limit shows "warning". */
  warnRatio: z.number().min(0.5).max(1).default(0.9),
  /** Factor applied to own meter readings to match the billing meter (reconciliation). */
  calibrationFactor: z.number().min(0.8).max(1.2).default(1),
  /** Smoothing window for the "current power" used in projections (seconds). */
  projectionSmoothingS: z.number().int().min(0).max(120).default(10),
  tariffs: z.array(tariffSchema).min(1),
});

export type Tariff = z.infer<typeof tariffSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
