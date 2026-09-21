import { createHmac } from 'node:crypto';

/**
 * The credential redactor, the study's main safety control (C-1). Every
 * credential-shaped value in a collected file is replaced with a typed
 * placeholder before anything is written to disk, and each replacement is
 * recorded with only the fields C-2 allows. Detection is pattern-only: nothing
 * here contacts a service to check a value (D-4).
 *
 * Every pattern is linear in the input. Quantifiers are either bounded or over
 * a single character class, alternations inside a repetition are disjoint, and
 * each token pattern refuses to start inside a longer identifier, so a run of
 * near-misses is scanned once rather than once per position.
 */

export type DetectorName =
  | 'pem'
  | 'jwt'
  | 'github'
  | 'aws'
  | 'anthropic'
  | 'openai'
  | 'slack'
  | 'stripe'
  | 'google'
  | 'keyed-literal';

/**
 * One redacted value. Exactly these four fields and nothing derived from the
 * value itself — no prefix, no length (C-2, P-8). `offset` is the UTF-8 byte
 * offset of the value in the original text; `hash` is HMAC-SHA256 of the value
 * keyed with the salt, in hex.
 */
export interface RedactionHit {
  detector: DetectorName;
  valueType: string;
  offset: number;
  hash: string;
}

export interface RedactionResult {
  text: string;
  hits: RedactionHit[];
}

/** A value's span in UTF-16 code units, as `String.prototype.slice` takes it. */
interface Span {
  start: number;
  end: number;
  valueType: string;
}

interface Detector {
  name: DetectorName;
  /** Global, so `matchAll` walks every match. */
  pattern: RegExp;
  /** The value inside a match and its type, or `null` when it is not a credential. */
  toSpan(match: RegExpMatchArray): Span | null;
}

/** The whole match is the value, with a type that depends only on the detector. */
function whole(valueType: string | ((value: string) => string)) {
  return (match: RegExpMatchArray): Span | null => {
    if (match.index === undefined) return null;
    const value = match[0];
    return {
      start: match.index,
      end: match.index + value.length,
      valueType: typeof valueType === 'string' ? valueType : valueType(value),
    };
  };
}

const GITHUB_TYPES: Record<string, string> = {
  ghp: 'personal-access-token',
  gho: 'oauth-token',
  ghu: 'user-to-server-token',
  ghs: 'server-to-server-token',
  ghr: 'refresh-token',
  git: 'fine-grained-personal-access-token',
};

const KEYWORD_TYPES: Record<string, string> = {
  token: 'token',
  secret: 'secret',
  password: 'password',
  passwd: 'password',
  apikey: 'api-key',
  accesskey: 'access-key',
  privatekey: 'private-key',
};

/**
 * In priority order: when two detectors match overlapping text, the one listed
 * first wins, so the more specific detector must come before the more general
 * one (`sk-ant-` before `sk-`, every token format before the keyed literal).
 */
const DETECTORS: readonly Detector[] = [
  {
    name: 'pem',
    // The body cannot cross a `-----` run, so an unterminated header stops at
    // the next marker rather than scanning on to a later block's footer. A
    // header with no footer at all (a truncated file) is still redacted, up to
    // that marker or 64 KiB, whichever comes first.
    pattern:
      /-----BEGIN[ A-Z0-9]{0,64}PRIVATE KEY(?: BLOCK)?-----(?:[^-]|-(?!----)){0,65536}(?:-----END[ A-Z0-9]{0,64}PRIVATE KEY(?: BLOCK)?-----)?/g,
    toSpan: whole('private-key'),
  },
  {
    name: 'jwt',
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    toSpan: whole('jwt'),
  },
  {
    name: 'github',
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
    toSpan: whole((value) => GITHUB_TYPES[value.slice(0, 3)] ?? 'token'),
  },
  {
    name: 'aws',
    pattern: /(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}/g,
    toSpan: whole('access-key-id'),
  },
  {
    name: 'anthropic',
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g,
    toSpan: whole('api-key'),
  },
  {
    name: 'openai',
    // `sk-ant-` is Anthropic's; the lookahead keeps a short one from landing
    // here when the Anthropic pattern does not match it.
    pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    toSpan: whole((value) => (value.startsWith('sk-proj-') ? 'project-key' : 'api-key')),
  },
  {
    name: 'slack',
    pattern: /(?<![A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{10,}/g,
    toSpan: whole('token'),
  },
  {
    name: 'stripe',
    pattern: /(?<![A-Za-z0-9_])sk_live_[A-Za-z0-9]{10,}/g,
    toSpan: whole('secret-key'),
  },
  {
    name: 'google',
    pattern: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}/g,
    toSpan: whole('api-key'),
  },
  {
    name: 'keyed-literal',
    // A key whose name ends in one of the keywords (`GITHUB_TOKEN`, `apiKey`,
    // `db_password`), optionally quoted, then `:` or `=`, then a quoted value
    // on the same line. Ending in the keyword keeps `tokenizer` and
    // `secret_name` out. A backslash escape is part of the value, so an
    // escaped quote cannot end it early and leave the rest in the output.
    pattern:
      /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,64}?(?<keyword>token|secret|passw(?:or)?d|api[_.-]?key|access[_.-]?key|private[_.-]?key)s?["']?[ \t]{0,16}[:=][ \t]{0,16}(?:"(?<dq>(?:[^"\\\r\n]|\\.)+)"|'(?<sq>(?:[^'\\\r\n]|\\.)+)')/dgi,
    toSpan: keyedLiteralSpan,
  },
];

function keyedLiteralSpan(match: RegExpMatchArray): Span | null {
  const groups = match.groups;
  const indices = match.indices?.groups;
  const value = groups?.['dq'] ?? groups?.['sq'];
  const span = indices?.['dq'] ?? indices?.['sq'];
  const keyword = groups?.['keyword'];
  if (value === undefined || span === undefined || keyword === undefined) return null;
  if (isReference(value) || !isHighEntropy(value)) return null;
  const valueType = KEYWORD_TYPES[keyword.toLowerCase().replace(/[_.-]/g, '')] ?? 'secret';
  return { start: span[0], end: span[1], valueType };
}

/** `${VAR}`, `$VAR` and `<placeholder>` point at a value; they are not one. */
function isReference(value: string): boolean {
  return (
    /^\$\{[^}]*\}$/.test(value) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    /^<[^<>]*>$/.test(value)
  );
}

/**
 * At least 8 characters and 3 bits of Shannon entropy per character. Eight
 * distinct characters is exactly 3 bits, so a short random value passes while
 * a word with a repeated letter (`password`, `changeme`) or a filler run
 * (`xxxxxxxx`) does not.
 */
const MIN_LENGTH = 8;
const MIN_ENTROPY_BITS = 3;

function isHighEntropy(value: string): boolean {
  const chars = [...value];
  if (chars.length < MIN_LENGTH) return false;
  const counts = new Map<string, number>();
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / chars.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= MIN_ENTROPY_BITS;
}

function hmacSha256(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value, 'utf8').digest('hex');
}

/**
 * Replaces every credential-shaped value in `text` with `<REDACTED:detector>`
 * and returns the redacted text with one hit per value, in text order. `salt`
 * keys the hash; the caller supplies it, so nothing here reads the environment.
 *
 * Only a missing salt throws, with a fixed message. The input text never
 * reaches an error.
 */
export function redact(text: string, salt: string): RedactionResult {
  if (salt.length === 0) throw new Error('redact: salt must not be empty');

  // One flag per code unit, set once a value is claimed. Detectors run in
  // priority order, so a later, more general match that overlaps a claimed
  // value is dropped rather than producing a second hit for the same text.
  const claimed = new Uint8Array(text.length);
  const found: (Span & { detector: DetectorName })[] = [];
  for (const detector of DETECTORS) {
    for (const match of text.matchAll(detector.pattern)) {
      const span = detector.toSpan(match);
      if (span === null || isClaimed(claimed, span)) continue;
      claimed.fill(1, span.start, span.end);
      found.push({ ...span, detector: detector.name });
    }
  }
  found.sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  const hits: RedactionHit[] = [];
  let cursor = 0;
  let bytes = 0;
  for (const { start, end, valueType, detector } of found) {
    const before = text.slice(cursor, start);
    const value = text.slice(start, end);
    bytes += Buffer.byteLength(before, 'utf8');
    parts.push(before, `<REDACTED:${detector}>`);
    hits.push({ detector, valueType, offset: bytes, hash: hmacSha256(salt, value) });
    bytes += Buffer.byteLength(value, 'utf8');
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(''), hits };
}

function isClaimed(claimed: Uint8Array, span: Span): boolean {
  for (let i = span.start; i < span.end; i++) if (claimed[i] === 1) return true;
  return false;
}
