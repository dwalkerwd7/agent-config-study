import { Worker, type Job } from 'bullmq';
import { logger } from '../logger.js';
import { createRedis } from './connection.js';
import { EXAMPLE_QUEUE_NAME, ExampleJobSchema, type ExampleJob } from './example-queue.js';

async function handle(job: Job<ExampleJob>): Promise<void> {
  const { message } = ExampleJobSchema.parse(job.data);
  logger.info({ jobId: job.id, message }, 'processed job');
}

export function startWorker(): Worker<ExampleJob> {
  const worker = new Worker<ExampleJob>(EXAMPLE_QUEUE_NAME, handle, {
    connection: createRedis(),
    concurrency: 4,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'job failed');
  });

  return worker;
}

// Run directly with `pnpm --filter @driftwood/api worker`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = startWorker();
  logger.info('worker listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down worker');
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
