# Corpus study collector — `apps/collector`

## Context

The build/no-build decision for driftwood depends on the corpus study (`study/plan.md`, governed by `study/rules.md`). Nothing has been collected yet. This plan covers the first piece: a standalone CLI app that finds public, non-fork repos with agent-config files through GitHub code search, fetches those files, redacts credential-shaped values before anything reaches disk, and writes them with provenance to `study/corpus/`, which is gitignored. Analysis comes later and is out of scope.

Decisions already made with you:

- **Slicing:** slice code search by path × file-size bands. Take stars and `pushed_at` from repo metadata and assign bands during analysis. REST `/search/code` has no `stars:` or `pushed:` qualifiers, returns at most 1,000 results per query, and needs a search term. `study/plan.md` §5 gets amended before the first run.
- **Per-repo expansion:** search is used to _discover_ repos. One tree call per repo then collects _every_ target path in it, which Q10 and Q13 need.
- **Config-class only in v1.** README documentation blocks come in a follow-up, still before the first run.

Branching: this worktree is on `scratch/reviewer-test`, whose `apps/api/src/scan/collector.ts` is a reviewer test fixture with a hardcoded token and config-URL fetching. Work from a fresh `feat/corpus-collector` branch off `main` and reuse nothing from that file.

## App layout (`apps/collector/`)

Mirror `apps/api`'s package and tsconfig shape: NodeNext ESM, `.js` import suffixes, `import type`, bracketed `process.env['X']`. Its env and logger are **not** imported from `apps/api`, because `apps/api/src/env.ts` requires `DATABASE_URL`. Postgres is not used at all: C-9 keeps the raw corpus inside `study/corpus/`, and the rubric in §7 treats an unused Prisma model as a finding.

- `package.json`: `@driftwood/collector`, private. Deps: `octokit`, `zod`, `pino`, with versions matching `apps/api`. Scripts: `collect` (`tsx src/cli.ts`), `build`/`typecheck` (`tsc -b`).
- `tsconfig.json`: copy of `apps/api/tsconfig.json` without the project references.
- `src/env.ts`: zod schema in the style of `apps/api/src/env.ts`. `GITHUB_TOKEN` is required; recommend a fine-grained PAT with public-repo read only, which makes P-14 structurally impossible. `CORPUS_SALT` is required, at least 32 chars, and never published (C-2, P-11). `LOG_LEVEL` is optional. The corpus directory is **not** configurable: it resolves to `<repo root>/study/corpus` (C-9).
- `src/logger.ts`: pino. It logs counts, repo names, query ids and API status. It never logs file content or any value read out of a file. Errors on the file path are rethrown with a fixed message plus repo and path, and never with the content.
- `src/targets.ts`: the target path list from plan §5 and a matcher (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.junie/mcp/mcp.json`, `.claude/settings.json`, `.claude/skills/**/SKILL.md`, `.cursor/rules/**`, `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`). Each match returns `{ class: 'config', kind, client }`, which classifies at collection time (C-5). Tree paths containing `..`, absolute paths, or NUL are rejected.
- `src/queries.ts`: builds the slice list. Each slice is one search term plus a `filename:`/`path:` qualifier, crossed with `size:` bands. For example, `mcpServers filename:.mcp.json`, `servers path:.vscode filename:mcp.json`, or `claude filename:CLAUDE.md`. Each slice has a stable id. The builder enforces ≤256 chars and ≤5 boolean operators. `fork:` is left at the default, which excludes forks, and results are filtered on `repository.fork` as well (C-6).
- `src/github.ts`: Octokit from the `octokit` package, whose bundled throttling and retry plugins handle the 10/min search limit and secondary limits (handlers log and retry). Thin wrappers:
  - `searchCode(q, page)`
  - `getRepo(o, r)`: stars, `pushed_at`, `default_branch`, `fork`, `private`, `archived`
  - `getTree(o, r, sha, recursive)`: records `truncated`
  - `getBlob(o, r, sha)`
  - `lastCommitForPath(o, r, path)`: `commits?path=&per_page=1`, for Q11

  Nothing named inside a config is ever fetched, spawned or resolved (rubric §4).

- `src/redact.ts`: pattern detectors, each with a name and value type:
  - GitHub (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`)
  - AWS `AKIA…`
  - Anthropic `sk-ant-`
  - OpenAI `sk-`/`sk-proj-`
  - Slack `xox?-`
  - Stripe `sk_live_`
  - Google `AIza`
  - PEM private-key blocks
  - JWT
  - a keyed-literal detector: key names like token, secret, password or api_key followed by a quoted high-entropy literal. It skips `${VAR}`, `$VAR`, `<placeholder>` and empty values.

  `redact(text) → { text, hits[] }` swaps each value for `<REDACTED:detector>`. It records `{detector, valueType, offset (in original bytes), hash: HMAC-SHA256(salt, value)}` and nothing else (C-1, C-2). There is no live validation (D-4). The raw string lives only in memory between `getBlob` and `redact`.

- `src/store.ts`: append-only JSONL under `study/corpus/`, one JSON object per line, flushed per record (C-8):
  - `runs.jsonl`: run id, start/end, `status: complete|partial`, stop reason
  - `responses.jsonl`: slice id, query, page, `total_count`, `incomplete_results`, timestamp (C-4)
  - `repos.jsonl`: full name, owner, stars, `pushed_at`, default branch, head commit, `tree_truncated`, discovering slice ids. It is written _last_ and marks the repo as done.
  - `files.jsonl`: repo, owner, commit SHA, path, blob SHA, kind, client, size, retrieved_at, `surfaced_by` (slice ids plus `via: search|tree`), `last_commit_at`, normalized content hash of the redacted text (C-3, C-7)
  - `redactions.jsonl`: file ref plus the C-2 fields
  - `files/<owner>/<repo>/<path>`: redacted content

  Every write goes through one guard that resolves the target and rejects anything outside the corpus dir. Readers tolerate a truncated final line.

- `src/collect.ts`: the two phases.
  1. **Discover.** Iterate slices × pages (up to 10 pages of 100), skip `(slice, page)` pairs already in `responses.jsonl`, record each response, and queue repos. Skip forks and private repos.
  2. **Expand.** For each queued repo not in `repos.jsonl`: `getRepo`, then the tree at default-branch HEAD, then filter targets. For each file: get the blob, decode, redact, write the file, append to `files.jsonl`/`redactions.jsonl`, and get the last commit for the path. After that, append to `repos.jsonl`.

  The run stops at 5,000 config-class files (plan §9), or on `--max-repos` or SIGINT. Any stop other than full exhaustion writes `status: partial`.

- `src/cli.ts`: `collect [--dry-run] [--max-repos N]`. `--dry-run` fetches only page 1 of each slice and prints the query, `total_count` and `incomplete_results` to stdout. It writes nothing to the corpus. Use it to finalize the slice list before the first real run, because the first real run is what locks the plan.

## Other edits

- Root `package.json`: add a `"collect": "pnpm --filter @driftwood/collector collect"` script.
- `.env.example`: add `CORPUS_SALT=""` with a comment to generate it with `openssl rand -hex 32` and never share it.
- `study/plan.md` §5: rewrite the query strategy to match reality. Code search is sliced by path × size. Stars and pushed bands are assigned post hoc from repo metadata. Repos are expanded via tree. Note the 1,000-result cap, the search-term requirement and the default-branch-only indexing as known biases. This is allowed without §10 because the plan isn't locked until the first run.
- `README.md` Status: one honest line saying a collector exists and no data has been collected yet.

## Tests (`apps/collector/tests/`, never colocated)

These follow the pattern in `packages/core/tests/core.test.ts` and assert returned values:

- `redact.test.ts`: each detector redacts to its typed placeholder, the output contains no raw value, offsets are correct, the hash is stable for a given salt and changes with the salt, `${VAR}`/placeholder values are left alone, and hostile or huge input doesn't throw with content in the message.
- `targets.test.ts`: each target path matches with the right kind and client, non-targets don't match, and traversal paths are rejected.
- `queries.test.ts`: every built slice is ≤256 chars with ≤5 operators, and ids are unique and stable.
- `store.test.ts` (tmp dir): the resume set is read correctly even with a truncated final line, and the write guard rejects escaping paths.

## Verification

1. `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm lint`.
2. `pnpm collect --dry-run` with a real token. Check that slices return sensible `total_count`s and that no files appear under `study/corpus/`.
3. `pnpm collect --max-repos 5`. Inspect the `study/corpus/` JSONL and files, and confirm provenance fields are present. Run `grep -rE 'ghp_|github_pat_|AKIA|sk-ant-|xox[baprs]-' study/corpus/files`: every hit should be a `<REDACTED:…>` placeholder.
4. Stop a run mid-expansion with Ctrl-C, check that `runs.jsonl` shows `partial`, then rerun. It should skip completed pages and repos without duplicating work.
5. Check that `git status` shows nothing under `study/corpus/`.
6. Have the `code-reviewer` agent review against `.claude/review-rubric.md`, especially §4 and §5.
