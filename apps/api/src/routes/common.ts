import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db, Sql } from '@peak-guard/db';
import type { ApiEnv } from '../config.js';
import type { LiveHub } from '../live-hub.js';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface RouteDeps {
  env: ApiEnv;
  db: Db;
  sql: Sql;
  hub: LiveHub;
}

export const errorSchema = z.object({ error: z.string() });

/** Epoch ms or ISO 8601 with offset. */
export const isoOrEpoch = z
  .union([z.coerce.number(), z.iso.datetime({ offset: true })])
  .transform((v) => (typeof v === 'number' ? v : Date.parse(v)));

export const MAX_RANGE_MS = 400 * 86_400_000;

export const rangeQuery = z
  .object({ from: isoOrEpoch, to: isoOrEpoch })
  .refine((q) => q.to > q.from && q.to - q.from <= MAX_RANGE_MS, {
    message: 'to must be after from and the range at most 400 days',
  });

export const intervalSchema = z.object({
  start: z.number(),
  importWh: z.number().nullable(),
  exportWh: z.number().nullable(),
  avgImportKw: z.number().nullable(),
  avgExportKw: z.number().nullable(),
  completeness: z.number(),
  quality: z.enum(['exact', 'estimated', 'partial', 'missing']),
  source: z.enum(['counter', 'integrated', 'none']),
  sampleCount: z.number(),
  maxImportW: z.number().nullable(),
});

export const seriesPointSchema = z.tuple([
  z.number(),
  z.number().nullable(),
  z.number().nullable(),
  z.number().nullable(),
  z.number().nullable(),
  z.number().nullable(),
]);
