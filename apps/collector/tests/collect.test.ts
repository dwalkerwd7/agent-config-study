import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@driftwood/core';
import { RequestError } from 'octokit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collect, type CollectOptions } from '../src/collect.js';
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
import { buildSlices, type Slice } from '../src/queries.js';
import { CorpusStore } from '../src/store.js';
import { FAKE } from './credential-fixtures.js';

// No test here reaches the network or runs the CLI entry point: every GitHub
// call goes to the in-memory fake below, and every store is a temp dir.

const SALT = 'collect-test-salt-0123456789abcdef0123456789';
const SLICES = buildSlices();
function firstSlice(pattern: string): Slice {
  const slice = SLICES.find((candidate) => candidate.target.pattern === pattern);
  if (slice === undefined) throw new Error(`no slice for ${pattern}`);
  return slice;
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

function run(github: FakeGitHub, options: CollectOptions = {}) {
  return collect({ github, store: new CorpusStore(root), salt: SALT, logger: logger() }, options);
}

function records(stream: string): Record<string, unknown>[] {
  const path = join(root, `${stream}.jsonl`);
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
    expect(github.calls.filter((call) => !call.startsWith('search '))).toEqual([
      'repo turned/private',
      'repo turned/fork',
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

  it.each([
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
