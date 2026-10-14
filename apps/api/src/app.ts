import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { authRoutes } from './routes/auth.js';
import type { RouteDeps } from './routes/common.js';
import { exportRoutes } from './routes/export.js';
import { historyRoutes } from './routes/history.js';
import { liveRoutes } from './routes/live.js';
import { metricsRoutes } from './routes/metrics.js';
import { reconciliationRoutes } from './routes/reconciliation.js';
import { settingsRoutes } from './routes/settings.js';
import { systemRoutes } from './routes/system.js';

export interface AppDeps extends RouteDeps {
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({
        error: err.validation
          .map((v) => `${v.instancePath || '/'} ${v.message ?? ''}`.trim())
          .join('; '),
      });
    }
    if (err.statusCode && err.statusCode < 500)
      return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Peak Guard API',
        version: '0.1.0',
        description: '15-minute peak monitoring and shaving',
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  await authRoutes(app, deps);
  metricsRoutes(app, deps);
  systemRoutes(app, deps);
  liveRoutes(app, deps);
  settingsRoutes(app, deps);
  historyRoutes(app, deps);
  exportRoutes(app, deps);
  reconciliationRoutes(app, deps);
  return app;
}
