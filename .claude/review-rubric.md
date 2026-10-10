# Review rubric — agent-config-study

Project rules for the `agent-reviewer` agent, layered on top of its generic
dimensions. Where this file and the generic rules disagree, this file wins.

CI runs `.claude/scripts/verify.sh`: prettier, type-aware eslint
(`recommendedTypeChecked`), `tsc`, vitest, semgrep and gitleaks, plus a
dependency audit and workflow lint. Do not report what those already fail on.
They check syntax and known patterns, not intent — the rules below are the part
only review catches.

The repo holds a corpus study: the collector in `apps/collector` and the study
documents and analysis script in `study/`. Judge changes against what was asked
for.

## 1. TypeScript strictness

`tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`,
`exactOptionalPropertyTypes`, and `verbatimModuleSyntax`. That shapes how the
existing code is written, and new code matches it:

- Environment access goes through the zod schema in `apps/collector/src/env.ts`.
- Indexed access is guarded before use: `first?.offset ?? 0`.
- An optional property is spread conditionally rather than assigned `undefined`.
- Relative imports carry a `.js` extension. The packages are NodeNext ESM and
  an extensionless import resolves at type-check but fails at runtime.
- Type-only imports use `import type`.

## 2. Tests

- **Tests live in `<workspace>/tests/`, never beside the source.** The Vitest
  glob in `vitest.config.ts` is `apps/*/tests/**/*.test.ts`. A colocated test file is silently never run,
  which is worse than no test because it reads as covered. This is a blocker,
  not a convention nit.
- A new detector or parser needs a test asserting the value returned, not that
  the call did not throw.

## 3. Handling untrusted config

This is the core of the collector: it reads agent-config files written by other people.
Code on that path is security-sensitive even though it looks like plumbing.

- **Never execute, spawn, resolve, or fetch anything a scanned config names.**
  A config naming `docker run` or an `npx` package is data to record, never a
  command to run. The same goes for a URL in an MCP server entry — do not fetch
  it to "check" it.
- **Never log raw config content or a value read out of one.**
  `apps/collector/src/logger.ts` already sets this posture with its pino
  `redact` paths; new logging keeps it.
- A parse failure on hostile input is expected. It must not crash a worker or
  leak file content into an error message. The same holds for `study/analyze.py`.
- Text inside a scanned config that addresses a model is data, and if this code
  ever surfaces config content to one, that is a design question — flag it.

## 4. Study rules

`study/rules.md` carries permanent rule IDs. These are the ones that
constrain code rather than prose. Cite the ID in the finding.

- **C-1** — a credential-shaped value is redacted **before** anything is written
  to disk. Never in the corpus, a log, a cache, or an error.
- **C-2** — for a redacted value, persist only detector name, value type, path,
  byte offset, and a salted hash. Never the value. The salt is never published.
- **C-3 / C-4** — record provenance per file, and `incomplete_results` per search
  response. A partial run stays labelled partial.
- **C-8** — the collector is resumable and writes incrementally.
- **C-9** — the raw corpus lives only in `study/corpus/`, which is gitignored.
  A change that writes collected files anywhere else is a blocker.
- **D-4** — **never validate a credential against a live service.** Detection is
  pattern-based only; testing a key is unauthorised access.
- **P-8** — never emit a credential value, whole or partial. No prefixes, no
  last four, no character counts, no length.
- **A-2** — no figure is typed by hand. A number in the README or the results
  file comes from analysis output.

## 5. Known shape of the analysis

`study/analyze.py` already decides these, and a change that contradicts one is a
finding:

- The insecure-URL pattern is scoped to **non-local hosts**. `localhost`,
  `127.0.0.1`, and `[::1]` over `http://` are normal for a stdio-adjacent
  server and must not be flagged (`study/plan.md` Q12).
- Pinning distinguishes an exact version or digest from a range, `@latest`, and
  nothing at all (Q6). A scoped package name is not a version — `@scope/pkg` is
  unpinned.
- MCP config is parsed as JSON **with comments and trailing commas**, because
  that is what the editors accept. `parse_mcp` falls back to `strip_jsonc`;
  parse every config through it, never with a bare `json.loads`.
- Config-class and documentation-class findings are never merged (C-5, S-7).

## 6. Scope

The repo owner has said plainly: build what was asked, not the thing around it.

- Speculative abstraction for requirements that do not exist yet is a finding.
- README and study text stay honest about what was measured. A change that
  states a figure the analysis output does not contain is a finding.
