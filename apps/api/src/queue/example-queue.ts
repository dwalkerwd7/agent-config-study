import { Queue, type JobsOptions } from 'bullmq';
import { z } from 'zod';
import { sharedRedis } from './connection.js';

export const EXAMPLE_QUEUE_NAME = 'driftwood-example';

/** Placeholder job shape; replace when real work exists. */
export const ExampleJobSchema = z.object({
  message: z.string().min(1),
});

export type ExampleJob = z.infer<typeof ExampleJobSchema>;

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800 },
};

let queue: Queue<ExampleJob> | undefined;

export function exampleQueue(): Queue<ExampleJob> {
  queue ??= new Queue<ExampleJob>(EXAMPLE_QUEUE_NAME, {
    connection: sharedRedis(),
    defaultJobOptions,
  });
  return queue;
}

export async function enqueueExample(job: ExampleJob): Promise<string> {
  const added = await exampleQueue().add('example', ExampleJobSchema.parse(job));
  return added.id ?? '';
}
