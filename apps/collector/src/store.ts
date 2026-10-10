import {
  appendFileSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { TargetClient, TargetKind, TargetMatch } from './targets.js';

/**
 * The corpus store: append-only JSONL files plus redacted file copies, all
 * confined to one directory (C-9) and resumable after a killed run (C-8).
 *
 * Field names are snake_case because they are the on-disk format the analysis
 * reads, and they follow the names in `.claude/plans/corpus-collector.md`.
 */

/** One collection run. `partial` covers every stop short of exhaustion (C-8). */
export interface RunRecord {
  run_id: string;
  started_at: string;
  ended_at: string;
  status: 'complete' | 'partial';
  stop_reason: string;
}

/** One page of one search slice. `incomplete_results` is kept per response (C-4). */
export interface ResponseRecord {
  slice_id: string;
  query: string;
  page: number;
  total_count: number;
  incomplete_results: boolean;
  retrieved_at: string;
  /** Items on the page, forks included. A page shorter than a full one is its slice's last. */
  item_count: number;
  /**
   * The hits that were queued for expansion: public, non-fork repositories
   * only (C-6, P-14), with the path each one matched. A resumed run rebuilds
   * its queue from these, since it skips the pages that produced them.
   */
  items: SearchHit[];
}

/** One queued code-search hit. Both fields are API metadata, never file content. */
export interface SearchHit {
  repo: string;
  path: string;
}

/** A fully expanded repository. Written last, so its presence means done. */
export interface RepoRecord {
  full_name: string;
  owner: string;
  stars: number;
  /** `null` when GitHub reports none, as `RepoMetadata` passes it through. */
  pushed_at: string | null;
  default_branch: string;
  head_commit: string;
  tree_truncated: boolean;
  slice_ids: string[];
  /** The slice (stratum) the repository was drawn for in expansion, one of `slice_ids`. */
  drawn_slice: string;
}

/** Provenance for one collected file (C-3), classified at collection (C-5). */
export interface FileRecord {
  repo: string;
  owner: string;
  commit_sha: string;
  path: string;
  blob_sha: string;
  class: TargetMatch['class'];
  kind: TargetKind;
  client: TargetClient;
  size: number;
  retrieved_at: string;
  surfaced_by: { slice_ids: string[]; via: 'search' | 'tree' };
  last_commit_at: string | null;
  /** Hex SHA-256 of the normalized redacted text. Dedup is analysis's job (C-7). */
  content_hash: string;
}

/**
 * One redacted value: a reference to the file plus the C-2 fields, and
 * nothing else. There is deliberately no field that could hold the value.
 */
export interface RedactionRecord {
  repo: string;
  commit_sha: string;
  path: string;
  detector: string;
  value_type: string;
  /** Byte offset of the value in the original file. */
  offset: number;
  /** Hex HMAC-SHA256 of the value under the unpublished salt. */
  hash: string;
}

/**
 * The expansion draw's parameters (`study/plan.md` §5). Written once, by the
 * first run that reaches expansion, before anything is expanded; every later
 * run reuses the first record's seed so a resumed run draws the same sequence.
 * The seed is random and not secret. It is not the redaction salt.
 */
export interface SamplingRecord {
  /** 32 random bytes, hex. */
  seed: string;
  file_cap: number;
  method: 'stratified-v1';
  created_at: string;
  /**
   * Earlier runs whose repositories this corpus leaves out of the draw, and
   * how many repositories that was. Empty and 0 for a corpus that excludes
   * nothing, which is also what a record written before the field existed
   * reads as.
   */
  excluded_runs: string[];
  excluded_repos: number;
}

/** The fields of a file record that identify it: what resume and the draw replay need. */
export interface FileRef {
  repo: string;
  commit_sha: string;
  path: string;
}

export const STREAMS = ['runs', 'responses', 'repos', 'files', 'redactions', 'sampling'] as const;
export type Stream = (typeof STREAMS)[number];

/**
 * A write was refused because its target would land outside the corpus
 * directory. The message is fixed: it never carries the path or anything
 * read from a collected file.
 */
export class CorpusPathError extends Error {
  constructor() {
    super('Corpus write refused: target is not inside the corpus directory');
    this.name = 'CorpusPathError';
  }
}

/** A record failed validation before it was written. Fixed message per field. */
export class CorpusRecordError extends Error {
  constructor(field: string) {
    super(`Corpus record refused: invalid ${field}`);
    this.name = 'CorpusRecordError';
  }
}

/**
 * A JSONL file has a malformed line that is not the final one, so it is not
 * the tail of a killed write. Names the file and line number, never the line.
 */
export class CorpusReadError extends Error {
  constructor(stream: Stream, line: number) {
    super(`Corpus file ${stream}.jsonl is corrupt at line ${line}`);
    this.name = 'CorpusReadError';
  }
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;
/** 32 bytes as lower-case hex: the same shape as a SHA-256 digest. */
const HEX_SEED = HEX_SHA256;
/** A run's name: its directory under the corpus root (`collect --run`). */
export const RUN_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class CorpusStore {
  readonly #root: string;
  /** Streams whose unterminated tail has been dropped by this instance. */
  readonly #repaired = new Set<Stream>();

  /**
   * `root` is the corpus directory. Production passes `corpusDir()` from
   * `env.ts`; tests pass a temp dir. It is created if missing and then
   * resolved through symlinks once, so every later check compares real paths.
   */
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.#root = realpathSync(root);
  }

  appendRun(record: RunRecord): void {
    this.#append('runs', {
      run_id: record.run_id,
      started_at: record.started_at,
      ended_at: record.ended_at,
      status: record.status,
      stop_reason: record.stop_reason,
    });
  }

  appendResponse(record: ResponseRecord): void {
    this.#append('responses', {
      slice_id: record.slice_id,
      query: record.query,
      page: record.page,
      total_count: record.total_count,
      incomplete_results: record.incomplete_results,
      retrieved_at: record.retrieved_at,
      item_count: record.item_count,
      items: record.items.map((item) => ({ repo: item.repo, path: item.path })),
    });
  }

  appendRepo(record: RepoRecord): void {
    this.#append('repos', {
      full_name: record.full_name,
      owner: record.owner,
      stars: record.stars,
      pushed_at: record.pushed_at,
      default_branch: record.default_branch,
      head_commit: record.head_commit,
      tree_truncated: record.tree_truncated,
      slice_ids: [...record.slice_ids],
      drawn_slice: record.drawn_slice,
    });
  }

  appendSampling(record: SamplingRecord): void {
    if (!HEX_SEED.test(record.seed)) throw new CorpusRecordError('seed');
    if (!Number.isSafeInteger(record.file_cap) || record.file_cap < 1) {
      throw new CorpusRecordError('file_cap');
    }
    if (!record.excluded_runs.every((run) => RUN_NAME.test(run))) {
      throw new CorpusRecordError('excluded_runs');
    }
    if (!Number.isSafeInteger(record.excluded_repos) || record.excluded_repos < 0) {
      throw new CorpusRecordError('excluded_repos');
    }
    this.#append('sampling', {
      seed: record.seed,
      file_cap: record.file_cap,
      method: record.method,
      created_at: record.created_at,
      excluded_runs: [...record.excluded_runs],
      excluded_repos: record.excluded_repos,
    });
  }

  appendFile(record: FileRecord): void {
    if (!HEX_SHA256.test(record.content_hash)) throw new CorpusRecordError('content_hash');
    this.#append('files', {
      repo: record.repo,
      owner: record.owner,
      commit_sha: record.commit_sha,
      path: record.path,
      blob_sha: record.blob_sha,
      class: record.class,
      kind: record.kind,
      client: record.client,
      size: record.size,
      retrieved_at: record.retrieved_at,
      surfaced_by: { slice_ids: [...record.surfaced_by.slice_ids], via: record.surfaced_by.via },
      last_commit_at: record.last_commit_at,
      content_hash: record.content_hash,
    });
  }

  /**
   * Copies exactly the C-2 fields, so a caller holding a wider object (one
   * that still carries the value, say) cannot get anything else onto disk.
   */
  appendRedaction(record: RedactionRecord): void {
    if (!HEX_SHA256.test(record.hash)) throw new CorpusRecordError('hash');
    if (!Number.isSafeInteger(record.offset) || record.offset < 0) {
      throw new CorpusRecordError('offset');
    }
    this.#append('redactions', {
      repo: record.repo,
      commit_sha: record.commit_sha,
      path: record.path,
      detector: record.detector,
      value_type: record.value_type,
      offset: record.offset,
      hash: record.hash,
    });
  }

  /**
   * Writes a redacted file copy to `files/<owner>/<repo>/<path>`, replacing
   * any earlier copy from an interrupted run. The text must already have been
   * through the redactor (C-1); the store never sees a raw file.
   */
  writeFile(owner: string, repo: string, path: string, redactedText: string): void {
    const target = this.#guard(['files', owner, repo, ...path.split('/')], [owner, repo]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, redactedText, { flag: 'w' });
  }

  /** `"sliceId:page"` for every search page already recorded. */
  completedPages(): Set<string> {
    const done = new Set<string>();
    for (const [value, line] of this.#read('responses')) {
      const slice = field(value, 'slice_id');
      const page = field(value, 'page');
      if (typeof slice !== 'string' || !Number.isSafeInteger(page)) {
        throw new CorpusReadError('responses', line);
      }
      done.add(`${slice}:${String(page)}`);
    }
    return done;
  }

  /** Every search page already recorded, in the order it was written. */
  responses(): ResponseRecord[] {
    return this.#read('responses').map(([value, line]) => {
      const sliceId = field(value, 'slice_id');
      const query = field(value, 'query');
      const page = field(value, 'page');
      const totalCount = field(value, 'total_count');
      const incomplete = field(value, 'incomplete_results');
      const retrievedAt = field(value, 'retrieved_at');
      const itemCount = field(value, 'item_count');
      const items = field(value, 'items');
      if (
        typeof sliceId !== 'string' ||
        typeof query !== 'string' ||
        !isInteger(page) ||
        !isInteger(totalCount) ||
        typeof incomplete !== 'boolean' ||
        typeof retrievedAt !== 'string' ||
        !isInteger(itemCount) ||
        !Array.isArray(items)
      ) {
        throw new CorpusReadError('responses', line);
      }
      return {
        slice_id: sliceId,
        query,
        page,
        total_count: totalCount,
        incomplete_results: incomplete,
        retrieved_at: retrievedAt,
        item_count: itemCount,
        items: items.map((item: unknown): SearchHit => {
          const repo = field(item, 'repo');
          const path = field(item, 'path');
          if (typeof repo !== 'string' || typeof path !== 'string') {
            throw new CorpusReadError('responses', line);
          }
          return { repo, path };
        }),
      };
    });
  }

  /**
   * `"repo@commit_sha:path"` for every file record already written, so a run
   * resumed inside a repository does not record a file twice.
   */
  completedFiles(): Set<string> {
    return new Set(this.fileRefs().map((ref) => fileKey(ref.repo, ref.commit_sha, ref.path)));
  }

  /** Every file record already written, reduced to the fields that identify it, in order. */
  fileRefs(): FileRef[] {
    return this.#read('files').map(([value, line]) => {
      const repo = field(value, 'repo');
      const commit = field(value, 'commit_sha');
      const path = field(value, 'path');
      if (typeof repo !== 'string' || typeof commit !== 'string' || typeof path !== 'string') {
        throw new CorpusReadError('files', line);
      }
      return { repo, commit_sha: commit, path };
    });
  }

  /** Every repository already expanded: full name to the head commit it was expanded at. */
  completedRepos(): Map<string, string> {
    const done = new Map<string, string>();
    for (const [value, line] of this.#read('repos')) {
      const name = field(value, 'full_name');
      const head = field(value, 'head_commit');
      if (typeof name !== 'string' || typeof head !== 'string') {
        throw new CorpusReadError('repos', line);
      }
      done.set(name, head);
    }
    return done;
  }

  /** Every sampling record, in the order written. Only the first one is used. */
  sampling(): SamplingRecord[] {
    return this.#read('sampling').map(([value, line]) => {
      const seed = field(value, 'seed');
      const fileCap = field(value, 'file_cap');
      const method = field(value, 'method');
      const createdAt = field(value, 'created_at');
      const excludedRuns = field(value, 'excluded_runs') ?? [];
      const excludedRepos = field(value, 'excluded_repos') ?? 0;
      if (
        typeof seed !== 'string' ||
        !HEX_SEED.test(seed) ||
        !isInteger(fileCap) ||
        // Another method's sequence cannot be reproduced by this code.
        method !== 'stratified-v1' ||
        typeof createdAt !== 'string' ||
        !Array.isArray(excludedRuns) ||
        !excludedRuns.every((run) => typeof run === 'string' && RUN_NAME.test(run)) ||
        !isInteger(excludedRepos)
      ) {
        throw new CorpusReadError('sampling', line);
      }
      return {
        seed,
        file_cap: fileCap,
        method,
        created_at: createdAt,
        excluded_runs: excludedRuns as string[],
        excluded_repos: excludedRepos,
      };
    });
  }

  /**
   * One JSON object per line, flushed to disk before returning (C-8).
   * `JSON.stringify` escapes newlines inside strings, so a record is always
   * exactly one line.
   */
  #append(stream: Stream, record: object): void {
    const target = this.#guard([`${stream}.jsonl`]);
    this.#repairTail(stream, target);
    const fd = openSync(target, 'a');
    try {
      appendFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * A killed process can leave a final line with no newline. Appending after
   * it would glue the next record onto the fragment, so the first append of
   * each stream drops the fragment. It was never a complete record, and the
   * readers already ignored it, so the work it described is redone on resume.
   */
  #repairTail(stream: Stream, target: string): void {
    if (this.#repaired.has(stream)) return;
    const bytes = readIfExists(target);
    if (bytes !== null && bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      truncateSync(target, bytes.lastIndexOf(0x0a) + 1);
    }
    this.#repaired.add(stream);
  }

  /**
   * Parsed lines with their 1-based line numbers. An unparseable final line
   * without a newline is the tail of a killed write and is skipped; a bad line
   * anywhere else is corruption and throws.
   */
  #read(stream: Stream): [unknown, number][] {
    const bytes = readIfExists(this.#guard([`${stream}.jsonl`]));
    if (bytes === null) return [];
    const lines = bytes.toString('utf8').split('\n');
    // The last element is either the empty string after the final newline or
    // the unterminated tail of a killed write. Neither is a record, even when
    // the tail happens to parse (`12` of a cut-off `123`).
    lines.pop();
    return lines.map((line, index): [unknown, number] => {
      try {
        return [JSON.parse(line), index + 1];
      } catch {
        // Every line here was newline-terminated, so a bad one is corruption,
        // not a killed write. The error names the line, never its content.
        throw new CorpusReadError(stream, index + 1);
      }
    });
  }

  /**
   * The one guard every read and write goes through. It returns the absolute
   * target for `segments` under the corpus root, or throws `CorpusPathError`
   * when any segment is empty, `.`, `..`, absolute, or contains NUL or a
   * backslash; when an `exact` segment (owner, repo) contains `/`; or when the
   * target, after following every symlink that already exists on the way to
   * it, is not inside the root. Nothing is created before it returns.
   *
   * Only this process writes under the root, and it writes regular files and
   * directories only, so a symlink can come only from outside the collector.
   */
  #guard(segments: string[], exact: string[] = []): string {
    if (exact.some((segment) => segment.includes('/'))) throw new CorpusPathError();
    for (const segment of segments) {
      if (
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        isAbsolute(segment) ||
        segment.includes('\0') ||
        segment.includes('\\')
      ) {
        throw new CorpusPathError();
      }
    }
    const target = resolve(this.#root, ...segments);
    if (!isInside(this.#root, target)) throw new CorpusPathError();

    // Follow symlinks through the deepest part of the path that exists. A
    // dangling link cannot be resolved, so it is refused rather than written
    // through to wherever it points.
    let existing = target;
    while (lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
      existing = dirname(existing);
    }
    let real: string;
    try {
      real = realpathSync(existing);
    } catch {
      // A dangling or looping symlink: its destination is unknown, so refuse.
      throw new CorpusPathError();
    }
    if (real !== this.#root && !isInside(this.#root, real)) throw new CorpusPathError();
    return target;
  }
}

/** The key `completedFiles()` returns for one file at one commit. */
export function fileKey(repo: string, commitSha: string, path: string): string {
  return `${repo}@${commitSha}:${path}`;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readIfExists(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}
