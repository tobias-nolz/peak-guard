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

/** Battery parameters (read from the inverter in phase 2; editable until then). */
export const batterySchema = z.object({
  /** Usable capacity (kWh); null = unknown / no battery. */
  capacityKwh: z.number().min(0).max(1000).nullable(),
  /** Max discharge power (kW); null = unknown. */
  maxPowerKw: z.number().min(0).max(1000).nullable(),
  /** Minimum SoC configured in the inverter (%). */
  minSocPct: z.number().min(0).max(100),
});

export const controlModeSchema = z.enum(['off', 'dryRun', 'active']);

/** Peak-shaving controller settings (phase 2). */
export const controlSchema = z.object({
  /** off = monitoring only, dryRun = compute and log decisions without writing, active = write limits */
  mode: controlModeSchema,
  /** SoC (%) at or below which the battery is reserved for peak shaving */
  reservePct: z.number().min(0).max(100),
  /** never shave below the month's peak so far */
  adaptive: z.boolean(),
  /** aim this far below the target (kW) */
  marginKw: z.number().min(0).max(5),
  /** minimum time between setpoint changes (s) */
  minUpdateIntervalS: z.number().int().min(2).max(300),
  /** ignore limit changes smaller than this (W) */
  minChangeW: z.number().min(0).max(5000),
  /** inverter-side revert timeout written with every setpoint (s) */
  revertTimeoutS: z.number().int().min(30).max(3600),
  /** user accepted running Active although the revert self-test did not pass */
  acknowledgeNoRevert: z.boolean(),
});

export const notificationKindSchema = z.enum([
  'approaching',
  'newPeak',
  'reserveDepleted',
  'connectionLost',
  'controlSafeMode',
]);

/** Which events notify (channels are configured in the collector environment). */
export const notificationsSchema = z.object({
  events: z.object({
    /** running quarter-hour projected near/above the limit */
    approaching: z.boolean(),
    /** a new month peak was set */
    newPeak: z.boolean(),
    /** the reserve ran empty while shaving */
    reserveDepleted: z.boolean(),
    /** inverter unreachable / restored */
    connectionLost: z.boolean(),
    /** control fell back to the inverter's own mode because of an error, or a fault */
    controlSafeMode: z.boolean(),
  }),
  /** minimum time between notifications of the same kind */
  cooldownMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
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
  battery: batterySchema,
  control: controlSchema,
  notifications: notificationsSchema,
});

export type Tariff = z.infer<typeof tariffSchema>;
export type BatterySettings = z.infer<typeof batterySchema>;
export type ControlSettings = z.infer<typeof controlSchema>;
export type ControlModeName = z.infer<typeof controlModeSchema>;
export type NotificationKind = z.infer<typeof notificationKindSchema>;
export type NotificationSettings = z.infer<typeof notificationsSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export const settingsPatchSchema = settingsSchema.partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
