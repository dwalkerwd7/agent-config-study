import { describe, expect, it } from 'vitest';
import { safeEqual, sha256 } from '../src/hash.js';
import { ParseFailure, parseFrontmatter, parseJsonWithComments, parseYaml } from '../src/parse.js';

describe('sha256', () => {
  it('produces the known digest of the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('safeEqual', () => {
  it('compares without throwing on a length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('parseJsonWithComments', () => {
  it('accepts comments and trailing commas', () => {
    expect(parseJsonWithComments('{ /* hi */ "a": 1, }')).toEqual({ a: 1 });
  });

  it('throws ParseFailure on malformed input', () => {
    expect(() => parseJsonWithComments('{ "a": }', 'x.json')).toThrow(ParseFailure);
  });
});

describe('parseYaml', () => {
  it('parses a mapping', () => {
    expect(parseYaml('a: 1\nb: two\n')).toEqual({ a: 1, b: 'two' });
  });
});

describe('parseFrontmatter', () => {
  it('splits frontmatter from the body', () => {
    const doc = parseFrontmatter('---\nname: demo\n---\n\nBody text.\n');
    expect(doc.data).toEqual({ name: 'demo' });
    expect(doc.body.trim()).toBe('Body text.');
  });

  it('returns an empty object when there is no frontmatter', () => {
    expect(parseFrontmatter('Just text.\n').data).toEqual({});
  });
});
