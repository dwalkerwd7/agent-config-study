import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export * from './generated/prisma/client.js';
export * from './generated/prisma/enums.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  // Prisma 7 talks to Postgres through a driver adapter rather than a bundled engine.
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
  });
}

function getClient(): PrismaClient {
  const existing = globalForPrisma.prisma;
  if (existing) return existing;

  const client = createClient();
  // Cached on globalThis because Next.js reloads the module graph on every edit
  // in dev and would otherwise exhaust the connection pool.
  if (process.env['NODE_ENV'] !== 'production') {
    globalForPrisma.prisma = client;
  }
  return client;
}

/**
 * Connects on first property access rather than at import time. Next.js
 * evaluates route modules during `next build` to collect page data, where no
 * DATABASE_URL is set and no query is actually issued.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(getClient(), property, receiver);
  },
  has(_target, property) {
    return Reflect.has(getClient(), property);
  },
}) as PrismaClient;
