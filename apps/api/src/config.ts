import { z } from 'zod';

export const apiEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  TIME_ZONE: z.string().default('Europe/Vienna'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** none = open (trusted LAN only), password = single-user login, proxy = trust a header set by an auth proxy */
  AUTH_MODE: z.enum(['none', 'password', 'proxy']).default('none'),
  AUTH_USERNAME: z.string().min(1).default('admin'),
  /** scrypt hash from `node dist/hash-password.js` (preferred over AUTH_PASSWORD) */
  AUTH_PASSWORD_HASH: z.string().startsWith('scrypt$').optional(),
  AUTH_PASSWORD: z.string().min(8).optional(),
  /** HMAC key for session cookies; random per start if unset (sessions end on restart) */
  AUTH_SECRET: z.string().min(32).optional(),
  AUTH_SESSION_HOURS: z.coerce
    .number()
    .min(1)
    .max(24 * 365)
    .default(24 * 30),
  AUTH_PROXY_HEADER: z.string().default('remote-user'),
  /** auto = Secure when the request arrived via HTTPS (X-Forwarded-Proto) */
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
  /** Bearer token that may read /api/metrics regardless of AUTH_MODE */
  METRICS_TOKEN: z.string().min(16).optional(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  // Compose passes unset optional variables as empty strings.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = apiEnvSchema.safeParse(cleaned);
  if (!parsed.success)
    throw new Error(`Invalid API configuration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  if (e.AUTH_MODE === 'password' && !e.AUTH_PASSWORD_HASH && !e.AUTH_PASSWORD) {
    throw new Error('AUTH_MODE=password requires AUTH_PASSWORD_HASH (or AUTH_PASSWORD)');
  }
  return e;
}
