import { describe, expect, it } from 'vitest';
import { SEARCH_TERMS, SIZE_BANDS, buildSlices } from '../src/queries.js';
import { TARGETS } from '../src/targets.js';

// Counted here independently of the builder, so the limit is checked against
// what code search would see rather than against the builder's own counter.
function booleanOperators(query: string): number {
  return (query.match(/(?:^|\s)(?:AND|OR|NOT)(?=\s|$)/g) ?? []).length;
}

describe('buildSlices', () => {
  const slices = buildSlices();

  it('crosses every target with every size band', () => {
    expect(slices).toHaveLength(TARGETS.length * SIZE_BANDS.length);
    for (const target of TARGETS) {
      expect(slices.filter((slice) => slice.target === target)).toHaveLength(SIZE_BANDS.length);
    }
  });

  it('keeps every query within the code-search limits', () => {
    for (const { query } of slices) {
      expect(query.length).toBeLessThanOrEqual(256);
      expect(booleanOperators(query)).toBeLessThanOrEqual(5);
    }
  });

  it('never asks for forks or private repositories', () => {
    for (const { query } of slices) {
      expect(query).not.toMatch(/fork:/);
      expect(query).not.toMatch(/is:private/);
    }
  });

  it.each([
    ['.mcp.json', 'mcpServers filename:.mcp.json size:<1000'],
    ['.cursor/mcp.json', 'mcpServers path:.cursor filename:mcp.json size:<1000'],
    ['.vscode/mcp.json', 'servers path:.vscode filename:mcp.json size:<1000'],
    ['.junie/mcp/mcp.json', 'mcpServers path:.junie/mcp filename:mcp.json size:<1000'],
    ['.claude/settings.json', 'permissions path:.claude filename:settings.json size:<1000'],
    ['.claude/skills/**/SKILL.md', 'description path:.claude/skills filename:SKILL.md size:<1000'],
    ['.cursor/rules/**', 'description path:.cursor/rules size:<1000'],
    ['CLAUDE.md', 'claude filename:CLAUDE.md size:<1000'],
    ['AGENTS.md', 'agents filename:AGENTS.md size:<1000'],
    [
      '.github/copilot-instructions.md',
      'copilot path:.github filename:copilot-instructions.md size:<1000',
    ],
  ])('builds the first-band query for %s', (pattern, query) => {
    expect(slices.find((slice) => slice.id === `${pattern}@size:<1000`)?.query).toBe(query);
  });

  it('puts each size band on its own slice', () => {
    expect(
      slices.filter((slice) => slice.target.pattern === 'AGENTS.md').map((slice) => slice.query),
    ).toEqual([
      'agents filename:AGENTS.md size:<1000',
      'agents filename:AGENTS.md size:1000..4999',
      'agents filename:AGENTS.md size:5000..19999',
      'agents filename:AGENTS.md size:>=20000',
    ]);
  });

  it('gives every slice a unique id', () => {
    const ids = slices.map((slice) => slice.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds the same ids and queries on a second call', () => {
    expect(buildSlices()).toEqual(slices);
  });

  it('keeps each id on the same query when the target list is reordered', () => {
    const byId = (list: typeof slices) =>
      Object.fromEntries(list.map((slice) => [slice.id, slice.query]));
    expect(byId(buildSlices([...TARGETS].reverse()))).toEqual(byId(slices));
  });

  it('has a one-word search term for every target', () => {
    for (const target of TARGETS) {
      expect(SEARCH_TERMS[target.pattern]).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
