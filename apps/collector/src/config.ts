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
  /** Read the battery state via Modbus TCP / SunSpec (needed for active control). */
  MODBUS_ENABLED: bool.default(false),
  /** Defaults to the host of FRONIUS_URL. */
  MODBUS_HOST: z.string().optional(),
  MODBUS_PORT: z.coerce.number().int().min(1).max(65535).default(502),
  MODBUS_UNIT_ID: z.coerce.number().int().min(0).max(255).default(1),
  MODBUS_POLL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  /**
   * Kill switch: unless true, nothing is ever written to the inverter — not even in
   * Active mode or for the revert self-test.
   */
  CONTROL_WRITES_ENABLED: bool.default(false),
  /** Set by docker-compose.yml (see COMPOSE_VERSION); missing with an older file. */
  PEAK_GUARD_COMPOSE_VERSION: z.coerce.number().int().optional(),
  /** Notification channels (all optional). */
  NOTIFY_NTFY_URL: z.string().url().optional(),
  NOTIFY_NTFY_TOKEN: z.string().optional(),
  NOTIFY_TELEGRAM_BOT_TOKEN: z.string().optional(),
  NOTIFY_TELEGRAM_CHAT_ID: z.string().optional(),
  NOTIFY_WEBHOOK_URL: z.string().url().optional(),
  NOTIFY_SMTP_URL: z.string().optional(),
  NOTIFY_EMAIL_FROM: z.string().optional(),
  NOTIFY_EMAIL_TO: z.string().optional(),
  /** MQTT broker, e.g. mqtt://user:pass@mosquitto:1883 (optional). */
  MQTT_URL: z.string().optional(),
  MQTT_TOPIC_PREFIX: z.string().default('peakguard'),
  /** Home Assistant discovery prefix; set to "" to disable discovery. */
  MQTT_DISCOVERY_PREFIX: z.string().default('homeassistant'),
  MQTT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
});

export type CollectorEnv = z.infer<typeof collectorEnvSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): CollectorEnv {
  // Compose passes unset optional variables as empty strings.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = collectorEnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid collector configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Modbus host: explicit MODBUS_HOST or the host part of FRONIUS_URL. */
export function modbusHost(env: CollectorEnv): string {
  return env.MODBUS_HOST ?? new URL(env.FRONIUS_URL).hostname;
}
