import { describe, expect, it } from 'vitest';
import {
  MAX_LIMIT_RETRIES,
  SEARCH_INTERVAL_MS,
  createCollectorGitHub,
  createPacer,
  limitHandlers,
  type CollectorGitHub,
} from '../src/github.js';
import { createLogger } from '../src/logger.js';

// No test here reaches the network: every request goes to a stub `fetch` that
// answers from the hand-written fixtures below.

const BLOB_MARKER = 'fake-blob-content-marker-for-github-test';

interface Recorded {
  method: string;
  url: URL;
}

type Reply = { status?: number; headers?: Record<string, string>; body: unknown };

function stubFetch(replies: Reply[]): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ method: init?.method ?? 'GET', url });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('unexpected request');
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  return { fetch: stub, calls };
}

const TOKEN = 'test-token-not-a-credential';

/**
 * The production client over the stub, plugins included, with the search pacer
 * replaced by one that records each call and how many requests preceded it.
 */
function client(replies: Reply[]): { github: CollectorGitHub; calls: Recorded[]; paced: number[] } {
  const { fetch, calls } = stubFetch(replies);
  const paced: number[] = [];
  const github = createCollectorGitHub({
    token: TOKEN,
    logger: createLogger('info', capture().stream),
    fetch,
    paceSearch: async () => void paced.push(calls.length),
  });
  return { github, calls, paced };
}

function capture(): { lines: string[]; stream: { write: (line: string) => void } } {
  const lines: string[] = [];
  return { lines, stream: { write: (line: string) => void lines.push(line) } };
}

const searchFixture = {
  total_count: 1234,
  incomplete_results: true,
  items: [
    {
      name: 'mcp.json',
      path: '.cursor/mcp.json',
      sha: 'aaaa1111',
      url: 'https://api.github.test/repositories/1/contents/.cursor/mcp.json',
      git_url: 'https://api.github.test/repositories/1/git/blobs/aaaa1111',
      html_url: 'https://github.test/octo/demo/blob/main/.cursor/mcp.json',
      score: 1,
      repository: {
        id: 1,
        name: 'demo',
        full_name: 'octo/demo',
        owner: { login: 'octo', id: 2 },
        private: false,
        fork: false,
      },
    },
    {
      name: 'mcp.json',
      path: 'mcp.json',
      sha: 'bbbb2222',
      score: 1,
      repository: {
        id: 3,
        name: 'copy',
        full_name: 'someone/copy',
        owner: { login: 'someone', id: 4 },
        private: false,
        fork: true,
      },
    },
  ],
};

describe('CollectorGitHub.searchCode', () => {
  it('maps items and passes total_count and incomplete_results through (C-4)', async () => {
    const { github, calls, paced } = client([{ body: searchFixture }]);
    const page = await github.searchCode('filename:mcp.json', 3);
    // The pacer ran once, before the request went out.
    expect(paced).toEqual([0]);
    expect(page).toEqual({
      total_count: 1234,
      incomplete_results: true,
      items: [
        {
          path: '.cursor/mcp.json',
          sha: 'aaaa1111',
          repository: {
            full_name: 'octo/demo',
            owner: 'octo',
            name: 'demo',
            fork: false,
            private: false,
          },
        },
        {
          path: 'mcp.json',
          sha: 'bbbb2222',
          repository: {
            full_name: 'someone/copy',
            owner: 'someone',
            name: 'copy',
            fork: true,
            private: false,
          },
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe('/search/code');
    expect(calls[0]?.url.searchParams.get('q')).toBe('filename:mcp.json');
    expect(calls[0]?.url.searchParams.get('page')).toBe('3');
    expect(calls[0]?.url.searchParams.get('per_page')).toBe('100');
  });

  it('keeps incomplete_results false when the response says false', async () => {
    const { github } = client([{ body: { total_count: 0, incomplete_results: false, items: [] } }]);
    const page = await github.searchCode('filename:mcp.json', 1);
    expect(page).toEqual({ total_count: 0, incomplete_results: false, items: [] });
  });
});

describe('CollectorGitHub.getRepo', () => {
  it('maps stars, pushed_at, default_branch, fork, private and archived', async () => {
    const { github, calls } = client([
      {
        body: {
          id: 1,
          name: 'demo',
          full_name: 'octo/demo',
          stargazers_count: 42,
          pushed_at: '2026-08-01T12:00:00Z',
          default_branch: 'trunk',
          fork: false,
          private: false,
          archived: true,
          watchers_count: 42,
        },
      },
    ]);
    expect(await github.getRepo('octo', 'demo')).toEqual({
      stars: 42,
      pushed_at: '2026-08-01T12:00:00Z',
      default_branch: 'trunk',
      fork: false,
      private: false,
      archived: true,
    });
    expect(calls[0]?.url.pathname).toBe('/repos/octo/demo');
  });
});

describe('CollectorGitHub.getTree', () => {
  it('requests the tree recursively and maps entries and truncated', async () => {
    const { github, calls } = client([
      {
        body: {
          sha: 'tree0000',
          url: 'https://api.github.test/repos/octo/demo/git/trees/tree0000',
          truncated: true,
          tree: [
            { path: '.cursor', mode: '040000', type: 'tree', sha: 'tree1111' },
            {
              path: '.cursor/mcp.json',
              mode: '100644',
              type: 'blob',
              sha: 'aaaa1111',
              size: 120,
            },
            { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'cccc3333' },
          ],
        },
      },
    ]);
    expect(await github.getTree('octo', 'demo', 'tree0000')).toEqual({
      sha: 'tree0000',
      truncated: true,
      entries: [
        { path: '.cursor', mode: '040000', type: 'tree', sha: 'tree1111' },
        { path: '.cursor/mcp.json', mode: '100644', type: 'blob', sha: 'aaaa1111', size: 120 },
        { path: 'vendor/lib', mode: '160000', type: 'commit', sha: 'cccc3333' },
      ],
    });
    expect(calls[0]?.url.pathname).toBe('/repos/octo/demo/git/trees/tree0000');
    expect(calls[0]?.url.searchParams.get('recursive')).toBe('true');
  });
});

describe('CollectorGitHub.getBlob', () => {
  it('decodes base64 content to bytes', async () => {
    const bytes = Buffer.from(`{"note":"${BLOB_MARKER}"}\né`, 'utf8');
    // GitHub wraps base64 blob content at 60 characters.
    const wrapped = (bytes.toString('base64').match(/.{1,60}/g) ?? []).join('\n');
    const { github, calls } = client([
      { body: { sha: 'aaaa1111', size: bytes.length, encoding: 'base64', content: wrapped } },
    ]);
    const blob = await github.getBlob('octo', 'demo', 'aaaa1111');
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob.equals(bytes)).toBe(true);
    expect(calls[0]?.url.pathname).toBe('/repos/octo/demo/git/blobs/aaaa1111');
  });

  it('keeps binary content byte for byte', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x7f]);
    const { github } = client([
      {
        body: { sha: 'dddd4444', size: 5, encoding: 'base64', content: bytes.toString('base64') },
      },
    ]);
    expect((await github.getBlob('octo', 'demo', 'dddd4444')).equals(bytes)).toBe(true);
  });

  it('decodes utf-8 content to bytes', async () => {
    const { github } = client([
      { body: { sha: 'aaaa1111', size: 3, encoding: 'utf-8', content: 'hé' } },
    ]);
    const blob = await github.getBlob('octo', 'demo', 'aaaa1111');
    expect(blob.equals(Buffer.from('hé', 'utf8'))).toBe(true);
  });

  it('rejects an unknown encoding without the content in the error', async () => {
    const { github } = client([
      { body: { sha: 'aaaa1111', size: 1, encoding: BLOB_MARKER, content: BLOB_MARKER } },
    ]);
    const error = await github.getBlob('octo', 'demo', 'aaaa1111').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Unsupported blob encoding');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(BLOB_MARKER);
  });
});

describe('CollectorGitHub.lastCommitForPath', () => {
  it('asks for one commit on the path and returns its sha and committer date', async () => {
    const { github, calls } = client([
      {
        body: [
          {
            sha: 'eeee5555',
            commit: {
              author: { name: 'A', email: 'a@example.test', date: '2026-01-01T00:00:00Z' },
              committer: { name: 'C', email: 'c@example.test', date: '2026-02-02T00:00:00Z' },
              message: 'update',
            },
          },
        ],
      },
    ]);
    expect(await github.lastCommitForPath('octo', 'demo', '.cursor/mcp.json')).toEqual({
      sha: 'eeee5555',
      committed_at: '2026-02-02T00:00:00Z',
    });
    expect(calls[0]?.url.pathname).toBe('/repos/octo/demo/commits');
    expect(calls[0]?.url.searchParams.get('path')).toBe('.cursor/mcp.json');
    expect(calls[0]?.url.searchParams.get('per_page')).toBe('1');
  });

  it('falls back to the author date when there is no committer', async () => {
    const { github } = client([
      {
        body: [
          {
            sha: 'eeee5555',
            commit: { author: { date: '2026-01-01T00:00:00Z' }, committer: null, message: 'x' },
          },
        ],
      },
    ]);
    expect(await github.lastCommitForPath('octo', 'demo', 'mcp.json')).toEqual({
      sha: 'eeee5555',
      committed_at: '2026-01-01T00:00:00Z',
    });
  });

  it('returns null when no commit touches the path', async () => {
    const { github } = client([{ body: [] }]);
    expect(await github.lastCommitForPath('octo', 'demo', 'mcp.json')).toBeNull();
  });
});

describe('createPacer', () => {
  it('spaces calls at least the interval apart, in order', async () => {
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const pace = createPacer(
      SEARCH_INTERVAL_MS,
      () => clock,
      async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    );
    await Promise.all([pace(), pace(), pace()]);
    expect(sleeps).toEqual([SEARCH_INTERVAL_MS, SEARCH_INTERVAL_MS]);

    clock += SEARCH_INTERVAL_MS - 1_000;
    await pace();
    expect(sleeps).toEqual([SEARCH_INTERVAL_MS, SEARCH_INTERVAL_MS, 1_000]);

    clock += SEARCH_INTERVAL_MS * 2;
    await pace();
    expect(sleeps).toHaveLength(3);
  });

  it('keeps code search to 10 requests a minute', () => {
    expect(60_000 / SEARCH_INTERVAL_MS).toBe(10);
  });
});

describe('limitHandlers', () => {
  it('logs the limit kind, wait and retry count only, and retries up to the cap', () => {
    const { lines, stream } = capture();
    const { onRateLimit, onSecondaryRateLimit } = limitHandlers(createLogger('info', stream));
    const options = { method: 'GET', url: `/search/code?q=${BLOB_MARKER}` };

    expect(onRateLimit(30, options, {}, 0)).toBe(true);
    expect(onSecondaryRateLimit(60, options, {}, MAX_LIMIT_RETRIES - 1)).toBe(true);
    expect(onSecondaryRateLimit(60, options, {}, MAX_LIMIT_RETRIES)).toBe(false);

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      records.map(({ limit, retryAfterSeconds, retryCount, retry, msg }) => ({
        limit,
        retryAfterSeconds,
        retryCount,
        retry,
        msg,
      })),
    ).toEqual([
      {
        limit: 'primary',
        retryAfterSeconds: 30,
        retryCount: 0,
        retry: true,
        msg: 'github rate limit hit',
      },
      {
        limit: 'secondary',
        retryAfterSeconds: 60,
        retryCount: MAX_LIMIT_RETRIES - 1,
        retry: true,
        msg: 'github rate limit hit',
      },
      {
        limit: 'secondary',
        retryAfterSeconds: 60,
        retryCount: MAX_LIMIT_RETRIES,
        retry: false,
        msg: 'github rate limit hit',
      },
    ]);
    for (const line of lines) expect(line).not.toContain(BLOB_MARKER);
  });
});

describe('createCollectorGitHub', () => {
  it('retries a secondary rate limit through the throttling plugin and logs it', async () => {
    const { lines, stream } = capture();
    const { fetch, calls } = stubFetch([
      {
        status: 403,
        headers: { 'retry-after': '1' },
        body: { message: `You have exceeded a secondary rate limit ${BLOB_MARKER}` },
      },
      { body: { sha: 'tree0000', truncated: false, tree: [] } },
    ]);
    const github = createCollectorGitHub({
      token: TOKEN,
      logger: createLogger('info', stream),
      fetch,
      paceSearch: async () => {},
    });

    expect(await github.getTree('octo', 'demo', 'tree0000')).toEqual({
      sha: 'tree0000',
      truncated: false,
      entries: [],
    });
    expect(calls).toHaveLength(2);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(record['limit']).toBe('secondary');
    expect(record['retryAfterSeconds']).toBe(1);
    expect(record['retryCount']).toBe(0);
    expect(lines[0]).not.toContain(BLOB_MARKER);
  });
});
