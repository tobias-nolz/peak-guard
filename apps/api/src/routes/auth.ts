import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AttemptLimiter,
  hashPassword,
  parseCookies,
  signSession,
  verifyPassword,
  verifySession,
} from '../auth.js';
import { errorSchema, type App, type RouteDeps } from './common.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated user ("local" when AUTH_MODE=none). */
    user: string | null;
  }
}

export const SESSION_COOKIE = 'pg_session';

/** Routes reachable without a session. */
const PUBLIC = [/^\/api\/health$/, /^\/api\/auth\//, /^\/api\/config$/];

export async function authRoutes(app: App, { env }: RouteDeps) {
  const secret = env.AUTH_SECRET ?? randomBytes(32).toString('hex');
  if (env.AUTH_MODE === 'password' && !env.AUTH_SECRET) {
    app.log.warn('AUTH_SECRET not set: using a random key, sessions end when the API restarts');
  }
  const passwordHash =
    env.AUTH_MODE === 'password'
      ? (env.AUTH_PASSWORD_HASH ?? (await hashPassword(env.AUTH_PASSWORD!)))
      : null;
  const limiter = new AttemptLimiter(5, 60_000);

  const userOf = (req: FastifyRequest): string | null => {
    switch (env.AUTH_MODE) {
      case 'none':
        return 'local';
      case 'proxy': {
        const h = req.headers[env.AUTH_PROXY_HEADER.toLowerCase()];
        const v = Array.isArray(h) ? h[0] : h;
        return v?.trim() ? v.trim() : null;
      }
      case 'password':
        return (
          verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE], secret)?.user ?? null
        );
    }
  };

  const secure = (req: FastifyRequest) =>
    env.COOKIE_SECURE === 'true' ||
    (env.COOKIE_SECURE === 'auto' &&
      (req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https'));

  const setCookie = (req: FastifyRequest, reply: FastifyReply, value: string, maxAgeS: number) =>
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure(req) ? '; Secure' : ''}`,
    );

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    req.user = userOf(req);
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || PUBLIC.some((r) => r.test(path))) return;
    // Prometheus may scrape with a bearer token instead of a session.
    if (
      path === '/api/metrics' &&
      env.METRICS_TOKEN &&
      req.headers.authorization === `Bearer ${env.METRICS_TOKEN}`
    )
      return;
    if (!req.user) return reply.code(401).send({ error: 'authentication required' });
  });

  app.get(
    '/api/auth/me',
    {
      schema: {
        tags: ['auth'],
        response: {
          200: z.object({
            mode: z.enum(['none', 'password', 'proxy']),
            user: z.string().nullable(),
          }),
        },
      },
    },
    (req) => ({ mode: env.AUTH_MODE, user: req.user }),
  );

  app.post(
    '/api/auth/login',
    {
      schema: {
        tags: ['auth'],
        body: z.object({ username: z.string().max(200), password: z.string().max(1000) }),
        response: {
          200: z.object({ user: z.string() }),
          400: errorSchema,
          401: errorSchema,
          429: errorSchema,
        },
      },
    },
    async (req, reply) => {
      if (env.AUTH_MODE !== 'password')
        return reply.code(400).send({ error: `login not used in AUTH_MODE=${env.AUTH_MODE}` });
      if (!limiter.allowed(req.ip))
        return reply.code(429).send({ error: 'too many failed attempts, try again in a minute' });
      const ok =
        req.body.username === env.AUTH_USERNAME &&
        (await verifyPassword(req.body.password, passwordHash!));
      if (!ok) {
        limiter.fail(req.ip);
        req.log.warn({ ip: req.ip, username: req.body.username }, 'failed login');
        return reply.code(401).send({ error: 'invalid username or password' });
      }
      limiter.reset(req.ip);
      const maxAge = env.AUTH_SESSION_HOURS * 3600;
      setCookie(
        req,
        reply,
        signSession(
          { user: env.AUTH_USERNAME, exp: Math.floor(Date.now() / 1000) + maxAge },
          secret,
        ),
        maxAge,
      );
      return { user: env.AUTH_USERNAME };
    },
  );

  app.post(
    '/api/auth/logout',
    { schema: { tags: ['auth'], response: { 204: z.null() } } },
    async (req, reply) => {
      setCookie(req, reply, '', 0);
      return reply.code(204).send(null);
    },
  );
}
