import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Fixed messages on the two secrets: an issue must describe what is wrong
// without ever carrying the value that was supplied.
const EnvSchema = z.object({
  // A fine-grained PAT with public-repository read access only is enough, and
  // makes collecting from a private repository structurally impossible (P-14).
  GITHUB_TOKEN: z.string({ error: 'is required' }).min(1, { error: 'is required' }),
  // HMAC key for redacted values (C-2). Never published (P-11).
  CORPUS_SALT: z
    .string({ error: 'is required' })
    .min(32, { error: 'must be at least 32 characters' }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validates the collector's environment. `source` defaults to `process.env`;
 * tests pass their own object. The error lists each failing variable by name
 * with a fixed message, never with the value that was supplied.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  return parsed.data;
}

/**
 * The raw corpus directory, `<repo root>/study/corpus`. Deliberately not
 * configurable: the corpus lives in that one gitignored directory (C-9).
 * Resolved from this module's location, which is `apps/collector/src` when run
 * with tsx and `apps/collector/dist` when built — three levels below the root
 * either way.
 */
export function corpusDir(): string {
  return fileURLToPath(new URL('../../../study/corpus', import.meta.url));
}
