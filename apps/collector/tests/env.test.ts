import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corpusDir, loadEnv } from '../src/env.js';

// Distinctive, obviously fake markers: the assertions check that neither
// value is echoed back in the error text.
const TOKEN = 'fake-token-marker-for-env-test';
const SALT = 'fake-salt-marker-0123456789abcdef-long-enough';
const SHORT_SALT = 'fake-salt-marker-too-short';

function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('returns the parsed values with LOG_LEVEL defaulted', () => {
    expect(loadEnv({ GITHUB_TOKEN: TOKEN, CORPUS_SALT: SALT })).toEqual({
      GITHUB_TOKEN: TOKEN,
      CORPUS_SALT: SALT,
      LOG_LEVEL: 'info',
    });
  });

  it('accepts an explicit LOG_LEVEL', () => {
    expect(loadEnv({ GITHUB_TOKEN: TOKEN, CORPUS_SALT: SALT, LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe(
      'debug',
    );
  });

  it('fails without GITHUB_TOKEN and does not echo the salt', () => {
    const text = errorText(() => loadEnv({ CORPUS_SALT: SALT }));
    expect(text).toContain('GITHUB_TOKEN');
    expect(text).not.toContain(SALT);
  });

  it('fails on an empty GITHUB_TOKEN', () => {
    expect(errorText(() => loadEnv({ GITHUB_TOKEN: '', CORPUS_SALT: SALT }))).toContain(
      'GITHUB_TOKEN',
    );
  });

  it('fails without CORPUS_SALT', () => {
    const text = errorText(() => loadEnv({ GITHUB_TOKEN: TOKEN }));
    expect(text).toContain('CORPUS_SALT');
    expect(text).not.toContain(TOKEN);
  });

  it('fails on a CORPUS_SALT under 32 characters and echoes neither value', () => {
    expect(SHORT_SALT.length).toBeLessThan(32);
    const text = errorText(() => loadEnv({ GITHUB_TOKEN: TOKEN, CORPUS_SALT: SHORT_SALT }));
    expect(text).toContain('CORPUS_SALT');
    expect(text).not.toContain(SHORT_SALT);
    expect(text).not.toContain(TOKEN);
  });

  it('accepts a CORPUS_SALT of exactly 32 characters', () => {
    const salt = 'x'.repeat(32);
    expect(loadEnv({ GITHUB_TOKEN: TOKEN, CORPUS_SALT: salt }).CORPUS_SALT).toBe(salt);
  });

  it('echoes neither secret when another variable is invalid', () => {
    const text = errorText(() =>
      loadEnv({ GITHUB_TOKEN: TOKEN, CORPUS_SALT: SALT, LOG_LEVEL: 'loud' }),
    );
    expect(text).toContain('LOG_LEVEL');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SALT);
  });
});

describe('corpusDir', () => {
  it('resolves to study/corpus under the repository root', () => {
    const dir = corpusDir();
    expect(dir.endsWith(`${sep}study${sep}corpus`)).toBe(true);
    const root = join(dir, '..', '..');
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
  });
});
