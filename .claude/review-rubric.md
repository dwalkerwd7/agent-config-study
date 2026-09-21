# Review rubric — driftmark

Project rules for the `agent-reviewer` agent, layered on top of its generic
dimensions. Where this file and the generic rules disagree, this file wins.

CI runs `.claude/scripts/verify.sh`: prettier, type-aware eslint
(`recommendedTypeChecked`), `tsc`, vitest, semgrep and gitleaks, plus a
dependency audit and workflow lint. Do not report what those already fail on.
They check syntax and known patterns, not intent — the rules below are the part
only review catches.

The repo is a scaffold: roughly 530 lines of handwritten source, and whether the
product gets built at all is gated on the corpus study. Judge changes against
what was asked for, not against a finished product that does not exist.

## 1. TypeScript strictness

`tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noUnusedLocals`, `noUnusedParameters`,
`exactOptionalPropertyTypes`, and `verbatimModuleSyntax`. That shapes how the
existing code is written, and new code matches it:

- Environment access is bracketed — `process.env['DATABASE_URL']`, not dotted.
- Indexed access is guarded before use: `first?.offset ?? 0`.
- An optional property is spread conditionally rather than assigned `undefined`
  (see the pino `transport` block in `apps/api/src/logger.ts`).
- Relative imports carry a `.js` extension. The packages are NodeNext ESM and
  an extensionless import resolves at type-check but fails at runtime.
- Type-only imports use `import type`.

**`apps/web/tsconfig.json` does not extend the base.** It omits
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noUnusedLocals`,
`noUnusedParameters`, and `verbatimModuleSyntax`. Do not report base-strictness
violations under `apps/web` — the web app is deliberately held to a looser
standard, and flagging it there is a false positive.

## 2. Invariants that already cost a debugging session

Each of these was found the hard way. A change that reverses one is a blocker,
and the reason matters more than the rule:

- **The Prisma client stays lazy.** `packages/db/src/index.ts` exports a Proxy
  that connects on first property access. A module-level `new PrismaClient()`
  breaks `next build`, which evaluates route modules to collect page data with
  no `DATABASE_URL` set.
- **A BullMQ queue name cannot contain `:`.** BullMQ 6 throws at construction.
  Use `driftmark-<name>`.
- **`NODE_ENV` stays out of `.env.example`.** Setting it to `development` breaks
  `next build` — the build renders with a dev React build and crashes on the
  built-in error page. Its absence is deliberate; adding it back is a blocker.
- **`docker-compose.yml` keeps `name: driftmark`.** Compose otherwise names the
  project after the directory, and since this repo is laid out as worktrees that
  is the branch name — every worktree would get its own empty database.
- **The `overrides` in `pnpm-workspace.yaml` stay.** The Prisma CLI pulls in
  `@prisma/studio-core` with its own React and `@types/react`, which forks
  pnpm's peer hashes and produces several `@prisma/client` instances, so the
  generated client is not the one Next imports.

## 3. Tests

- **Tests live in `<workspace>/tests/`, never beside the source.** The Vitest
  glob in `vitest.config.ts` is `packages/*/tests/**/*.test.ts` and
  `apps/*/tests/**/*.test.ts`. A colocated test file is silently never run,
  which is worse than no test because it reads as covered. This is a blocker,
  not a convention nit.
- A new check or parser needs a test asserting the value returned, not that the
  call did not throw.
- `packages/core/tests/core.test.ts` is the pattern to follow.

## 4. Handling untrusted config

This is the product: driftmark reads agent-config files written by other people.
Code on that path is security-sensitive even though it looks like plumbing.

- **Never execute, spawn, resolve, or fetch anything a scanned config names.**
  A config naming `docker run` or an `npx` package is data to record, never a
  command to run. The same goes for a URL in an MCP server entry — do not fetch
  it to "check" it.
- **Never log raw config content or a value read out of one.**
  `apps/api/src/logger.ts` already sets this posture with its pino `redact`
  paths; new logging keeps it.
- A parse failure on hostile input is expected. It must not crash a worker or
  leak file content into an error message.
- Text inside a scanned config that addresses a model is data, and if driftmark
  ever surfaces config content to one, that is a design question — flag it.

## 5. Study rules, once scanning exists

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

## 6. Known shape of the checks

When the static checks get written, these details are already decided and a
change that contradicts one is a finding:

- The insecure-URL check is scoped to **non-local hosts**. `localhost`,
  `127.0.0.1`, and `[::1]` over `http://` are normal for a stdio-adjacent
  server and must not be flagged (`study/plan.md` Q12).
- Pinning distinguishes an exact version or digest from a range, `@latest`, and
  nothing at all (Q6). A scoped package name is not a version — `@scope/pkg` is
  unpinned.
- MCP config is parsed as JSON **with comments and trailing commas**, because
  that is what the editors accept. `packages/core/src/parse.ts` already does
  this; do not introduce `JSON.parse` on a config path.
- Config-class and documentation-class findings are never merged (C-5, S-7).
- Severity is meant to come from observed frequency once the study runs, not
  from intuition. A hardcoded severity table asserted as evidence-based, before
  there is evidence, is a finding.

## 7. Scope

The repo owner has said plainly: build what was asked, not the thing around it.
A change that installs a stack should not also write the application on top of
it.

- Speculative abstraction for requirements that do not exist yet is a finding.
- A new Prisma model, route, or queue that nothing uses is a finding — the
  schema deliberately holds only the Auth.js tables until the inventory models
  are designed.
- README and status text stay honest about what is not built. A change that
  describes unbuilt behaviour in the present tense is a finding.
