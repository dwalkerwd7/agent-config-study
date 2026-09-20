import { prisma } from '@driftwood/db';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { logger } from './logger.js';

const env = loadEnv();

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ host: env.HOST, port: env.PORT });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down api');
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
