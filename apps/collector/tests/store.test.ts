import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CorpusPathError,
  CorpusReadError,
  CorpusRecordError,
  CorpusStore,
  type FileRecord,
  type RedactionRecord,
  type RepoRecord,
  type ResponseRecord,
  type RunRecord,
} from '../src/store.js';

const HASH = 'a'.repeat(64);

const RUN: RunRecord = {
  run_id: 'run-1',
  started_at: '2026-09-01T00:00:00.000Z',
  ended_at: '2026-09-01T01:00:00.000Z',
  status: 'partial',
  stop_reason: 'sigint',
};

function response(sliceId: string, page: number): ResponseRecord {
  return {
    slice_id: sliceId,
    query: 'mcpServers filename:.mcp.json size:<1000',
    page,
    total_count: 412,
    incomplete_results: false,
    retrieved_at: '2026-09-01T00:01:00.000Z',
  };
}

function repo(fullName: string): RepoRecord {
  return {
    full_name: fullName,
    owner: fullName.split('/')[0] ?? '',
    stars: 3,
    pushed_at: '2026-08-01T00:00:00Z',
    default_branch: 'main',
    head_commit: 'b'.repeat(40),
    tree_truncated: false,
    slice_ids: ['mcp-json-s0'],
  };
}

const FILE: FileRecord = {
  repo: 'octo/demo',
  owner: 'octo',
  commit_sha: 'b'.repeat(40),
  path: '.cursor/mcp.json',
  blob_sha: 'c'.repeat(40),
  class: 'config',
  kind: 'mcp',
  client: 'cursor',
  size: 120,
  retrieved_at: '2026-09-01T00:02:00.000Z',
  surfaced_by: { slice_ids: ['mcp-json-s0'], via: 'tree' },
  last_commit_at: null,
  content_hash: HASH,
};

const REDACTION: RedactionRecord = {
  repo: 'octo/demo',
  commit_sha: 'b'.repeat(40),
  path: '.cursor/mcp.json',
  detector: 'keyed-literal',
  value_type: 'api-key',
  offset: 57,
  hash: HASH,
};

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'collector-store-'));
  root = join(base, 'corpus');
  outside = join(base, 'outside');
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function lines(stream: string): unknown[] {
  const text = readFileSync(join(root, `${stream}.jsonl`), 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

/** Every file and directory under `dir`, relative to it. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
}

describe('CorpusStore: writing records', () => {
  it('creates the root and round-trips each record type, one object per line', () => {
    const store = new CorpusStore(root);
    store.appendRun(RUN);
    store.appendResponse(response('s1', 1));
    store.appendResponse(response('s1', 2));
    store.appendRepo(repo('octo/demo'));
    store.appendFile(FILE);
    store.appendRedaction(REDACTION);

    expect(lines('runs')).toEqual([RUN]);
    expect(lines('responses')).toEqual([response('s1', 1), response('s1', 2)]);
    expect(lines('repos')).toEqual([repo('octo/demo')]);
    expect(lines('files')).toEqual([FILE]);
    expect(lines('redactions')).toEqual([REDACTION]);
  });

  it('keeps a string with newlines on a single line', () => {
    const store = new CorpusStore(root);
    store.appendRun({ ...RUN, stop_reason: 'line one\nline two' });
    expect(lines('runs')).toEqual([{ ...RUN, stop_reason: 'line one\nline two' }]);
  });

  it('appends to records left by an earlier store on the same root', () => {
    new CorpusStore(root).appendResponse(response('s1', 1));
    new CorpusStore(root).appendResponse(response('s1', 2));
    expect(lines('responses')).toEqual([response('s1', 1), response('s1', 2)]);
  });

  it('writes a redaction record with exactly the C-2 fields and file ref', () => {
    const store = new CorpusStore(root);
    // A wider object, as a careless caller might pass, still carrying the value.
    const wider = { ...REDACTION, value: 'must-never-reach-disk' };
    store.appendRedaction(wider);
    const [written] = lines('redactions');
    expect(Object.keys(written as object).sort()).toEqual([
      'commit_sha',
      'detector',
      'hash',
      'offset',
      'path',
      'repo',
      'value_type',
    ]);
    expect(readFileSync(join(root, 'redactions.jsonl'), 'utf8')).not.toContain(
      'must-never-reach-disk',
    );
  });

  it('drops fields a record type does not define', () => {
    const store = new CorpusStore(root);
    store.appendFile({ ...FILE, content: 'raw file body' } as FileRecord);
    expect(lines('files')).toEqual([FILE]);
  });

  it('refuses a redaction whose hash is not a hex digest', () => {
    const store = new CorpusStore(root);
    expect(() => store.appendRedaction({ ...REDACTION, hash: 'not-a-digest' })).toThrow(
      CorpusRecordError,
    );
    expect(() => store.appendRedaction({ ...REDACTION, offset: -1 })).toThrow(CorpusRecordError);
    expect(() => store.appendFile({ ...FILE, content_hash: 'x' })).toThrow(CorpusRecordError);
    expect(tree(root)).toEqual([]);
  });

  it('writes a redacted file under files/<owner>/<repo>/<path>', () => {
    const store = new CorpusStore(root);
    store.writeFile('octo', 'demo', '.claude/skills/review/SKILL.md', 'redacted body');
    expect(readFileSync(join(root, 'files/octo/demo/.claude/skills/review/SKILL.md'), 'utf8')).toBe(
      'redacted body',
    );
    // A rerun after an interrupted write replaces the copy.
    store.writeFile('octo', 'demo', '.claude/skills/review/SKILL.md', 'second');
    expect(readFileSync(join(root, 'files/octo/demo/.claude/skills/review/SKILL.md'), 'utf8')).toBe(
      'second',
    );
  });
});

describe('CorpusStore: resume readers', () => {
  it('returns empty sets before anything is written', () => {
    const store = new CorpusStore(root);
    expect(store.completedPages()).toEqual(new Set());
    expect(store.completedRepos()).toEqual(new Set());
  });

  it('reads completed pages and repos', () => {
    const store = new CorpusStore(root);
    store.appendResponse(response('s1', 1));
    store.appendResponse(response('s2', 3));
    store.appendRepo(repo('octo/demo'));
    store.appendRepo(repo('acme/tools'));
    expect(store.completedPages()).toEqual(new Set(['s1:1', 's2:3']));
    expect(store.completedRepos()).toEqual(new Set(['octo/demo', 'acme/tools']));
  });

  it('skips a truncated final line and reads every complete line before it', () => {
    const store = new CorpusStore(root);
    store.appendResponse(response('s1', 1));
    store.appendResponse(response('s1', 2));
    store.appendRepo(repo('octo/demo'));
    appendFileSync(join(root, 'responses.jsonl'), '{"slice_id":"s1","page":3,"que');
    appendFileSync(join(root, 'repos.jsonl'), '{"full_name":"acme/to');
    expect(store.completedPages()).toEqual(new Set(['s1:1', 's1:2']));
    expect(store.completedRepos()).toEqual(new Set(['octo/demo']));
  });

  it('does not trust an unterminated final line even when it parses', () => {
    const store = new CorpusStore(root);
    store.appendRepo(repo('octo/demo'));
    appendFileSync(join(root, 'repos.jsonl'), '{"full_name":"acme/tools"}');
    expect(store.completedRepos()).toEqual(new Set(['octo/demo']));
  });

  it('drops the truncated tail before the next append, so records stay one per line', () => {
    new CorpusStore(root).appendResponse(response('s1', 1));
    appendFileSync(join(root, 'responses.jsonl'), '{"slice_id":"s1","pa');
    const resumed = new CorpusStore(root);
    resumed.appendResponse(response('s1', 2));
    expect(lines('responses')).toEqual([response('s1', 1), response('s1', 2)]);
    expect(resumed.completedPages()).toEqual(new Set(['s1:1', 's1:2']));
  });

  it('drops a tail that is the only content of the file', () => {
    mkdirSync(root);
    writeFileSync(join(root, 'repos.jsonl'), '{"full_na');
    const store = new CorpusStore(root);
    expect(store.completedRepos()).toEqual(new Set());
    store.appendRepo(repo('octo/demo'));
    expect(lines('repos')).toEqual([repo('octo/demo')]);
  });

  it('throws on a malformed line that is not the final one, without its content', () => {
    mkdirSync(root);
    writeFileSync(
      join(root, 'responses.jsonl'),
      `${JSON.stringify(response('s1', 1))}\n{"secret-looking-fragment\n`,
    );
    const store = new CorpusStore(root);
    expect(() => store.completedPages()).toThrow(CorpusReadError);
    expect(() => store.completedPages()).toThrow('responses.jsonl is corrupt at line 2');
    try {
      store.completedPages();
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-looking-fragment');
    }
  });

  it('throws on a complete line missing the fields it keys on', () => {
    mkdirSync(root);
    writeFileSync(join(root, 'repos.jsonl'), '{"owner":"octo"}\n');
    expect(() => new CorpusStore(root).completedRepos()).toThrow(CorpusReadError);
  });
});

describe('CorpusStore: path guard', () => {
  it.each([
    ['a parent-relative path', 'octo', 'demo', '../x'],
    ['a deep escape', 'octo', 'demo', '../../../../x'],
    ['an absolute path', 'octo', 'demo', '/etc/x'],
    ['a path with .. in the middle', 'octo', 'demo', 'a/../../../x'],
    ['an owner of ..', '..', 'demo', 'x'],
    ['a repo of ..', 'octo', '..', 'x'],
    ['an owner containing ..', '../..', 'demo', 'x'],
    ['an absolute owner', '/tmp', 'demo', 'x'],
    ['an owner containing a slash', 'octo/demo', 'x', 'y'],
    ['an empty path', 'octo', 'demo', ''],
    ['an empty segment', 'octo', 'demo', 'a//b'],
    ['a . segment', 'octo', 'demo', './x'],
    ['a NUL byte', 'octo', 'demo', 'x\0y'],
    ['a backslash', 'octo', 'demo', '..\\..\\x'],
  ])('rejects %s and writes nothing', (_label, owner, repoName, path) => {
    const store = new CorpusStore(root);
    expect(() => store.writeFile(owner, repoName, path, 'redacted body')).toThrow(CorpusPathError);
    expect(tree(root)).toEqual([]);
    expect(tree(outside)).toEqual([]);
  });

  it('rejects a symlinked directory inside the root that points outside it', () => {
    const store = new CorpusStore(root);
    mkdirSync(join(root, 'files'));
    symlinkSync(outside, join(root, 'files', 'octo'));
    expect(() => store.writeFile('octo', 'demo', 'x', 'redacted body')).toThrow(CorpusPathError);
    expect(tree(outside)).toEqual([]);
  });

  it('rejects a symlinked file inside the root that points outside it', () => {
    const store = new CorpusStore(root);
    const victim = join(outside, 'victim');
    writeFileSync(victim, 'untouched');
    mkdirSync(join(root, 'files', 'octo', 'demo'), { recursive: true });
    symlinkSync(victim, join(root, 'files', 'octo', 'demo', 'x'));
    expect(() => store.writeFile('octo', 'demo', 'x', 'redacted body')).toThrow(CorpusPathError);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
  });

  it('rejects a dangling symlink whose target would land outside', () => {
    const store = new CorpusStore(root);
    mkdirSync(join(root, 'files', 'octo', 'demo'), { recursive: true });
    symlinkSync(join(outside, 'created'), join(root, 'files', 'octo', 'demo', 'x'));
    expect(() => store.writeFile('octo', 'demo', 'x', 'redacted body')).toThrow(CorpusPathError);
    expect(existsSync(join(outside, 'created'))).toBe(false);
  });

  it('guards the JSONL files too', () => {
    const store = new CorpusStore(root);
    symlinkSync(join(outside, 'runs.jsonl'), join(root, 'runs.jsonl'));
    expect(() => store.appendRun(RUN)).toThrow(CorpusPathError);
    expect(tree(outside)).toEqual([]);
  });

  it('follows a symlink that stays inside the root', () => {
    const store = new CorpusStore(root);
    mkdirSync(join(root, 'files', 'real'), { recursive: true });
    symlinkSync(join(root, 'files', 'real'), join(root, 'files', 'octo'));
    store.writeFile('octo', 'demo', 'x', 'redacted body');
    expect(readFileSync(join(root, 'files', 'real', 'demo', 'x'), 'utf8')).toBe('redacted body');
  });

  it('works when the root itself is reached through a symlink', () => {
    mkdirSync(root);
    const alias = join(base, 'alias');
    symlinkSync(root, alias);
    const store = new CorpusStore(alias);
    store.writeFile('octo', 'demo', 'x', 'redacted body');
    expect(readFileSync(join(root, 'files', 'octo', 'demo', 'x'), 'utf8')).toBe('redacted body');
  });

  it('refuses with a fixed message that does not echo the path', () => {
    const store = new CorpusStore(root);
    expect(() => store.writeFile('octo', 'demo', '../escape-marker', 'x')).toThrow(
      'Corpus write refused: target is not inside the corpus directory',
    );
  });
});
