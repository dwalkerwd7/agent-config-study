import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import { collect, type CollectResult } from './collect.js';
import { corpusDir, loadEnv } from './env.js';
import { createCollectorGitHub, type CollectorGitHub } from './github.js';
import { createLogger } from './logger.js';
import { buildSlices } from './queries.js';
import { CorpusStore } from './store.js';

/**
 * `collect [--dry-run] [--max-repos N]`.
 *
 * `--dry-run` fetches page 1 of every slice and prints each query with its
 * `total_count` and `incomplete_results` to stdout. It opens no store, so it
 * writes nothing under the corpus directory. The owner uses it to finalise the
 * slice list before the first real run, which locks the study plan.
 */

export interface CliDeps {
  github: CollectorGitHub;
  logger: Logger;
  salt: string;
  /** The corpus root: `corpusDir()` in production, a temp dir in tests. */
  corpusDir: string;
  /** Writes one line of CLI output. */
  stdout: (line: string) => void;
  signal?: AbortSignal;
}

/** Thrown for a bad command line. The message names the flag, never file content. */
export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\nusage: collect [--dry-run] [--max-repos N]`);
    this.name = 'UsageError';
  }
}

/** Runs the command. Returns the run result, or `null` for a dry run. */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps,
): Promise<CollectResult | null> {
  const { dryRun, maxRepos } = parseCommandLine(argv);
  if (dryRun) {
    await dryRunSlices(deps);
    return null;
  }
  return collect(
    {
      github: deps.github,
      store: new CorpusStore(deps.corpusDir),
      salt: deps.salt,
      logger: deps.logger,
    },
    {
      ...(maxRepos === undefined ? {} : { maxRepos }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    },
  );
}

function parseCommandLine(argv: readonly string[]): { dryRun: boolean; maxRepos?: number } {
  // `pnpm collect -- --dry-run` passes the separator through.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let values: { 'dry-run'?: boolean; 'max-repos'?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: { 'dry-run': { type: 'boolean' }, 'max-repos': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : 'invalid arguments');
  }
  const dryRun = values['dry-run'] === true;
  const raw = values['max-repos'];
  if (raw === undefined) return { dryRun };
  if (!/^[1-9][0-9]{0,8}$/.test(raw))
    throw new UsageError('--max-repos must be a positive integer');
  return { dryRun, maxRepos: Number(raw) };
}

async function dryRunSlices(deps: CliDeps): Promise<void> {
  deps.stdout('total_count\tincomplete_results\tquery');
  for (const slice of buildSlices()) {
    if (deps.signal?.aborted === true) return;
    const page = await deps.github.searchCode(slice.query, 1);
    deps.stdout(`${String(page.total_count)}\t${String(page.incomplete_results)}\t${slice.query}`);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const controller = new AbortController();
  // The first SIGINT stops the run between requests, so it can record itself
  // as partial. `once` restores the default for a second one, which kills.
  process.once('SIGINT', () => {
    logger.warn('SIGINT received: stopping after the current request');
    controller.abort();
  });
  await runCli(process.argv.slice(2), {
    github: createCollectorGitHub({ token: env.GITHUB_TOKEN, logger }),
    logger,
    salt: env.CORPUS_SALT,
    corpusDir: corpusDir(),
    stdout: (line) => void process.stdout.write(`${line}\n`),
    signal: controller.signal,
  });
}

/** True when this module is the process entry point, not imported by a test. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url);
}

if (isEntryPoint()) {
  main().catch((err: unknown) => {
    // Every error on this path carries a fixed message or GitHub's own status
    // text: nothing here puts file content into one (rubric §4).
    const message = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
    process.stderr.write(`collect failed: ${message}\n`);
    process.exitCode = 1;
  });
}
