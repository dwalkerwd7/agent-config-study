import { randomUUID } from 'node:crypto';
import { sha256 } from '@driftwood/core';
import type { Logger } from 'pino';
import {
  SEARCH_PAGE_SIZE,
  apiErrorStatus,
  type CollectorGitHub,
  type TreeEntry,
} from './github.js';
import { buildSlices } from './queries.js';
import { redact } from './redact.js';
import {
  CorpusPathError,
  fileKey,
  type CorpusStore,
  type ResponseRecord,
  type SearchHit,
} from './store.js';
import { matchTarget, type TargetMatch } from './targets.js';

/**
 * The two-phase collect loop. Discover runs every code-search slice and queues
 * the public, non-fork repositories it finds; Expand reads each queued
 * repository's tree at its default-branch head and collects every target path
 * in it. Everything written goes through the store, redacted first (C-1).
 *
 * Nothing a collected file names is fetched, spawned or resolved (rubric §4):
 * every request is built from a slice query, or a repository name, branch,
 * path or SHA the API returned. Log lines carry counts, repository names,
 * slice ids, paths and API status, never content or a value read from it.
 */

/** Code search serves at most 1,000 results: 10 pages of 100. */
export const MAX_PAGES = 10;
/** Collection stops at 5,000 config-class files (`study/plan.md` §9). */
export const FILE_CAP = 5_000;
/** Git's mode for a symbolic link. Its blob is the link target, not a file. */
const SYMLINK_MODE = '120000';

export interface CollectDeps {
  github: CollectorGitHub;
  store: CorpusStore;
  /** Keys the redaction hashes (C-2). Never published (P-11). */
  salt: string;
  logger: Logger;
}

export interface CollectOptions {
  /** Stop after this many repositories have been expanded in this run. */
  maxRepos?: number;
  /** Aborted by SIGINT. The run stops between requests and is labelled partial. */
  signal?: AbortSignal;
  /** The file cap. Defaults to `FILE_CAP`; tests lower it. */
  fileCap?: number;
}

/**
 * Why a run stopped. Only `exhausted` is a complete run; every other reason is
 * partial (C-8). `repo-errors` means every slice and repository was reached
 * but at least one repository failed with an API error, so it is retried on
 * the next run rather than counted as done.
 */
export type StopReason =
  'exhausted' | 'file-cap' | 'max-repos' | 'aborted' | 'repo-errors' | 'error';

export interface CollectResult {
  run_id: string;
  status: 'complete' | 'partial';
  stop_reason: StopReason;
  pages_fetched: number;
  repos_expanded: number;
  repos_skipped: number;
  repos_failed: number;
  files_written: number;
}

/** A queued repository: the slices that found it and, per path, the slices that hit it. */
interface Queued {
  sliceIds: Set<string>;
  paths: Map<string, Set<string>>;
}

interface Counts {
  pages_fetched: number;
  repos_expanded: number;
  repos_skipped: number;
  repos_failed: number;
  files_written: number;
}

/**
 * Runs one collection and appends its run record, `complete` only when every
 * slice was exhausted and every queued repository expanded. An error that is
 * not a GitHub API error still writes a `partial` run record, then rethrows.
 */
export async function collect(
  deps: CollectDeps,
  options: CollectOptions = {},
): Promise<CollectResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const counts: Counts = {
    pages_fetched: 0,
    repos_expanded: 0,
    repos_skipped: 0,
    repos_failed: 0,
    files_written: 0,
  };
  const finish = (stopReason: StopReason): CollectResult => {
    const status = stopReason === 'exhausted' ? 'complete' : 'partial';
    deps.store.appendRun({
      run_id: runId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      status,
      stop_reason: stopReason,
    });
    const result = { run_id: runId, status, stop_reason: stopReason, ...counts } as const;
    deps.logger.info(result, 'collect run finished');
    return result;
  };

  let stopReason: StopReason;
  try {
    stopReason = await run(deps, options, counts);
  } catch (err) {
    finish('error');
    throw err;
  }
  return finish(stopReason);
}

async function run(
  deps: CollectDeps,
  options: CollectOptions,
  counts: Counts,
): Promise<StopReason> {
  const { github, store, logger } = deps;
  const fileCap = options.fileCap ?? FILE_CAP;
  const aborted = (): boolean => options.signal?.aborted === true;

  const doneFiles = store.completedFiles();
  if (doneFiles.size >= fileCap) return 'file-cap';

  // Discover. A recorded page is not fetched again; its queued items come
  // from the record instead, so a resumed run rebuilds the same queue.
  const recorded = new Map<string, Map<number, ResponseRecord>>();
  for (const record of store.responses()) {
    const pages = recorded.get(record.slice_id) ?? new Map<number, ResponseRecord>();
    pages.set(record.page, record);
    recorded.set(record.slice_id, pages);
  }
  const queue = new Map<string, Queued>();
  for (const slice of buildSlices()) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let record = recorded.get(slice.id)?.get(page);
      if (record === undefined) {
        if (aborted()) return 'aborted';
        const result = await github.searchCode(slice.query, page);
        record = {
          slice_id: slice.id,
          query: slice.query,
          page,
          total_count: result.total_count,
          incomplete_results: result.incomplete_results,
          retrieved_at: new Date().toISOString(),
          item_count: result.items.length,
          // Forks and private repositories are never queued (C-6, P-14), and
          // nothing about them is recorded.
          items: result.items
            .filter((item) => !item.repository.fork && !item.repository.private)
            .map((item) => ({ repo: item.repository.full_name, path: item.path })),
        };
        store.appendResponse(record);
        counts.pages_fetched++;
        logger.info(
          {
            slice: slice.id,
            page,
            total_count: record.total_count,
            incomplete_results: record.incomplete_results,
            items: record.item_count,
            queued: record.items.length,
          },
          'search page recorded',
        );
      }
      enqueue(queue, slice.id, record.items);
      if (isLastPage(record)) break;
    }
  }

  // Expand.
  const doneRepos = store.completedRepos();
  let attempted = 0;
  for (const [fullName, queued] of queue) {
    if (doneRepos.has(fullName)) continue;
    if (aborted()) return 'aborted';
    if (doneFiles.size >= fileCap) return 'file-cap';
    if (options.maxRepos !== undefined && attempted >= options.maxRepos) return 'max-repos';
    attempted++;
    let outcome: RepoOutcome;
    try {
      outcome = await expandRepo(deps, fullName, queued, {
        doneFiles,
        fileCap,
        aborted,
        counts,
      });
    } catch (err) {
      const status = apiErrorStatus(err);
      if (status === null) throw err;
      // A GitHub API error on one repository (deleted, emptied, blocked since
      // it was found) must not end the run. The repository is not recorded as
      // done, so the next run retries it, and this run ends `repo-errors`,
      // which is partial.
      counts.repos_failed++;
      logger.warn({ repo: fullName, status }, 'repo expansion failed; retried next run');
      continue;
    }
    if (outcome === 'aborted' || outcome === 'file-cap') return outcome;
    if (outcome === 'skipped') counts.repos_skipped++;
    else counts.repos_expanded++;
  }
  return counts.repos_failed > 0 ? 'repo-errors' : 'exhausted';
}

/** The last page of a slice: the page cap, a short page, or the end of `total_count`. */
function isLastPage(record: ResponseRecord): boolean {
  return (
    record.page >= MAX_PAGES ||
    record.item_count < SEARCH_PAGE_SIZE ||
    record.page * SEARCH_PAGE_SIZE >= record.total_count
  );
}

function enqueue(queue: Map<string, Queued>, sliceId: string, items: SearchHit[]): void {
  for (const { repo, path } of items) {
    const queued: Queued = queue.get(repo) ?? { sliceIds: new Set(), paths: new Map() };
    queued.sliceIds.add(sliceId);
    const slices = queued.paths.get(path) ?? new Set<string>();
    slices.add(sliceId);
    queued.paths.set(path, slices);
    queue.set(repo, queued);
  }
}

type RepoOutcome = 'done' | 'skipped' | 'aborted' | 'file-cap';

interface ExpandState {
  /** Files already recorded, by `fileKey`. Grows as this run records more. */
  doneFiles: Set<string>;
  fileCap: number;
  aborted: () => boolean;
  counts: Counts;
}

/**
 * Collects every target file in one repository at its default-branch head,
 * then appends the repository record, last, which marks it done. A stop
 * partway through leaves it unrecorded, and the next run resumes it, skipping
 * the files it already recorded at the same commit.
 */
async function expandRepo(
  deps: CollectDeps,
  fullName: string,
  queued: Queued,
  state: ExpandState,
): Promise<RepoOutcome> {
  const { github, store, logger } = deps;
  const [owner, name, ...rest] = fullName.split('/');
  if (!owner || !name || rest.length > 0) {
    logger.warn('repo skipped: full name is not owner/name');
    return 'skipped';
  }

  const meta = await github.getRepo(owner, name);
  if (meta.private || meta.fork) {
    // Nothing from a private repository is kept (P-14), its name included,
    // and forks are excluded (C-6). Neither is recorded, so nothing is written.
    logger.info({ reason: meta.private ? 'private' : 'fork' }, 'repo skipped');
    return 'skipped';
  }

  const head = await github.getHeadCommit(owner, name, meta.default_branch);
  const tree = await github.getTree(owner, name, head.tree_sha);
  const targets = tree.entries.flatMap((entry) => {
    // Only regular files: not directories, submodules or symlinks.
    if (entry.type !== 'blob' || entry.mode === SYMLINK_MODE) return [];
    // A path matchTarget rejects (`..`, absolute, NUL) is never fetched.
    const match = matchTarget(entry.path);
    return match === null ? [] : [{ entry, match }];
  });

  let files = 0;
  let redactions = 0;
  for (const { entry, match } of targets) {
    const key = fileKey(fullName, head.sha, entry.path);
    if (state.doneFiles.has(key)) continue;
    if (state.aborted()) return 'aborted';
    if (state.doneFiles.size >= state.fileCap) return 'file-cap';
    const hits = await collectFile(deps, { owner, name, fullName }, head.sha, entry, match, queued);
    if (hits === null) continue;
    state.doneFiles.add(key);
    state.counts.files_written++;
    files++;
    redactions += hits;
  }

  store.appendRepo({
    full_name: fullName,
    owner,
    stars: meta.stars,
    pushed_at: meta.pushed_at,
    default_branch: meta.default_branch,
    head_commit: head.sha,
    tree_truncated: tree.truncated,
    slice_ids: [...queued.sliceIds].sort(),
  });
  logger.info(
    { repo: fullName, files, redactions, tree_truncated: tree.truncated },
    'repo expanded',
  );
  return 'done';
}

// Fatal, so malformed input is refused rather than silently replaced, and
// the BOM is kept so redaction offsets count bytes of the original file.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Fetches, redacts and records one file, and returns how many values were
 * redacted, or `null` when the file was skipped. The raw text exists only in
 * memory between the blob fetch and `redact`; everything after that, including
 * every write, sees the redacted text only (C-1).
 *
 * Writes go file copy, then redactions, then the file record, so the file
 * record is the last write and marks the file done: a run stopped in between
 * redoes the file rather than leaving it recorded without its redactions.
 */
async function collectFile(
  deps: CollectDeps,
  repo: { owner: string; name: string; fullName: string },
  commitSha: string,
  entry: TreeEntry,
  match: TargetMatch,
  queued: Queued,
): Promise<number | null> {
  const { github, store, logger, salt } = deps;
  const bytes = await github.getBlob(repo.owner, repo.name, entry.sha);
  const retrievedAt = new Date().toISOString();
  let raw: string;
  try {
    raw = UTF8.decode(bytes);
  } catch (err) {
    // The decoder throws a TypeError with a fixed message and no content
    // when the bytes are not UTF-8. Such a file is not a text config, so it
    // is skipped and not recorded.
    if (!(err instanceof TypeError)) throw err;
    logger.warn({ repo: repo.fullName, path: entry.path }, 'file skipped: not UTF-8');
    return null;
  }
  const redacted = redact(raw, salt);

  const lastCommit = await github.lastCommitForPath(repo.owner, repo.name, entry.path);
  try {
    store.writeFile(repo.owner, repo.name, entry.path, redacted.text);
  } catch (err) {
    // A path matchTarget accepts but the store's guard refuses (a backslash,
    // say). Nothing was written; the error message is fixed.
    if (!(err instanceof CorpusPathError)) throw err;
    logger.warn({ repo: repo.fullName, path: entry.path }, 'file skipped: path refused by store');
    return null;
  }
  for (const hit of redacted.hits) {
    store.appendRedaction({
      repo: repo.fullName,
      commit_sha: commitSha,
      path: entry.path,
      detector: hit.detector,
      value_type: hit.valueType,
      offset: hit.offset,
      hash: hit.hash,
    });
  }
  const searchSlices = queued.paths.get(entry.path);
  store.appendFile({
    repo: repo.fullName,
    owner: repo.owner,
    commit_sha: commitSha,
    path: entry.path,
    blob_sha: entry.sha,
    class: match.class,
    kind: match.kind,
    client: match.client,
    size: bytes.length,
    retrieved_at: retrievedAt,
    // A file a search hit returned was surfaced by those slices; any other
    // target file in the tree was surfaced by the slices that found its repo.
    surfaced_by:
      searchSlices === undefined
        ? { slice_ids: [...queued.sliceIds].sort(), via: 'tree' }
        : { slice_ids: [...searchSlices].sort(), via: 'search' },
    last_commit_at: lastCommit?.committed_at ?? null,
    content_hash: sha256(redacted.text.replace(/\r\n/g, '\n')),
  });
  return redacted.hits.length;
}
