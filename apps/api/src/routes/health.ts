import type { FastifyInstance } from 'fastify';
import { prisma } from '@driftmark/db';
import { sharedRedis } from '../queue/connection.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, string> = {};
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks['postgres'] = 'ok';
    } catch (err) {
      checks['postgres'] = err instanceof Error ? err.message : 'error';
    }
    try {
      await sharedRedis().ping();
      checks['redis'] = 'ok';
    } catch (err) {
      checks['redis'] = err instanceof Error ? err.message : 'error';
    }

    const healthy = Object.values(checks).every((value) => value === 'ok');
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded', checks });
  });
}
