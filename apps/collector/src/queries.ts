import { TARGETS, type Target } from './targets.js';

/**
 * One code-search query. Code search stops at 1,000 results per query, so
 * discovery runs many narrow slices instead of one broad query.
 */
export interface Slice {
  /** Stable across runs: built from the target pattern and the size band. */
  id: string;
  query: string;
  target: Target;
}

/**
 * The search term for each target. REST code search needs at least one term,
 * and without `in:` it matches the term against file content only. So the term
 * decides which files at the path are found. Each one is the most neutral word
 * its file format always contains, with the reason beside it. The owner
 * reviews these before the first run.
 */
export const SEARCH_TERMS: Record<Target['pattern'], string> = {
  // The top-level key of Claude Code's project MCP file.
  '.mcp.json': 'mcpServers',
  // Cursor's MCP file uses the same top-level key.
  '.cursor/mcp.json': 'mcpServers',
  // VS Code's MCP file keys its entries under `servers`, not `mcpServers`.
  '.vscode/mcp.json': 'servers',
  // Junie's MCP file uses the `mcpServers` key.
  '.junie/mcp/mcp.json': 'mcpServers',
  // The format requires no key; `permissions` is its core setting, so a file with only hooks, env or model is missed.
  '.claude/settings.json': 'permissions',
  // `description` is a required frontmatter field of every SKILL.md.
  '.claude/skills/**/SKILL.md': 'description',
  // Cursor writes a `description` key into every .mdc rule's frontmatter; a hand-written rule without one is missed.
  '.cursor/rules/**': 'description',
  // Free-form Markdown with no required word; `claude` names the tool the file is written for.
  'CLAUDE.md': 'claude',
  // Free-form Markdown with no required word; `agents` names the convention the file follows.
  'AGENTS.md': 'agents',
  // Free-form Markdown with no required word; `copilot` names the tool the file is written for.
  '.github/copilot-instructions.md': 'copilot',
};

/**
 * File-size bands, in bytes, crossed with every target. They break relevance
 * ranking into pieces small enough to stay under the 1,000-result cap. The
 * owner finalises the list with a dry run before the first real run.
 */
export const SIZE_BANDS: readonly string[] = [
  'size:<1000',
  'size:1000..4999',
  'size:5000..19999',
  'size:>=20000',
];

/** Limits code search puts on a query (`study/plan.md` §5). */
export const MAX_QUERY_LENGTH = 256;
export const MAX_BOOLEAN_OPERATORS = 5;

/**
 * Builds every slice: each target's term and path qualifiers, crossed with the
 * size bands. `fork:` is left at its default, which excludes forks (C-6).
 * Throws if any query breaks a code-search limit, so a bad term or band fails
 * before a run starts rather than as a rejected request.
 */
export function buildSlices(targets: readonly Target[] = TARGETS): Slice[] {
  const slices: Slice[] = [];
  const ids = new Set<string>();
  for (const target of targets) {
    const term = SEARCH_TERMS[target.pattern];
    if (!/^[A-Za-z0-9_-]+$/.test(term)) {
      throw new Error(`search term for ${target.pattern} must be one plain word`);
    }
    const base = `${term} ${pathQualifiers(target.pattern)}`;
    for (const band of SIZE_BANDS) {
      const id = `${target.pattern}@${band}`;
      const query = `${base} ${band}`;
      if (ids.has(id)) throw new Error(`duplicate slice id ${id}`);
      if (query.length > MAX_QUERY_LENGTH) {
        throw new Error(`slice ${id} is longer than ${MAX_QUERY_LENGTH} characters`);
      }
      if (countBooleanOperators(query) > MAX_BOOLEAN_OPERATORS) {
        throw new Error(`slice ${id} has more than ${MAX_BOOLEAN_OPERATORS} boolean operators`);
      }
      ids.add(id);
      slices.push({ id, query, target });
    }
  }
  return slices;
}

/** Code search's boolean operators are the upper-case words AND, OR and NOT. */
function countBooleanOperators(query: string): number {
  return query.split(/\s+/).filter((word) => word === 'AND' || word === 'OR' || word === 'NOT')
    .length;
}

/**
 * Turns a target pattern into `path:`/`filename:` qualifiers. The directory is
 * everything before the first `**` (or before the file name), and the file name
 * is the last segment unless the pattern ends in `**`.
 */
function pathQualifiers(pattern: string): string {
  const segments = pattern.split('/');
  const glob = segments.indexOf('**');
  const last = segments[segments.length - 1];
  const filename = last === undefined || last === '**' ? null : last;
  const dir = segments.slice(0, glob === -1 ? segments.length - 1 : glob).join('/');
  return [dir === '' ? null : `path:${dir}`, filename === null ? null : `filename:${filename}`]
    .filter((qualifier) => qualifier !== null)
    .join(' ');
}
