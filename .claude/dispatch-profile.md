# Dispatch profile — agent-config-study

Read by the machine-global `dispatcher` agent. It carries the conventions
specific to this repo, so they hold no matter who writes the dispatcher's
prompt, and nothing important lives only in one session's memory.

## Merging: authorized per issue, by the `agent-merge` label

**Merging is authorized only for an issue carrying the `agent-merge` label.**
The owner applies it to low-risk issues. Everything else waits for the owner's
review. The repo's auto-merge setting and required checks grant nothing on
their own.

- **Agents never add or remove `agent-merge`**, on any issue. Builders never
  merge; the dispatcher does it after verifying.
- **Check the label right before arming,** on the issue, not at dispatch time,
  because the owner may remove it while the build runs:
  ```bash
  gh api "repos/$repo/issues/<n>/labels" --jq '.[].name' | grep -qx agent-merge
  ```
- **When it is present:** after `dispatch-verify.sh` reports `open`, run
  `gh pr merge <pr> --repo "$repo" --auto --squash`, then
  `gh pr checks <pr> --repo "$repo" --watch`, and re-verify. `landed` → next
  issue. A failed check → do not fix it; report and stop. Never
  `--delete-branch`; the repo deletes merged branches itself.
- **When it is absent:** never run `gh pr merge` in any form. The `open` PR is
  a finished build. Record its verdict and continue with the next eligible
  issue.

When the picker reports the queue empty (exit 3) because the remaining issues
are `Blocked by` an unmerged PR, stop and report which PRs are waiting on the
owner. Do not wait for a merge that isn't yours to make.

## Narrow inner loop (tell every builder this)

The full gate takes about a minute. That's cheap, but semgrep dominates it, so
iterate with:

```bash
pnpm --filter @agent-config-study/<pkg> typecheck
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
- **Tests go in `apps/<pkg>/tests/`,** never next to the source. `vitest.config.ts` only collects `*/tests/**/*.test.ts`. A test
  anywhere else never runs, so it passes CI.

## Collector builds (`apps/collector`)

**No live runs.** Never run `pnpm collect` in any form, `--dry-run` included,
and make no GitHub API calls from code or tests. The first real run locks the
study plan, so the owner does it by hand. Each collector issue repeats this in
its ground rules.
