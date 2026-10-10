import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/hash.js';
import { RequestError } from 'octokit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExclusionMismatchError, collect, type CollectOptions } from '../src/collect.js';
import { UsageError, runCli } from '../src/cli.js';
import type {
  CodeSearchItem,
  CodeSearchPage,
  CollectorGitHub,
  HeadCommit,
  LastCommit,
  RepoMetadata,
  Tree,
  TreeEntry,
} from '../src/github.js';
import { createLogger } from '../src/logger.js';
import { SIZE_BANDS, buildSlices, type Slice } from '../src/queries.js';
import { CorpusStore } from '../src/store.js';
import { matchTarget } from '../src/targets.js';
import { FAKE } from './credential-fixtures.js';

// No test here reaches the network or runs the CLI entry point: every GitHub
// call goes to the in-memory fake below, and every store is a temp dir.

const SALT = 'collect-test-salt-0123456789abcdef0123456789';
const SLICES = buildSlices();
/** The slice for a target pattern and an index into `SIZE_BANDS`. */
function sliceOf(pattern: string, band = 0): Slice {
  const slice = SLICES.find(
    (candidate) =>
      candidate.target.pattern === pattern && candidate.id.endsWith(`@${SIZE_BANDS[band] ?? ''}`),
  );
  if (slice === undefined) throw new Error(`no slice for ${pattern} band ${String(band)}`);
  return slice;
}
function firstSlice(pattern: string): Slice {
  return sliceOf(pattern, 0);
}
const MCP_SLICE = firstSlice('.mcp.json');
const CLAUDE_SLICE = firstSlice('CLAUDE.md');

interface FakeRepo {
  meta: RepoMetadata;
  head: HeadCommit;
  tree: Tree;
  blobs: Map<string, Buffer>;
}

/** An in-memory `CollectorGitHub` that records every call it answers. */
class FakeGitHub implements CollectorGitHub {
  readonly calls: string[] = [];
  readonly pages = new Map<string, CodeSearchPage>();
  readonly repos = new Map<string, FakeRepo>();
  /** Repos whose `getRepo` fails with this HTTP status. */
  readonly failing = new Map<string, number>();
  /** Called after each blob is served, so a test can abort mid-repo. */
  onBlob: (sha: string) => void = () => {};

  setPage(query: string, page: number, result: CodeSearchPage): void {
    this.pages.set(`${query}#${String(page)}`, result);
  }

  searchCode(q: string, page: number): Promise<CodeSearchPage> {
    this.calls.push(`search ${q} #${String(page)}`);
    const result = this.pages.get(`${q}#${String(page)}`);
    return Promise.resolve(result ?? { total_count: 0, incomplete_results: false, items: [] });
  }

  getRepo(owner: string, repo: string): Promise<RepoMetadata> {
    this.calls.push(`repo ${owner}/${repo}`);
    const status = this.failing.get(`${owner}/${repo}`);
    if (status !== undefined) {
      return Promise.reject(
        new RequestError('Not Found', status, {
          request: {
            method: 'GET',
            url: `https://api.github.test/repos/${owner}/${repo}`,
            headers: {},
          },
        }),
      );
    }
    return Promise.resolve(this.repo(owner, repo).meta);
  }

  getHeadCommit(owner: string, repo: string, branch: string): Promise<HeadCommit> {
    this.calls.push(`head ${owner}/${repo} ${branch}`);
    return Promise.resolve(this.repo(owner, repo).head);
  }

  getTree(owner: string, repo: string, sha: string): Promise<Tree> {
    this.calls.push(`tree ${owner}/${repo} ${sha}`);
    const fake = this.repo(owner, repo);
    if (sha !== fake.head.tree_sha) throw new Error('tree requested by the wrong sha');
    return Promise.resolve(fake.tree);
  }

  getBlob(owner: string, repo: string, sha: string): Promise<Buffer> {
    this.calls.push(`blob ${owner}/${repo} ${sha}`);
    const blob = this.repo(owner, repo).blobs.get(sha);
    if (blob === undefined) throw new Error('unknown blob');
    this.onBlob(sha);
    return Promise.resolve(blob);
  }

  lastCommitForPath(owner: string, repo: string, path: string): Promise<LastCommit | null> {
    this.calls.push(`commit ${owner}/${repo} ${path}`);
    return Promise.resolve({ sha: 'c'.repeat(40), committed_at: '2026-05-05T00:00:00Z' });
  }

  private repo(owner: string, repo: string): FakeRepo {
    const fake = this.repos.get(`${owner}/${repo}`);
    if (fake === undefined) throw new Error('unknown repo');
    return fake;
  }
}

function hit(fullName: string, path: string, flags: { fork?: boolean; private?: boolean } = {}) {
  const [owner = '', name = ''] = fullName.split('/');
  return {
    path,
    sha: 'f'.repeat(40),
    repository: {
      full_name: fullName,
      owner,
      name,
      fork: flags.fork ?? false,
      private: flags.private ?? false,
    },
  } satisfies CodeSearchItem;
}

let nextSha = 0;
function sha(): string {
  nextSha++;
  return nextSha.toString(16).padStart(40, '0');
}

/** Adds a repo whose tree holds `files` (path → content), plus any extra entries. */
function addRepo(
  github: FakeGitHub,
  fullName: string,
  files: Record<string, string | Buffer>,
  options: { meta?: Partial<RepoMetadata>; extra?: TreeEntry[] } = {},
): FakeRepo {
  const blobs = new Map<string, Buffer>();
  const entries: TreeEntry[] = [
    { path: 'src', mode: '040000', type: 'tree', sha: sha() },
    { path: 'src/index.ts', mode: '100644', type: 'blob', sha: sha(), size: 10 },
  ];
  for (const [path, content] of Object.entries(files)) {
    const blobSha = sha();
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    blobs.set(blobSha, bytes);
    entries.push({ path, mode: '100644', type: 'blob', sha: blobSha, size: bytes.length });
  }
  entries.push(...(options.extra ?? []));
  const fake: FakeRepo = {
    meta: {
      stars: 7,
      pushed_at: '2026-06-01T00:00:00Z',
      default_branch: 'main',
      fork: false,
      private: false,
      archived: false,
      ...options.meta,
    },
    head: { sha: sha(), tree_sha: sha() },
    tree: { sha: '', entries, truncated: false },
    blobs,
  };
  fake.tree.sha = fake.head.tree_sha;
  github.repos.set(fullName, fake);
  return fake;
}

let base: string;
let root: string;
let logLines: string[];

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'collector-collect-'));
  root = join(base, 'corpus');
  logLines = [];
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function logger() {
  return createLogger('debug', { write: (line: string) => void logLines.push(line) });
}

function run(github: FakeGitHub, options: CollectOptions = {}, at = root) {
  return collect({ github, store: new CorpusStore(at), salt: SALT, logger: logger() }, options);
}

/** Records the sampling seed a run will reuse, as the first run would have. */
function seedStore(seed: string, at = root): void {
  new CorpusStore(at).appendSampling({
    seed,
    file_cap: 5000,
    method: 'stratified-v1',
    created_at: '2026-09-01T00:00:00.000Z',
    excluded_runs: [],
    excluded_repos: 0,
  });
}

/**
 * A seed whose draw order puts `repos` in the order given, for tests where
 * they share one stratum and the order matters. It searches seeds rather than
 * fixing one, so the test does not depend on a hard-coded hash.
 */
function seedOrdering(repos: string[]): string {
  for (let i = 0; ; i++) {
    const seed = sha256(`test-seed-${String(i)}`);
    const keys = repos.map((repo) => sha256(`${seed}:${repo}`));
    if (keys.every((key, j) => j === 0 || (keys[j - 1] ?? '') < key)) return seed;
  }
}

function records(stream: string, at = root): Record<string, unknown>[] {
  const path = join(at, `${stream}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every file under the corpus root, relative to it. */
function corpusFiles(): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

function corpusText(): string {
  return corpusFiles()
    .map((path) => readFileSync(join(root, path), 'utf8'))
    .join('\n');
}

/** The two-repo world most tests start from: one hit per repo on page 1 of a slice. */
function world(): FakeGitHub {
  const github = new FakeGitHub();
  github.setPage(MCP_SLICE.query, 1, {
    total_count: 2,
    incomplete_results: false,
    items: [hit('octo/demo', '.mcp.json'), hit('acme/tools', '.mcp.json')],
  });
  addRepo(github, 'octo/demo', {
    '.mcp.json': '{"mcpServers":{}}',
    'CLAUDE.md': '# Notes\n',
  });
  addRepo(github, 'acme/tools', { '.mcp.json': '{"mcpServers":{"x":{}}}' });
  return github;
}

describe('collect: redaction before write (C-1, C-2)', () => {
  it('writes a credential only as its placeholder, and never logs it', async () => {
    const github = new FakeGitHub();
    github.setPage(MCP_SLICE.query, 1, {
      total_count: 1,
      incomplete_results: false,
      items: [hit('octo/demo', '.mcp.json')],
    });
    const content = `{"mcpServers":{"gh":{"env":{"GITHUB_TOKEN":"${FAKE.github}"}}}}\n`;
    const fake = addRepo(github, 'octo/demo', { '.mcp.json': content });

    const result = await run(github);

    expect(result.status).toBe('complete');
    const written = readFileSync(join(root, 'files/octo/demo/.mcp.json'), 'utf8');
    expect(written).toBe(content.replace(FAKE.github, '<REDACTED:github>'));
    expect(corpusText()).not.toContain(FAKE.github);
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) expect(line).not.toContain(FAKE.github);

    expect(records('redactions')).toEqual([
      {
        repo: 'octo/demo',
        commit_sha: fake.head.sha,
        path: '.mcp.json',
        detector: 'github',
        value_type: 'personal-access-token',
        offset: Buffer.byteLength(content.slice(0, content.indexOf(FAKE.github)), 'utf8'),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      },
    ]);
  });

  it('records provenance and a hash of the redacted text with CRLF normalised (C-3, C-7)', async () => {
    const github = new FakeGitHub();
    github.setPage(MCP_SLICE.query, 1, {
      total_count: 1,
      incomplete_results: true,
      items: [hit('octo/demo', '.mcp.json')],
    });
    const content = `{\r\n  "token": "${FAKE.keyedLiteral}"\r\n}\r\n`;
    const fake = addRepo(github, 'octo/demo', { '.mcp.json': content, 'AGENTS.md': 'hi\n' });

    await run(github);

    const redacted = content.replace(FAKE.keyedLiteral, '<REDACTED:keyed-literal>');
    const files = records('files');
    expect(files).toEqual([
      {
        repo: 'octo/demo',
        owner: 'octo',
        commit_sha: fake.head.sha,
        path: '.mcp.json',
        blob_sha: fake.tree.entries.find((entry) => entry.path === '.mcp.json')?.sha,
        class: 'config',
        kind: 'mcp',
        client: 'claude-code',
        size: Buffer.byteLength(content, 'utf8'),
        retrieved_at: expect.any(String) as unknown,
        surfaced_by: { slice_ids: [MCP_SLICE.id], via: 'search' },
        last_commit_at: '2026-05-05T00:00:00Z',
        content_hash: sha256(redacted.replace(/\r\n/g, '\n')),
      },
      expect.objectContaining({
        path: 'AGENTS.md',
        kind: 'instructions',
        client: 'agents-md',
        surfaced_by: { slice_ids: [MCP_SLICE.id], via: 'tree' },
      }) as unknown,
    ]);
    expect(corpusText()).not.toContain(FAKE.keyedLiteral);

    // C-4: every response is recorded, incomplete_results included.
    const responses = records('responses');
    expect(responses).toHaveLength(SLICES.length);
    expect(responses.find((record) => record['slice_id'] === MCP_SLICE.id)).toMatchObject({
      query: MCP_SLICE.query,
      page: 1,
      total_count: 1,
      incomplete_results: true,
      item_count: 1,
      items: [{ repo: 'octo/demo', path: '.mcp.json' }],
    });

    expect(records('repos')).toEqual([
      {
        full_name: 'octo/demo',
        owner: 'octo',
        stars: 7,
        pushed_at: '2026-06-01T00:00:00Z',
        default_branch: 'main',
        head_commit: fake.head.sha,
        tree_truncated: false,
        slice_ids: [MCP_SLICE.id],
        drawn_slice: MCP_SLICE.id,
      },
    ]);
  });
});

describe('collect: discovery paging', () => {
  it('pages a slice until a short page, and not past 10 pages', async () => {
    const github = new FakeGitHub();
    const full = (repo: string): CodeSearchPage => ({
      total_count: 5000,
      incomplete_results: false,
      items: Array.from({ length: 100 }, (_, i) =>
        hit(`${repo}/r${String(i)}`, 'CLAUDE.md', { fork: true }),
      ),
    });
    for (let page = 1; page <= 11; page++)
      github.setPage(MCP_SLICE.query, page, full(`p${String(page)}`));
    github.setPage(CLAUDE_SLICE.query, 1, full('c'));
    github.setPage(CLAUDE_SLICE.query, 2, {
      total_count: 5000,
      incomplete_results: false,
      items: [hit('c/short', 'CLAUDE.md', { fork: true })],
    });

    await run(github);

    const pagesOf = (query: string) =>
      github.calls
        .filter((call) => call.startsWith(`search ${query} #`))
        .map((call) => call.split('#')[1]);
    expect(pagesOf(MCP_SLICE.query)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(pagesOf(CLAUDE_SLICE.query)).toEqual(['1', '2']);
  });
});

describe('collect: resume (C-8)', () => {
  it('makes no API calls and writes no duplicates when rerun over completed data', async () => {
    const github = world();
    seedStore(seedOrdering(['octo/demo', 'acme/tools']));
    expect((await run(github)).status).toBe('complete');
    const before = {
      responses: records('responses'),
      repos: records('repos'),
      files: records('files'),
      redactions: records('redactions'),
    };
    expect(before.repos.map((record) => record['full_name'])).toEqual(['octo/demo', 'acme/tools']);
    expect(before.files).toHaveLength(3);

    github.calls.length = 0;
    const second = await run(github);

    expect(github.calls).toEqual([]);
    expect(second).toMatchObject({
      status: 'complete',
      stop_reason: 'exhausted',
      pages_fetched: 0,
    });
    expect(records('responses')).toEqual(before.responses);
    expect(records('repos')).toEqual(before.repos);
    expect(records('files')).toEqual(before.files);
    expect(records('redactions')).toEqual(before.redactions);
    expect(records('runs').map((record) => record['status'])).toEqual(['complete', 'complete']);
  });
});

describe('collect: stop conditions', () => {
  it('writes partial on --max-repos, then a rerun finishes only the rest', async () => {
    const github = world();
    seedStore(seedOrdering(['octo/demo', 'acme/tools']));

    const first = await run(github, { maxRepos: 1 });
    expect(first).toMatchObject({ status: 'partial', stop_reason: 'max-repos', repos_expanded: 1 });
    expect(records('repos').map((record) => record['full_name'])).toEqual(['octo/demo']);

    github.calls.length = 0;
    const second = await run(github);
    expect(second).toMatchObject({
      status: 'complete',
      stop_reason: 'exhausted',
      pages_fetched: 0,
    });
    expect(github.calls.filter((call) => call.startsWith('repo '))).toEqual(['repo acme/tools']);
    expect(records('runs').map((record) => [record['status'], record['stop_reason']])).toEqual([
      ['partial', 'max-repos'],
      ['complete', 'exhausted'],
    ]);
  });

  it('ends complete, not max-repos, when the cap equals what was left', async () => {
    const result = await run(world(), { maxRepos: 2 });
    expect(result).toMatchObject({ status: 'complete', stop_reason: 'exhausted' });
  });

  it('writes partial when aborted before it starts, and fetches nothing', async () => {
    const github = world();
    const controller = new AbortController();
    controller.abort();
    const result = await run(github, { signal: controller.signal });
    expect(result).toMatchObject({ status: 'partial', stop_reason: 'aborted' });
    expect(github.calls).toEqual([]);
    expect(records('runs')).toEqual([expect.objectContaining({ status: 'partial' })]);
  });

  it('stops mid-repo on abort, then resumes without recording a file twice', async () => {
    const github = world();
    seedStore(seedOrdering(['octo/demo', 'acme/tools']));
    const controller = new AbortController();
    const firstBlob = github.repos
      .get('octo/demo')
      ?.tree.entries.find((e) => e.path === '.mcp.json');
    github.onBlob = (blobSha) => {
      if (blobSha === firstBlob?.sha) controller.abort();
    };

    const first = await run(github, { signal: controller.signal });
    expect(first).toMatchObject({ status: 'partial', stop_reason: 'aborted', files_written: 1 });
    expect(records('repos')).toEqual([]);
    expect(records('files').map((record) => record['path'])).toEqual(['.mcp.json']);

    github.onBlob = () => {};
    github.calls.length = 0;
    const second = await run(github);
    expect(second).toMatchObject({ status: 'complete', files_written: 2 });
    // The file recorded before the abort is not fetched again.
    expect(github.calls).not.toContain(`blob octo/demo ${firstBlob?.sha ?? ''}`);
    const paths = records('files').map(
      (record) => `${String(record['repo'])}:${String(record['path'])}`,
    );
    expect(paths).toEqual(['octo/demo:.mcp.json', 'octo/demo:CLAUDE.md', 'acme/tools:.mcp.json']);
    expect(records('repos').map((record) => record['full_name'])).toEqual([
      'octo/demo',
      'acme/tools',
    ]);
  });

  it('writes partial at the file cap, counting files from earlier runs', async () => {
    const github = world();
    const first = await run(github, { fileCap: 2 });
    expect(first).toMatchObject({ status: 'partial', stop_reason: 'file-cap', files_written: 2 });
    expect(records('files')).toHaveLength(2);

    github.calls.length = 0;
    const second = await run(github, { fileCap: 2 });
    expect(second).toMatchObject({ status: 'partial', stop_reason: 'file-cap' });
    expect(github.calls).toEqual([]);
  });

  it('writes partial when a repo fails with an API error, and retries it next run', async () => {
    const github = world();
    github.failing.set('octo/demo', 404);
    const first = await run(github);
    expect(first).toMatchObject({ status: 'partial', stop_reason: 'repo-errors', repos_failed: 1 });
    expect(records('repos').map((record) => record['full_name'])).toEqual(['acme/tools']);

    github.failing.clear();
    const second = await run(github);
    expect(second).toMatchObject({ status: 'complete', repos_expanded: 1 });
  });

  it('records the run as partial and rethrows on an error that is not an API error', async () => {
    const github = world();
    github.getRepo = () => Promise.reject(new Error('disk on fire'));
    await expect(run(github)).rejects.toThrow('disk on fire');
    expect(records('runs')).toEqual([
      expect.objectContaining({ status: 'partial', stop_reason: 'error' }),
    ]);
  });
});

type RepoFiles = Record<string, Record<string, string>>;

/** `count` repos named `<prefix>/rN`, each holding the same `files` (path → content). */
function reposOf(prefix: string, count: number, files: Record<string, string>): RepoFiles {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${prefix}/r${String(i)}`, files] as const),
  );
}

/**
 * Puts `repos` on page 1 of the slice for `pattern` and `band`, one hit each,
 * with `total` as the slice's `total_count`, and adds each repo to the fake.
 */
function addStratum(
  github: FakeGitHub,
  pattern: string,
  repos: RepoFiles,
  options: { band?: number; total?: number } = {},
): Slice {
  const slice = sliceOf(pattern, options.band ?? 0);
  const names = Object.keys(repos);
  github.setPage(slice.query, 1, {
    total_count: options.total ?? names.length,
    incomplete_results: false,
    items: names.map((name) => hit(name, Object.keys(repos[name] ?? {})[0] ?? pattern)),
  });
  for (const [name, files] of Object.entries(repos)) addRepo(github, name, files);
  return slice;
}

/** The target pattern of a slice id (`<pattern>@<band>`). */
function targetOf(sliceId: unknown): string {
  return String(sliceId).split('@')[0] ?? '';
}

/** Files recorded per target pattern. */
function filesPerTarget(at = root): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records('files', at)) {
    const target = matchTarget(String(record['path']))?.target ?? 'none';
    counts[target] = (counts[target] ?? 0) + 1;
  }
  return counts;
}

/** Every repo, file and redaction record, minus retrieval timestamps, for comparing two corpora. */
function corpusState(at: string) {
  return {
    repos: records('repos', at),
    files: records('files', at).map((record) => ({ ...record, retrieved_at: null })),
    redactions: records('redactions', at),
  };
}

const SEED_A = 'a'.repeat(64);
const SEED_B = 'b'.repeat(64);
const RULES = { '.cursor/rules/a.mdc': 'a', '.cursor/rules/b.mdc': 'b' };

describe('collect: stratified expansion order', () => {
  it('balances files across targets while every target has repos left', async () => {
    const github = new FakeGitHub();
    const pools = {
      '.mcp.json': 12,
      '.cursor/rules/**': 12,
      'CLAUDE.md': 4,
    };
    addStratum(github, '.mcp.json', reposOf('mcp', pools['.mcp.json'], { '.mcp.json': '{}' }));
    addStratum(github, '.cursor/rules/**', reposOf('rules', pools['.cursor/rules/**'], RULES));
    addStratum(github, 'CLAUDE.md', reposOf('claude', pools['CLAUDE.md'], { 'CLAUDE.md': '#' }));
    seedStore(SEED_A);

    const result = await run(github);

    expect(result).toMatchObject({ status: 'complete', stop_reason: 'exhausted' });
    const order = records('repos').map((record) => targetOf(record['drawn_slice']));
    expect(order).toHaveLength(28);
    // All three start at zero, so the first draw goes to the first in TARGETS order.
    expect(order[0]).toBe('.mcp.json');
    const files: Record<string, number> = { '.mcp.json': 0, '.cursor/rules/**': 0, 'CLAUDE.md': 0 };
    const drawn: Record<string, number> = { '.mcp.json': 0, '.cursor/rules/**': 0, 'CLAUDE.md': 0 };
    const perRepo: Record<string, number> = {
      '.mcp.json': 1,
      '.cursor/rules/**': 2,
      'CLAUDE.md': 1,
    };
    for (const target of order) {
      const allLeft = Object.entries(pools).every(
        ([pattern, size]) => (drawn[pattern] ?? 0) < size,
      );
      drawn[target] = (drawn[target] ?? 0) + 1;
      files[target] = (files[target] ?? 0) + (perRepo[target] ?? 0);
      // The largest repo holds 2 files: counts never drift further apart than that.
      if (allLeft)
        expect(
          Math.max(...Object.values(files)) - Math.min(...Object.values(files)),
        ).toBeLessThanOrEqual(2);
    }
    expect(filesPerTarget()).toEqual({ '.mcp.json': 12, '.cursor/rules/**': 24, 'CLAUDE.md': 4 });
  });

  it('passes the unused share of a target whose pool runs out to the others', async () => {
    const github = new FakeGitHub();
    addStratum(github, '.junie/mcp/mcp.json', reposOf('junie', 2, { '.junie/mcp/mcp.json': '{}' }));
    addStratum(github, 'CLAUDE.md', reposOf('claude', 10, { 'CLAUDE.md': '#' }));
    addStratum(github, 'AGENTS.md', reposOf('agents', 10, { 'AGENTS.md': '#' }));
    seedStore(SEED_A);

    const result = await run(github, { fileCap: 12 });

    expect(result).toMatchObject({ status: 'partial', stop_reason: 'file-cap', files_written: 12 });
    expect(filesPerTarget()).toEqual({ '.junie/mcp/mcp.json': 2, 'CLAUDE.md': 5, 'AGENTS.md': 5 });
  });

  it('counts a file reached through the tree toward its own target, not the drawing one', async () => {
    const github = new FakeGitHub();
    addStratum(github, '.mcp.json', reposOf('mcp', 3, { '.mcp.json': '{}', 'AGENTS.md': '#' }));
    addStratum(github, 'AGENTS.md', reposOf('agents', 3, { 'AGENTS.md': '#' }));
    seedStore(SEED_A);

    await run(github);

    // Each .mcp.json repo also adds an AGENTS.md file, so AGENTS.md never falls
    // behind while .mcp.json has repos, and the ties go to .mcp.json.
    expect(records('repos').map((record) => targetOf(record['drawn_slice']))).toEqual([
      '.mcp.json',
      '.mcp.json',
      '.mcp.json',
      'AGENTS.md',
      'AGENTS.md',
      'AGENTS.md',
    ]);
  });

  it('allocates draws within a target in proportion to total_count', async () => {
    const github = new FakeGitHub();
    const big = addStratum(github, 'CLAUDE.md', reposOf('small-files', 40, { 'CLAUDE.md': '#' }), {
      band: 0,
      total: 900,
    });
    const small = addStratum(
      github,
      'CLAUDE.md',
      reposOf('large-files', 40, { 'CLAUDE.md': '#' }),
      {
        band: 2,
        total: 100,
      },
    );
    seedStore(SEED_A);

    const result = await run(github, { maxRepos: 20 });

    expect(result).toMatchObject({ stop_reason: 'max-repos', repos_expanded: 20 });
    const drawn = records('repos').map((record) => record['drawn_slice']);
    expect(drawn.filter((id) => id === big.id)).toHaveLength(18);
    expect(drawn.filter((id) => id === small.id)).toHaveLength(2);
    // Each record names the stratum it was drawn for among the slices that found it.
    for (const record of records('repos')) {
      expect(record['slice_ids']).toContain(record['drawn_slice']);
    }
  });

  it('draws a repo found by several slices once, for the first stratum to reach it', async () => {
    const github = new FakeGitHub();
    const shared = { 'shared/both': { 'CLAUDE.md': '#', 'AGENTS.md': '#' } };
    addStratum(github, 'CLAUDE.md', { ...shared, ...reposOf('claude', 2, { 'CLAUDE.md': '#' }) });
    addStratum(github, 'AGENTS.md', { ...shared, ...reposOf('agents', 2, { 'AGENTS.md': '#' }) });
    seedStore(SEED_A);

    const result = await run(github);

    expect(result).toMatchObject({ status: 'complete', repos_expanded: 5 });
    const names = records('repos').map((record) => record['full_name']);
    expect(names.filter((name) => name === 'shared/both')).toHaveLength(1);
    expect(github.calls.filter((call) => call === 'repo shared/both')).toHaveLength(1);
  });

  it('draws the same order for the same seed and a different one for another', async () => {
    const build = () => {
      const github = new FakeGitHub();
      addStratum(github, 'CLAUDE.md', reposOf('claude', 15, { 'CLAUDE.md': '#' }));
      addStratum(github, 'AGENTS.md', reposOf('agents', 15, { 'AGENTS.md': '#' }));
      return github;
    };
    const order = async (seed: string, name: string) => {
      const at = join(base, name);
      seedStore(seed, at);
      await run(build(), {}, at);
      return records('repos', at).map((record) => record['full_name']);
    };

    const first = await order(SEED_A, 'a1');
    expect(await order(SEED_A, 'a2')).toEqual(first);
    const other = await order(SEED_B, 'b');
    expect(other).not.toEqual(first);
    expect([...other].sort()).toEqual([...first].sort());
  });

  it('stops at exactly the file cap, mid-repo if need be', async () => {
    const github = new FakeGitHub();
    addStratum(github, '.cursor/rules/**', reposOf('rules', 5, RULES));
    addStratum(github, '.mcp.json', reposOf('mcp', 5, { '.mcp.json': '{}', 'CLAUDE.md': '#' }));
    seedStore(SEED_A);

    const result = await run(github, { fileCap: 7 });

    expect(result).toMatchObject({ status: 'partial', stop_reason: 'file-cap', files_written: 7 });
    expect(records('files')).toHaveLength(7);
  });
});

describe('collect: sampling seed and resume', () => {
  /** Three targets, repos of one to three files, some found by two slices. */
  function sampleWorld(): FakeGitHub {
    const github = new FakeGitHub();
    addStratum(github, '.mcp.json', reposOf('mcp', 6, { '.mcp.json': '{}', 'CLAUDE.md': '#' }));
    addStratum(github, '.mcp.json', reposOf('mcp-big', 3, { '.mcp.json': '{"a":1}' }), {
      band: 1,
      total: 30,
    });
    addStratum(github, '.cursor/rules/**', reposOf('rules', 6, RULES));
    addStratum(github, 'CLAUDE.md', reposOf('claude', 8, { 'CLAUDE.md': '#', 'AGENTS.md': '#' }));
    return github;
  }

  it('records a fresh seed before expanding anything, and reuses it after', async () => {
    const github = sampleWorld();
    let sampledBeforeExpansion: boolean | undefined;
    const getRepo = github.getRepo.bind(github);
    github.getRepo = (owner, repo) => {
      sampledBeforeExpansion ??= records('sampling').length === 1;
      return getRepo(owner, repo);
    };

    await run(github, { maxRepos: 2, fileCap: 20 });

    expect(sampledBeforeExpansion).toBe(true);
    const [sampling, ...rest] = records('sampling');
    expect(rest).toEqual([]);
    expect(sampling).toEqual({
      seed: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      file_cap: 20,
      method: 'stratified-v1',
      created_at: expect.any(String) as unknown,
      excluded_runs: [],
      excluded_repos: 0,
    });

    // Resumed twice more, the seed is read back rather than drawn again, and
    // the result matches an uninterrupted run with that seed.
    await run(github, { maxRepos: 3, fileCap: 20 });
    await run(github, { fileCap: 20 });
    expect(records('sampling')).toEqual([sampling]);

    const fresh = join(base, 'fresh');
    seedStore(String(sampling?.['seed']), fresh);
    await run(github, { fileCap: 20 }, fresh);
    expect(corpusState(root)).toEqual(corpusState(fresh));
  });

  it('ends a resumed run with the same repos and files as an uninterrupted one', async () => {
    // One fake for both corpora, so commit and blob SHAs match.
    const github = sampleWorld();
    const whole = join(base, 'whole');
    seedStore(SEED_A, whole);
    const uninterrupted = await run(github, { fileCap: 25 }, whole);
    expect(uninterrupted).toMatchObject({ stop_reason: 'file-cap', files_written: 25 });

    seedStore(SEED_A);
    expect(await run(github, { maxRepos: 3, fileCap: 25 })).toMatchObject({
      stop_reason: 'max-repos',
    });
    // Abort partway through a repo: the next run resumes it at its position.
    const controller = new AbortController();
    let blobs = 0;
    github.onBlob = () => {
      blobs++;
      if (blobs === 4) controller.abort();
    };
    expect(await run(github, { signal: controller.signal, fileCap: 25 })).toMatchObject({
      stop_reason: 'aborted',
    });
    github.onBlob = () => {};
    expect(await run(github, { fileCap: 15 })).toMatchObject({ stop_reason: 'file-cap' });
    expect(records('files')).toHaveLength(15);
    expect(await run(github, { fileCap: 25 })).toMatchObject({ stop_reason: 'file-cap' });

    expect(corpusState(root)).toEqual(corpusState(whole));
    expect(records('sampling')).toEqual(records('sampling', whole));
  });
});

describe('collect: excluding an earlier run', () => {
  it('never expands an excluded repository and records the exclusion with the seed', async () => {
    const github = world();
    const result = await run(github, {
      exclude: { runs: ['run1'], repos: new Set(['octo/demo']) },
    });

    expect(result).toMatchObject({ status: 'complete', repos_expanded: 1 });
    expect(github.calls).not.toContain('repo octo/demo');
    expect(records('repos').map((record) => record['full_name'])).toEqual(['acme/tools']);
    // The search page is still recorded whole (C-3).
    expect(records('responses')[0]?.['items']).toHaveLength(2);
    expect(records('sampling')[0]).toMatchObject({ excluded_runs: ['run1'], excluded_repos: 1 });
  });

  it('refuses to resume a corpus with a different exclusion', async () => {
    const github = world();
    await run(github, { maxRepos: 1, exclude: { runs: ['run1'], repos: new Set(['x/y']) } });

    await expect(run(github)).rejects.toThrow(ExclusionMismatchError);
    await expect(
      run(github, { exclude: { runs: ['run1'], repos: new Set(['x/y', 'z/w']) } }),
    ).rejects.toThrow(ExclusionMismatchError);
    expect(
      await run(github, { exclude: { runs: ['run1'], repos: new Set(['x/y']) } }),
    ).toMatchObject({ status: 'complete' });
  });
});

describe('collect: forks and private repos (C-6, P-14)', () => {
  it('never expands a fork or private repo from search, and records nothing about it', async () => {
    const github = new FakeGitHub();
    github.setPage(MCP_SLICE.query, 1, {
      total_count: 2,
      incomplete_results: false,
      items: [
        hit('someone/copy', '.mcp.json', { fork: true }),
        hit('secret/inside', '.mcp.json', { private: true }),
      ],
    });
    await run(github);
    expect(github.calls.filter((call) => !call.startsWith('search '))).toEqual([]);
    expect(corpusText()).not.toContain('someone/copy');
    expect(corpusText()).not.toContain('secret/inside');
  });

  it('skips a repo getRepo reports as private or a fork, writing nothing for it', async () => {
    const github = new FakeGitHub();
    github.setPage(MCP_SLICE.query, 1, {
      total_count: 2,
      incomplete_results: false,
      items: [hit('turned/private', '.mcp.json'), hit('turned/fork', '.mcp.json')],
    });
    addRepo(github, 'turned/private', { '.mcp.json': '{}' }, { meta: { private: true } });
    addRepo(github, 'turned/fork', { '.mcp.json': '{}' }, { meta: { fork: true } });

    const result = await run(github);

    expect(result).toMatchObject({ status: 'complete', repos_skipped: 2, files_written: 0 });
    expect(github.calls.filter((call) => !call.startsWith('search ')).sort()).toEqual([
      'repo turned/fork',
      'repo turned/private',
    ]);
    expect(records('repos')).toEqual([]);
    expect(records('files')).toEqual([]);
    expect(existsSync(join(root, 'files'))).toBe(false);
    for (const line of logLines) expect(line).not.toContain('turned/private');
  });
});

describe('collect: tree filtering', () => {
  it('never fetches a path matchTarget rejects, a non-target, a symlink or a submodule', async () => {
    const github = new FakeGitHub();
    github.setPage(MCP_SLICE.query, 1, {
      total_count: 1,
      incomplete_results: false,
      items: [hit('octo/demo', '.mcp.json')],
    });
    const rejected: TreeEntry[] = [
      { path: '.cursor/rules/../../CLAUDE.md', mode: '100644', type: 'blob', sha: sha() },
      { path: '../CLAUDE.md', mode: '100644', type: 'blob', sha: sha() },
      { path: '/CLAUDE.md', mode: '100644', type: 'blob', sha: sha() },
      { path: 'AGENTS.md', mode: '120000', type: 'blob', sha: sha() },
      { path: '.cursor/rules/vendored', mode: '160000', type: 'commit', sha: sha() },
    ];
    addRepo(github, 'octo/demo', { '.mcp.json': '{}' }, { extra: rejected });

    await run(github);

    const blobCalls = github.calls.filter((call) => call.startsWith('blob '));
    expect(blobCalls).toHaveLength(1);
    for (const entry of rejected) expect(blobCalls.join('\n')).not.toContain(entry.sha);
    expect(records('files').map((record) => record['path'])).toEqual(['.mcp.json']);
  });

  it('skips a file that is not UTF-8 without recording it', async () => {
    const github = new FakeGitHub();
    github.setPage(MCP_SLICE.query, 1, {
      total_count: 1,
      incomplete_results: false,
      items: [hit('octo/demo', '.mcp.json')],
    });
    addRepo(github, 'octo/demo', {
      '.mcp.json': '{}',
      '.cursor/rules/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]),
    });

    const result = await run(github);

    expect(result).toMatchObject({ status: 'complete', files_written: 1 });
    expect(records('files').map((record) => record['path'])).toEqual(['.mcp.json']);
    expect(corpusFiles()).not.toContain('files/octo/demo/.cursor/rules/logo.png');
  });
});

describe('cli', () => {
  function cliDeps(github: FakeGitHub, output: string[]) {
    return {
      github,
      logger: logger(),
      salt: SALT,
      corpusDir: root,
      stdout: (line: string) => void output.push(line),
    };
  }

  it('--dry-run fetches page 1 of each slice, prints it, and writes nothing', async () => {
    const github = world();
    const output: string[] = [];

    expect(await runCli(['--dry-run'], cliDeps(github, output))).toBeNull();

    expect(existsSync(root)).toBe(false);
    expect(github.calls).toEqual(SLICES.map((slice) => `search ${slice.query} #1`));
    expect(output[0]).toBe('total_count\tincomplete_results\tquery');
    expect(output).toHaveLength(SLICES.length + 1);
    expect(output).toContain(`2\tfalse\t${MCP_SLICE.query}`);
  });

  it('passes --max-repos through to the run', async () => {
    const github = world();
    const result = await runCli(['--', '--max-repos', '1'], cliDeps(github, []));
    expect(result).toMatchObject({ status: 'partial', stop_reason: 'max-repos' });
  });

  it('--run writes the corpus under its own directory', async () => {
    const github = world();
    await runCli(['--run', 'run2'], cliDeps(github, []));

    expect(records('runs', join(root, 'run2'))).toHaveLength(1);
    expect(existsSync(join(root, 'runs.jsonl'))).toBe(false);
  });

  it('--exclude-from leaves out every repository the named run collected', async () => {
    const github = world();
    await runCli(['--run', 'run1', '--max-repos', '1'], cliDeps(github, []));
    const first = records('repos', join(root, 'run1')).map((record) => record['full_name']);
    expect(first).toHaveLength(1);

    github.calls.length = 0;
    await runCli(['--run', 'run2', '--exclude-from', 'run1'], cliDeps(github, []));

    const second = records('repos', join(root, 'run2')).map((record) => record['full_name']);
    expect(second).toHaveLength(1);
    expect(second).not.toContain(first[0]);
    expect(records('sampling', join(root, 'run2'))[0]).toMatchObject({
      excluded_runs: ['run1'],
      excluded_repos: 1,
    });
  });

  it('rejects --exclude-from naming a run that was never collected', async () => {
    const github = world();
    await expect(
      runCli(['--run', 'run2', '--exclude-from', 'run1'], cliDeps(github, [])),
    ).rejects.toThrow(UsageError);
    expect(github.calls).toEqual([]);
  });

  it.each([
    ['--run', '../escape'],
    ['--run', 'Run1'],
    ['--run', ''],
    ['--exclude-from', '..'],
    ['--run', 'run1', '--exclude-from', 'run1'],
    ['--max-repos', '0'],
    ['--max-repos', '-1'],
    ['--max-repos', 'ten'],
    ['--live'],
    ['extra'],
  ])('rejects a bad command line %j before any call', async (...argv) => {
    const github = world();
    await expect(runCli(argv, cliDeps(github, []))).rejects.toThrow(UsageError);
    expect(github.calls).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });
});
