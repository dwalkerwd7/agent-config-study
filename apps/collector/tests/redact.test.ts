import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact.js';
import { FAKE } from './credential-fixtures.js';

const SALT = 'test-salt-0123456789abcdef0123456789';

function hmac(salt: string, value: string): string {
  return createHmac('sha256', salt).update(value, 'utf8').digest('hex');
}

/**
 * Every 6-character window of `value` that `text` still contains, outside the
 * placeholders (`github` is both a fragment of a fine-grained PAT and a detector
 * name).
 */
function fragmentsIn(text: string, value: string): string[] {
  const rest = text.replace(/<REDACTED:[a-z-]+>/g, '');
  const found: string[] = [];
  for (let i = 0; i + 6 <= value.length; i++) {
    const window = value.slice(i, i + 6);
    if (rest.includes(window)) found.push(window);
  }
  return found;
}

// A fine-grained PAT is `github_pat_`, 22 characters, `_`, then 59 more.
const GITHUB_FINE_GRAINED = `github_pat_${FAKE.github.slice(4, 26)}_${FAKE.keyedLiteral}${FAKE.github.slice(4, 31)}`;

describe('redact: each detector', () => {
  it.each([
    ['github', FAKE.github, 'personal-access-token'],
    ['github', FAKE.github.replace('ghp_', 'gho_'), 'oauth-token'],
    ['github', FAKE.github.replace('ghp_', 'ghu_'), 'user-to-server-token'],
    ['github', FAKE.github.replace('ghp_', 'ghs_'), 'server-to-server-token'],
    ['github', FAKE.github.replace('ghp_', 'ghr_'), 'refresh-token'],
    ['github', GITHUB_FINE_GRAINED, 'fine-grained-personal-access-token'],
    ['aws', FAKE.aws, 'access-key-id'],
    ['anthropic', FAKE.anthropic, 'api-key'],
    ['openai', FAKE.openai, 'project-key'],
    ['openai', `sk-${FAKE.keyedLiteral}${FAKE.keyedLiteral}`, 'api-key'],
    ['slack', FAKE.slack, 'token'],
    ['stripe', FAKE.stripe, 'secret-key'],
    ['google', FAKE.google, 'api-key'],
    ['jwt', FAKE.jwt, 'jwt'],
    ['pem', FAKE.pem, 'private-key'],
  ])('%s redacts a %s-shaped value', (detector, value, valueType) => {
    const before = '{\n  "env": {\n    "VALUE": "';
    const after = '"\n  }\n}\n';
    const result = redact(before + value + after, SALT);

    expect(result.text).toBe(`${before}<REDACTED:${detector}>${after}`);
    expect(fragmentsIn(result.text, value)).toEqual([]);
    expect(result.hits).toEqual([
      { detector, valueType, offset: Buffer.byteLength(before), hash: hmac(SALT, value) },
    ]);
  });

  it('redacts a PEM block that is never closed', () => {
    const truncated = FAKE.pem.slice(0, FAKE.pem.indexOf('-----END'));
    const result = redact(`key = """\n${truncated}`, SALT);

    expect(result.text).toBe('key = """\n<REDACTED:pem>');
    expect(fragmentsIn(result.text, truncated)).toEqual([]);
    expect(result.hits.map((hit) => hit.detector)).toEqual(['pem']);
  });

  it.each([
    ['"api_key": "%s"', 'api-key'],
    ["apiKey: '%s'", 'api-key'],
    ['GITHUB_TOKEN="%s"', 'token'],
    ['"client_secret" : "%s"', 'secret'],
    ['db_password = "%s"', 'password'],
    ['AWS_ACCESS_KEY="%s"', 'access-key'],
    ['"private-key": "%s"', 'private-key'],
  ])('keyed-literal redacts the value in %s', (template, valueType) => {
    const [before = '', after = ''] = template.split('%s');
    const result = redact(before + FAKE.keyedLiteral + after, SALT);

    expect(result.text).toBe(`${before}<REDACTED:keyed-literal>${after}`);
    expect(fragmentsIn(result.text, FAKE.keyedLiteral)).toEqual([]);
    expect(result.hits).toEqual([
      {
        detector: 'keyed-literal',
        valueType,
        offset: Buffer.byteLength(before),
        hash: hmac(SALT, FAKE.keyedLiteral),
      },
    ]);
  });

  it('keeps an escaped quote inside a keyed literal', () => {
    const value = `${FAKE.keyedLiteral.slice(0, 16)}\\"${FAKE.keyedLiteral.slice(16)}`;
    const result = redact(`{"password": "${value}"}`, SALT);

    expect(result.text).toBe('{"password": "<REDACTED:keyed-literal>"}');
    expect(result.hits[0]?.hash).toBe(hmac(SALT, value));
  });

  it('leaves text with no credential in it unchanged', () => {
    const text = [
      '{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "server-github"],',
      '  "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } } } }',
      '"tokenizer": "bert-base-uncased-whole-word-masking"',
      '"password": "changeme"',
      'task-force-alpha-bravo-charlie-delta ask-for-review-before-merging-anything',
    ].join('\n');

    expect(redact(text, SALT)).toEqual({ text, hits: [] });
  });
});

describe('redact: offsets', () => {
  it('counts UTF-8 bytes, not UTF-16 code units, after multi-byte characters', () => {
    const first = '# 🦀 Café config — ✓\n"token": "';
    const middle = '"\nsee ✨ 日本語 ';
    const text = `${first}${FAKE.keyedLiteral}${middle}${FAKE.github}\n`;
    const bytes = Buffer.from(text, 'utf8');

    const { hits } = redact(text, SALT);

    expect(hits.map((hit) => hit.offset)).toEqual([
      Buffer.byteLength(first),
      Buffer.byteLength(first + FAKE.keyedLiteral + middle),
    ]);
    // The offsets are not the string indices, which is what makes this case matter.
    expect(hits[0]?.offset).not.toBe(first.length);
    const [keyed, github] = hits;
    expect(bytes.subarray(keyed?.offset, (keyed?.offset ?? 0) + 32).toString()).toBe(
      FAKE.keyedLiteral,
    );
    expect(bytes.subarray(github?.offset, (github?.offset ?? 0) + 40).toString()).toBe(FAKE.github);
  });

  it('counts a lone surrogate as the three bytes it is written as', () => {
    const before = 'a\uD800b\uDC00c ';
    const { hits } = redact(`${before}${FAKE.aws}`, SALT);

    expect(hits.map((hit) => hit.offset)).toEqual([Buffer.byteLength(before)]);
    expect(hits[0]?.offset).toBe(10);
  });

  it('returns hits in text order whatever the detector order', () => {
    const text = `${FAKE.jwt} ${FAKE.aws} "secret": "${FAKE.keyedLiteral}" ${FAKE.github}`;
    const { hits } = redact(text, SALT);

    expect(hits.map((hit) => hit.detector)).toEqual(['jwt', 'aws', 'keyed-literal', 'github']);
    expect(hits.map((hit) => hit.offset)).toEqual([
      0,
      FAKE.jwt.length + 1,
      text.indexOf(FAKE.keyedLiteral),
      text.indexOf(FAKE.github),
    ]);
  });
});

describe('redact: hash', () => {
  it('is the same for the same value and salt, wherever the value appears', () => {
    const one = redact(`A=${FAKE.aws}`, SALT).hits[0]?.hash;
    const two = redact(`\n\n  aws: ${FAKE.aws} # again`, SALT).hits[0]?.hash;

    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(two).toBe(one);
  });

  it('changes with the salt', () => {
    const one = redact(FAKE.aws, SALT).hits[0]?.hash;
    const two = redact(FAKE.aws, `${SALT}-other`).hits[0]?.hash;

    expect(two).toMatch(/^[0-9a-f]{64}$/);
    expect(two).not.toBe(one);
  });

  it('differs between values under one salt', () => {
    const { hits } = redact(`${FAKE.aws} ${FAKE.github}`, SALT);

    expect(new Set(hits.map((hit) => hit.hash)).size).toBe(2);
  });

  it('rejects an empty salt with a message that carries no input', () => {
    expect(() => redact(FAKE.github, '')).toThrow(/^redact: salt must not be empty$/);
  });
});

describe('redact: keyed-literal skips', () => {
  it.each([
    '"token": "${GITHUB_TOKEN}"',
    '"token": "${env:GITHUB_TOKEN}"',
    "api_key: '$OPENAI_API_KEY'",
    '"password": "<your-password-here>"',
    '"secret": ""',
    "API_KEY=''",
    '"token": "xxxxxxxxxxxxxxxx"',
  ])('leaves %s untouched', (text) => {
    expect(redact(text, SALT)).toEqual({ text, hits: [] });
  });
});

describe('redact: overlapping matches', () => {
  it('reports an Anthropic key once, as Anthropic, not also as OpenAI', () => {
    const { text, hits } = redact(FAKE.anthropic, SALT);

    expect(text).toBe('<REDACTED:anthropic>');
    expect(hits.map((hit) => hit.detector)).toEqual(['anthropic']);
  });

  it('reports a known token under a secret-looking key once, from the token detector', () => {
    const { text, hits } = redact(`"ANTHROPIC_API_KEY": "${FAKE.anthropic}"`, SALT);

    expect(text).toBe('"ANTHROPIC_API_KEY": "<REDACTED:anthropic>"');
    expect(hits).toEqual([
      { detector: 'anthropic', valueType: 'api-key', offset: 22, hash: hmac(SALT, FAKE.anthropic) },
    ]);
  });

  it('redacts a token inside a keyed literal without a second hit for the rest', () => {
    const { text, hits } = redact(`"Authorization": "Bearer ${FAKE.github}"`, SALT);

    expect(text).toBe('"Authorization": "Bearer <REDACTED:github>"');
    expect(hits.map((hit) => hit.detector)).toEqual(['github']);
  });
});

describe('redact: hostile input', () => {
  const FIVE_MB = 5 * 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(FIVE_MB / unit.length));

  it.each([
    ['plain filler', fill('a')],
    ['repeated GitHub prefixes', fill('ghp_')],
    ['repeated OpenAI prefixes', fill('sk-')],
    ['repeated Anthropic prefixes', fill('sk-ant-')],
    ['repeated AWS prefixes', fill('AKIA')],
    ['repeated Slack prefixes', fill('xoxb-')],
    ['repeated Google prefixes', fill('AIza')],
    ['repeated JWT near-misses', fill('eyJabcde.')],
    ['repeated unterminated PEM headers', fill('-----BEGIN PRIVATE KEY-----\n')],
    ['repeated PEM footers', fill('-----END PRIVATE KEY-----\n')],
    ['repeated keyed openings', fill('token: "')],
    ['repeated key names', fill('api_key_token_secret_')],
    ['an unclosed keyed literal', `"password": "${fill('Ab1')}`],
    ['an unclosed escape run', `"password": "${fill('\\')}`],
    ['lone surrogates', fill('\uD83D')],
    ['decoded invalid UTF-8', new TextDecoder().decode(Buffer.alloc(FIVE_MB, 0xff))],
  ])(
    'handles %s within its time bound',
    (_label, filler) => {
      const text = `${filler}\n${FAKE.github}\n`;
      const started = performance.now();
      const result = redact(text, SALT);
      const elapsed = performance.now() - started;

      // The token after the filler is still redacted, so the scan did not give
      // up. (An unterminated PEM header claims it as part of the key instead.)
      expect(result.hits.length).toBeGreaterThan(0);
      expect(fragmentsIn(result.text.slice(-200), FAKE.github)).toEqual([]);
      expect(elapsed).toBeLessThan(5_000);
    },
    20_000,
  );
});
