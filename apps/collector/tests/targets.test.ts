import { describe, expect, it } from 'vitest';
import { TARGETS, matchTarget } from '../src/targets.js';

describe('matchTarget', () => {
  it.each([
    ['.mcp.json', 'mcp', 'claude-code'],
    ['.cursor/mcp.json', 'mcp', 'cursor'],
    ['.vscode/mcp.json', 'mcp', 'vscode'],
    ['.junie/mcp/mcp.json', 'mcp', 'junie'],
    ['.claude/settings.json', 'settings', 'claude-code'],
    ['.claude/skills/review/SKILL.md', 'skill', 'claude-code'],
    ['.cursor/rules/style.mdc', 'rules', 'cursor'],
    ['CLAUDE.md', 'instructions', 'claude-code'],
    ['AGENTS.md', 'instructions', 'agents-md'],
    ['.github/copilot-instructions.md', 'instructions', 'copilot'],
  ])('classifies %s', (path, kind, client) => {
    expect(matchTarget(path)).toEqual({ class: 'config', kind, client });
  });

  it('has a case above for every target in the list', () => {
    expect(TARGETS).toHaveLength(10);
  });

  it('matches nested files under the two glob targets', () => {
    expect(matchTarget('.claude/skills/group/deploy/SKILL.md')).toEqual({
      class: 'config',
      kind: 'skill',
      client: 'claude-code',
    });
    expect(matchTarget('.claude/skills/SKILL.md')).toEqual({
      class: 'config',
      kind: 'skill',
      client: 'claude-code',
    });
    expect(matchTarget('.cursor/rules/frontend/react/hooks.mdc')).toEqual({
      class: 'config',
      kind: 'rules',
      client: 'cursor',
    });
  });

  it.each([
    'docs/CLAUDE.md.bak',
    'CLAUDE.md.bak',
    'docs/CLAUDE.md',
    'claude.md',
    '.claude/settings.local.json',
    'x.mcp.json',
    'mcp.json',
    'packages/app/.mcp.json',
    '.cursor/mcp.jsonc',
    '.vscode/settings.json',
    '.junie/mcp.json',
    '.claude/skills/review/README.md',
    '.claude/skills/review/skill.md',
    '.cursor/rules',
    '.cursor/rules/',
    '.cursor/rulesets/a.mdc',
    '.github/copilot-instructions.md.orig',
    'src/.github/copilot-instructions.md',
    '.mcp.json/',
    '.cursor//mcp.json',
    '.cursor/./mcp.json',
    '',
  ])('does not match %j', (path) => {
    expect(matchTarget(path)).toBeNull();
  });

  it.each([
    '../.mcp.json',
    '.cursor/../.mcp.json',
    '.cursor/rules/../../x',
    '.cursor/rules/..',
    '/abs/.mcp.json',
    '/.mcp.json',
    '.mcp.json\0',
    '.cursor/rules/a\0.mdc',
  ])('rejects the unsafe path %j', (path) => {
    expect(matchTarget(path)).toBeNull();
  });
});
