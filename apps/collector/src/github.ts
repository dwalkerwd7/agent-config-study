import { Octokit, RequestError } from 'octokit';
import type { Logger } from 'pino';

/**
 * The thin GitHub client the collect loop uses. The loop depends on the
 * `CollectorGitHub` interface, so its tests can pass a fake.
 *
 * Nothing here fetches, resolves or follows anything a collected file names
 * (rubric §4): every request is built from a search query, a repository name or
 * a SHA the API itself returned. A blob comes back as bytes and is never
 * logged, and no error raised here carries its content.
 */

/** One code search hit. `fork` and `private` are passed on for the loop to filter (C-6, P-14). */
export interface CodeSearchItem {
  path: string;
  /** The blob SHA of the matched file. */
  sha: string;
  repository: {
    full_name: string;
    owner: string;
    name: string;
    fork: boolean;
    private: boolean;
  };
}

export interface CodeSearchPage {
  total_count: number;
  /** Passed through unchanged; a partial result set stays labelled partial (C-4). */
  incomplete_results: boolean;
  items: CodeSearchItem[];
}

export interface RepoMetadata {
  stars: number;
  pushed_at: string | null;
  default_branch: string;
  fork: boolean;
  private: boolean;
  archived: boolean;
}

export interface TreeEntry {
  path: string;
  mode: string;
  /** `blob`, `tree` or `commit` (a submodule). */
  type: string;
  sha: string;
  /** Present for blobs only. */
  size?: number;
}

export interface Tree {
  sha: string;
  entries: TreeEntry[];
  /** True when GitHub cut the recursive listing short. */
  truncated: boolean;
}

export interface LastCommit {
  sha: string;
  /** The committer date, falling back to the author date. */
  committed_at: string | null;
}

/** A branch's head commit and that commit's root tree. */
export interface HeadCommit {
  sha: string;
  tree_sha: string;
}

export interface CollectorGitHub {
  searchCode(q: string, page: number): Promise<CodeSearchPage>;
  getRepo(owner: string, repo: string): Promise<RepoMetadata>;
  /**
   * The commit at the head of `branch`, with its tree. The collect loop reads
   * the tree by this commit's `tree_sha`, so the files it collects and the
   * commit it records for them are the same snapshot (C-3).
   */
  getHeadCommit(owner: string, repo: string, branch: string): Promise<HeadCommit>;
  /** The recursive tree at `sha`. */
  getTree(owner: string, repo: string, sha: string): Promise<Tree>;
  /** The blob's decoded bytes. */
  getBlob(owner: string, repo: string, sha: string): Promise<Buffer>;
  /** The most recent commit touching `path` on the default branch, or `null` when there is none. */
  lastCommitForPath(owner: string, repo: string, path: string): Promise<LastCommit | null>;
}

/**
 * The HTTP status of a failed GitHub request, or `null` when `err` is not one
 * (a disk error, a bug). The collect loop skips a repository on the first kind
 * and stops on the second.
 */
export function apiErrorStatus(err: unknown): number | null {
  return err instanceof RequestError ? err.status : null;
}

/** Code search allows 10 requests per minute for an authenticated user. */
export const SEARCH_INTERVAL_MS = 6_000;
/** Search results per page: the API's maximum. */
export const SEARCH_PAGE_SIZE = 100;
/** How many times a request that hit a rate limit is retried before it fails. */
export const MAX_LIMIT_RETRIES = 3;

type LimitKind = 'primary' | 'secondary';
type LimitHandler = (
  retryAfter: number,
  options: unknown,
  octokit: unknown,
  retryCount: number,
) => boolean;

/**
 * Handlers for the throttling plugin. Each logs the kind of limit, the wait and
 * the retry count, and nothing else: no URL, query or response body. Returning
 * true retries after `retryAfter` seconds.
 */
export function limitHandlers(logger: Logger): {
  onRateLimit: LimitHandler;
  onSecondaryRateLimit: LimitHandler;
} {
  const handler =
    (limit: LimitKind): LimitHandler =>
    (retryAfter, _options, _octokit, retryCount) => {
      const retry = retryCount < MAX_LIMIT_RETRIES;
      logger.warn(
        { limit, retryAfterSeconds: retryAfter, retryCount, retry },
        'github rate limit hit',
      );
      return retry;
    };
  return { onRateLimit: handler('primary'), onSecondaryRateLimit: handler('secondary') };
}

/**
 * Spaces calls at least `intervalMs` apart, in call order. The throttling
 * plugin's own search limiter spaces requests 2 s apart (30 a minute, the
 * limit for the other search endpoints); code search allows only 10.
 */
export function createPacer(
  intervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): () => Promise<void> {
  let nextAt = 0;
  let queue: Promise<void> = Promise.resolve();
  return () => {
    const turn = queue.then(async () => {
      const wait = nextAt - now();
      if (wait > 0) await sleep(wait);
      nextAt = now() + intervalMs;
    });
    queue = turn;
    return turn;
  };
}

export interface CollectorGitHubOptions {
  token: string;
  logger: Logger;
  /** Replaces the HTTP layer under the plugins. Only tests pass it. */
  fetch?: typeof globalThis.fetch;
  /** Awaited before each code search. Defaults to 10 a minute; tests pass a no-op. */
  paceSearch?: () => Promise<void>;
}

/**
 * The production client: Octokit with auth and the bundled throttling and
 * retry plugins, whose limit handlers log and retry, and code search paced to
 * 10 requests a minute.
 */
export function createCollectorGitHub(options: CollectorGitHubOptions): CollectorGitHub {
  const octokit = new Octokit({
    auth: options.token,
    throttle: limitHandlers(options.logger),
    ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
  });
  return new OctokitCollectorGitHub(octokit, options.paceSearch ?? createPacer(SEARCH_INTERVAL_MS));
}

class OctokitCollectorGitHub implements CollectorGitHub {
  readonly #octokit: Octokit;
  readonly #paceSearch: () => Promise<void>;

  constructor(octokit: Octokit, paceSearch: () => Promise<void>) {
    this.#octokit = octokit;
    this.#paceSearch = paceSearch;
  }

  async searchCode(q: string, page: number): Promise<CodeSearchPage> {
    await this.#paceSearch();
    const { data } = await this.#octokit.rest.search.code({
      q,
      page,
      per_page: SEARCH_PAGE_SIZE,
    });
    return {
      total_count: data.total_count,
      incomplete_results: data.incomplete_results,
      items: data.items.map((item) => ({
        path: item.path,
        sha: item.sha,
        repository: {
          full_name: item.repository.full_name,
          owner: item.repository.owner.login,
          name: item.repository.name,
          fork: item.repository.fork,
          private: item.repository.private,
        },
      })),
    };
  }

  async getRepo(owner: string, repo: string): Promise<RepoMetadata> {
    const { data } = await this.#octokit.rest.repos.get({ owner, repo });
    return {
      stars: data.stargazers_count,
      pushed_at: data.pushed_at,
      default_branch: data.default_branch,
      fork: data.fork,
      private: data.private,
      archived: data.archived,
    };
  }

  async getHeadCommit(owner: string, repo: string, branch: string): Promise<HeadCommit> {
    const { data } = await this.#octokit.rest.repos.getBranch({ owner, repo, branch });
    return { sha: data.commit.sha, tree_sha: data.commit.commit.tree.sha };
  }

  async getTree(owner: string, repo: string, sha: string): Promise<Tree> {
    const { data } = await this.#octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: sha,
      recursive: 'true',
    });
    return {
      sha: data.sha,
      truncated: data.truncated,
      entries: data.tree.map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        sha: entry.sha,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      })),
    };
  }

  async getBlob(owner: string, repo: string, sha: string): Promise<Buffer> {
    const { data } = await this.#octokit.rest.git.getBlob({ owner, repo, file_sha: sha });
    if (data.encoding === 'base64') return Buffer.from(data.content, 'base64');
    if (data.encoding === 'utf-8') return Buffer.from(data.content, 'utf8');
    // The encoding is API metadata, not file content, but the message stays
    // fixed so that nothing read from the response reaches an error.
    throw new Error('Unsupported blob encoding');
  }

  async lastCommitForPath(owner: string, repo: string, path: string): Promise<LastCommit | null> {
    const { data } = await this.#octokit.rest.repos.listCommits({
      owner,
      repo,
      path,
      per_page: 1,
    });
    const commit = data[0];
    if (commit === undefined) return null;
    return {
      sha: commit.sha,
      committed_at: commit.commit.committer?.date ?? commit.commit.author?.date ?? null,
    };
  }
}
