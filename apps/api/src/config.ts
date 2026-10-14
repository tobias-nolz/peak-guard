import { z } from 'zod';

export const apiEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  TIME_ZONE: z.string().default('Europe/Vienna'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = apiEnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(`Invalid API configuration:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
