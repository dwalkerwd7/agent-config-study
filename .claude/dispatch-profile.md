# Dispatch profile — driftwood

Read by the machine-global `dispatcher` agent. It carries the conventions
specific to this repo, so they hold no matter who writes the dispatcher's
prompt, and nothing important lives only in one session's memory.

## Merging is not authorized

**Never run `gh pr merge` in any form, and never arm auto-merge.** Tell every
builder the same. The owner reviews and merges every agent-built PR. This holds
even though the repo has auto-merge enabled and `main` requires the `verify` and
`security` checks. Those settings are for PRs the owner chooses to auto-merge,
and grant nothing to an agent.

An `open` PR waiting for review is a finished build. Record its verdict and
continue with the next eligible issue. When the picker reports the queue empty
(exit 3) because the remaining issues are `Blocked by` an unmerged PR, stop and
report which PRs are waiting on the owner. Do not wait for merges.

## Escalation

The builder's default: comment on the issue, add `needs-human`, remove
`agent-build`. On an escalation, **stop draining** and report the reason
verbatim. Queues here are dependency-ordered with `Blocked by #N`, so the next
item may rest on the one that failed.

## Verify gate

`bash .claude/scripts/verify.sh`. CI runs the same script, so a green local run
is a green `verify` check.

It derives its gates from the diff against `origin/main` **including uncommitted
and untracked files**, so it is correct before a commit. A docs-only change
(`*.md`, `study/`, `.claude/`) runs prettier and gitleaks only; anything else
also runs eslint (type-aware), `tsc`, vitest and semgrep.

## Narrow inner loop (tell every builder this)

The full gate takes about a minute. That's cheap, but semgrep dominates it, so
iterate with:

```bash
pnpm --filter @driftwood/<pkg> typecheck
pnpm exec vitest run apps/<pkg>/tests/<file>.test.ts
pnpm exec eslint apps/<pkg>
pnpm exec prettier --write <files>
```

and run `verify.sh` before review, once per review round, and at PR time.

## Traps to front-load into every builder prompt

- **New dependencies must be at least 7 days old.** `pnpm-workspace.yaml` sets
  `minimumReleaseAge: 10080`, `trustPolicy: no-downgrade` and
  `blockExoticSubdeps`. If an install fails on these, pick an older version in
  the same major. **Never add an entry to `minimumReleaseAgeExclude`,
  `trustPolicyExclude` or `overrides` to get past a failure.** Escalate instead;
  each existing exclusion carries a written reason the owner accepted.
- **Fake credentials in tests.** gitleaks scans every change. A fixture that
  must look like a credential needs a `.gitleaksignore` entry with a comment.
  Never weaken the scan config.
- **Tests go in `apps/<pkg>/tests/` or `packages/<pkg>/tests/`,** never next to
  the source. `vitest.config.ts` only collects `*/tests/**/*.test.ts`. A test
  anywhere else never runs, so it passes CI.
- **The Prisma client is generated and gitignored.** `worktree-setup.sh` runs
  `pnpm db:generate`. A package that imports `@driftwood/db` fails to typecheck
  without it.
- **Pending rename.** The project is being renamed to `driftmark` (draft PR
  #13, held until the collector queue drains). Keep using `@driftwood/*` names
  until that merges. Do not rename anything in a build.

## Collector builds (`apps/collector`)

**No live runs.** Never run `pnpm collect` in any form, `--dry-run` included,
and make no GitHub API calls from code or tests. The first real run locks the
study plan, so the owner does it by hand. Each collector issue repeats this in
its ground rules.

## Worktrees

Created only by `dispatch-prepare.sh`, which calls
`.claude/scripts/worktree-add.sh`. Worktrees live beside `main/` in the
bare-repo container. **Never run `worktree-prune.sh` during a drain.**
