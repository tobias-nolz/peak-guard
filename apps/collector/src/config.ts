import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const collectorEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  /** Base URL of the inverter's Solar API, e.g. http://192.168.1.50 */
  FRONIUS_URL: z.string().url(),
  POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(3_000),
  /** `local` timestamps samples on receipt; `inverter` uses the API's Head.Timestamp (needed for the accelerated mock). */
  CLOCK_SOURCE: z.enum(['local', 'inverter']).default('local'),
  TIME_ZONE: z.string().default('Europe/Vienna'),
  MAX_GAP_MS: z.coerce.number().int().min(1_000).default(30_000),
  MAX_BACKFILL_HOURS: z.coerce.number().min(0).default(48),
  /** No fresh sample for this long => connection "stale"; 3× => "down". */
  STALE_AFTER_MS: z.coerce.number().int().min(1_000).default(15_000),
  SAMPLE_FLUSH_MS: z.coerce.number().int().min(100).default(5_000),
  HEALTH_PORT: z.coerce.number().int().default(8081),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: bool.default(false),
});

export type CollectorEnv = z.infer<typeof collectorEnvSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): CollectorEnv {
  const parsed = collectorEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid collector configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
