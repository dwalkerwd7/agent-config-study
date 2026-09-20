import { Redis } from 'ioredis';
import { loadEnv } from '../env.js';

const env = loadEnv();

/**
 * BullMQ requires `maxRetriesPerRequest: null` so blocking commands are not
 * aborted mid-wait.
 */
export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

let shared: Redis | undefined;

export function sharedRedis(): Redis {
  shared ??= createRedis();
  return shared;
}
