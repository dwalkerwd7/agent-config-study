/**
 * The config-class target paths from `study/plan.md` §5. Every pattern is
 * relative to the repository root. `**` stands for zero or more whole path
 * segments and appears only as a segment of its own; every other segment is
 * compared exactly, case included.
 */
export const TARGETS = [
  { pattern: '.mcp.json', kind: 'mcp', client: 'claude-code' },
  { pattern: '.cursor/mcp.json', kind: 'mcp', client: 'cursor' },
  { pattern: '.vscode/mcp.json', kind: 'mcp', client: 'vscode' },
  { pattern: '.junie/mcp/mcp.json', kind: 'mcp', client: 'junie' },
  { pattern: '.claude/settings.json', kind: 'settings', client: 'claude-code' },
  { pattern: '.claude/skills/**/SKILL.md', kind: 'skill', client: 'claude-code' },
  { pattern: '.cursor/rules/**', kind: 'rules', client: 'cursor' },
  { pattern: 'CLAUDE.md', kind: 'instructions', client: 'claude-code' },
  // AGENTS.md is a convention several clients read, not one client's file.
  { pattern: 'AGENTS.md', kind: 'instructions', client: 'agents-md' },
  { pattern: '.github/copilot-instructions.md', kind: 'instructions', client: 'copilot' },
] as const;

export type Target = (typeof TARGETS)[number];
export type TargetKind = Target['kind'];
export type TargetClient = Target['client'];

/** Classified at collection time (C-5). v1 collects config-class files only. */
export interface TargetMatch {
  class: 'config';
  kind: TargetKind;
  client: TargetClient;
  /** The pattern that matched, which names the target a file counts toward when sampling. */
  target: Target['pattern'];
}

const COMPILED = TARGETS.map((target) => ({ target, segments: target.pattern.split('/') }));

/**
 * Classifies a repository-relative tree path, or returns `null` when it is not
 * a target. A path containing `..`, starting with `/`, or containing NUL is
 * rejected outright rather than matched, so it can never be treated as a
 * target however the rest of it reads.
 */
export function matchTarget(path: string): TargetMatch | null {
  if (!isSafeTreePath(path)) return null;
  const segments = path.split('/');
  // Git tree paths are already normal; `a//b`, `a/./b` or a trailing `/` is
  // not one, so it is not a target either.
  if (segments.some((segment) => segment === '' || segment === '.')) return null;
  for (const { target, segments: pattern } of COMPILED) {
    if (matchSegments(pattern, 0, segments, 0)) {
      return { class: 'config', kind: target.kind, client: target.client, target: target.pattern };
    }
  }
  return null;
}

function isSafeTreePath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\0') && !path.includes('..');
}

function matchSegments(pattern: string[], p: number, path: string[], s: number): boolean {
  if (p === pattern.length) return s === path.length;
  const head = pattern[p];
  if (head === '**') {
    // A trailing `**` needs at least one segment: `.cursor/rules/**` matches
    // files under the directory, not the directory itself.
    if (p === pattern.length - 1) return s < path.length;
    for (let i = s; i < path.length; i++) {
      if (matchSegments(pattern, p + 1, path, i)) return true;
    }
    return false;
  }
  return s < path.length && path[s] === head && matchSegments(pattern, p + 1, path, s + 1);
}
