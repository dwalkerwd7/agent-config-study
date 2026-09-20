import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import { logger } from './logger.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // pino's concrete Logger is structurally wider than FastifyBaseLogger;
    // Fastify only uses the base surface.
    loggerInstance: logger as FastifyBaseLogger,
    trustProxy: true,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const status = error.statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : error.name,
      message: status >= 500 ? 'Internal server error' : error.message,
    });
  });

  await app.register(healthRoutes);

  return app;
}
