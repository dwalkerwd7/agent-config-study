Corpus Study — Results

Findings from the study pre-registered in study/plan.md, governed by study/rules.md.
Question IDs (Q1–Q14) and rule IDs refer to those files.

Status: complete · two runs, both collected 2026-10-10 · both partial · owner: Derek Walker

Sections 1–6 cover the first run, and §7 compares it with the second. Every figure is
copied from `study/output/findings-run1.md` or `findings-run2.md`, which
`study/analyze.py` emits from the raw corpus, and none is typed from memory (A-2). Those
files carry the full tables. The collector recorded both runs as partial (C-8), so every
figure in this file is a partial-run figure (P-15). Each one describes this corpus only,
not GitHub or the ecosystem (S-1).

## 1. Run record

| Field                                                 | Value                                            |
| ----------------------------------------------------- | ------------------------------------------------ |
| Collection window                                     | 2026-10-10 01:20 to 03:51 UTC                    |
| Analysis date                                         | 2026-10-10                                       |
| Complete or partial (C-8)                             | partial (stopped on the 5,000-file cap, plan §9) |
| Responses with incomplete_results (C-4)               | 0 of 310                                         |
| Config-class files, deduplicated (S-4)                | 4,152                                            |
| Config-class files, raw                               | 5,000                                            |
| Documentation-class blocks, reported separately (S-7) | not collected in v1 (plan §5)                    |
| Repositories                                          | 1,147                                            |
| Distinct owners after dedup (C-7)                     | 1,098                                            |

## 2. Method and known bias

Required in the same artifact as any statistic drawn from it (S-3).

- **Discovery.** GitHub code search, one query per target path × size band (40 slices),
  forks excluded, each slice paged until exhausted or the 1,000-result cap. Search
  returns a relevance-ranked slice, not the population: what lies past the cap is never
  seen.
- **Expansion.** A seeded, stratified draw (plan §5, Expansion order): each draw went to
  the target with the fewest files so far, then to the size band least drawn relative to
  its search total, then to a hash-ordered repository in that band. Expansion reads the
  whole default-branch tree, so a repository drawn for one target contributes every
  target file it holds.
- **Balance is by design.** The draw equalizes targets, so file counts per target and
  the client mix (Q1, Q4) reflect the quota, not how common each file type is. Skills and
  Cursor rules come many to a repository and end above their share.
- **Search-term requirement.** Each query needs a content term, so a file lacking it is
  found only through another hit in its repository.
- **Default branch only.** Truncated trees can miss files (2 repositories). Stars and
  push dates are as of collection.
- **Deduplication (C-7).** One file per normalized content hash, keeping the first
  collected. Raw figures are shown alongside and labeled.
- **Credential detection** is pattern-based, and nothing was validated against a live
  service (D-4).
- **No significance testing** (plan §7).

## 3. Answers

Each answer states N (S-2), is scoped to this corpus (S-1), and comes from a partial run
collected 2026-10-10 (P-15). Deduplicated figures are the headline, with raw shown
alongside and labeled (S-4).

### Prevalence and shape

- **Q1** Of 5,000 config-class files (4,152 deduplicated) from 1,147 repositories, each
  target got roughly an equal share by design: the four MCP paths, settings and
  `copilot-instructions.md` 282–283 raw each, `CLAUDE.md` 456, `AGENTS.md` 377,
  `.cursor/rules/**` 629 and `SKILL.md` 1,842. Deduplication bites hardest on `.mcp.json`
  (143 of 283 distinct).
- **Q2** Of 888 parseable, deduplicated MCP configs, servers per config: median 1, IQR
  1–2, max 37. 589 (66.3%) hold one server, and 293 (33.0%) hold two or more.
- **Q3** Of 1,560 server entries in deduplicated configs: stdio 1,244 (79.7%), http 214
  (13.7%), a URL with no stated type 82 (5.3%), sse 13 (0.8%).
- **Q4** Set by the balanced draw, so not a popularity figure. Of 5,000 raw files,
  Claude Code accounts for 2,863 (in 597 repositories), Cursor 912, `AGENTS.md` 377,
  VS Code 283, Junie 283 and Copilot 282.

### Supply-chain hygiene

- **Q5** Of 1,560 deduplicated server entries: local path 631 (40.4%), npm 453 (29.0%),
  remote URL 245 (15.7%), local-host URL 66 (4.2%), uvx/PyPI 42 (2.7%), docker 27 (1.7%).
- **Q6** Of 518 deduplicated package references, 42 (8.1%) are pinned to an exact version
  or digest, 3 (0.6%) use a range, 178 (34.4%) use `@latest` or another tag, and 295
  (56.9%) name no version: 91.9% unpinned (raw: 514 of 556, 92.4%).
- **Q7** Across 888 deduplicated MCP configs, the most-referenced servers by distinct
  owners are `@playwright/mcp` (38), `@upstash/context7-mcp` (34),
  `api.githubcopilot.com` (27), `mcp.supabase.com` (21) and `mcp.context7.com` (20). Of
  275 distinct server identities, 205 appear under a single owner only. The top 50 are in
  the output file.
- **Q8** Of 888 deduplicated MCP configs, 35 (3.9%) carry at least one credential-shaped
  literal in `env` or `headers` (raw: 36 of 1,127, 3.2%). By detector, the configs break
  down as keyed-literal 28, openai 6, jwt 3 and google 1. Across all 5,000 files, 154
  values were redacted in 62 files.

### Governance signals

- **Q9** Descriptive only. By stars band, the unpinned rate is 92.9% at 0 stars (N = 338
  references), 87.3% at 1–9 (N = 126), 100.0% at 10–99 (N = 43) and 81.8% at 100–999
  (N = 11). The credential rate falls from 4.7% at 0 stars (N = 596 configs) to 0.0% at
  100–999 (N = 24). The upper bands are too small to read much into.
- **Q10** Of 252 repositories with parseable MCP configs for two or more clients, server
  names differ in 41 (16.3%) and server identities differ in 40 (15.9%).
- **Q11** Of 893 deduplicated MCP configs, the median lag between the config's last
  commit and the repository's last push is 22.3 days (IQR 1.0–104.6), and 29.0% lag
  more than 90 days. `CLAUDE.md` (9.0 days, N = 339) and `AGENTS.md` (9.9 days,
  N = 351) track their repositories more closely.
- **Q12** Of 1,560 deduplicated server entries: no docker mounts of `$HOME` or `/`, no
  `--privileged`, 1 `--network host` (of 27 docker entries), and 4 plaintext `http://`
  URLs to non-local hosts (of 245 non-local remote URLs).

### Skills and instruction files

- **Q13** Of 1,147 repositories, 219 ship `SKILL.md` files (1,842 raw; median 5 per
  repository, IQR 2–7.5, max 132) and 157 ship Cursor rules (629 raw; median 1, IQR
  1–5, max 45). How many repositories ship them is set by the draw. Files per repository
  is the meaningful figure.
- **Q14** Median size in bytes, deduplicated: `AGENTS.md` 9,543 (N = 351), `CLAUDE.md`
  7,565 (N = 339), `SKILL.md` 5,441 (N = 1,451), `copilot-instructions.md` 4,583
  (N = 275), Cursor rules 2,652 (N = 569). Per repository, the total across all
  instruction, skill and rules files has a median of 15,300.5 bytes and a max of 1,262,257
  (N = 818 repositories).

## 4. Null outcomes

The four outcomes from study/plan.md §8 that would mean committed agent config is simple
and well kept.

| Outcome                                         | Holds?                                                                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Config is overwhelmingly documentation-class    | not measured: v1 collects no documentation-class blocks                                                               |
| Pinning rates are already high                  | no: 8.1% exact of 518 references                                                                                      |
| Servers per config ≈ 1, same handful everywhere | half: median 1 (N = 888), but 205 of 275 server identities appear under one owner only, so it is not the same handful |
| Config is as fresh as the repos                 | partly: median lag 22.3 days, but 29.0% of configs lag more than 90 days (N = 893)                                    |

None clearly holds in the first run.

## 5. Calibration

Priors were recorded in study/plan.md §3 before collection, so a result that merely
matches expectation is not mistaken for a discovery.

| Prior                           | Predicted | Observed                                                              |
| ------------------------------- | --------- | --------------------------------------------------------------------- |
| Config-class files findable     | ~2,000    | 4,152 deduplicated collected before the 5,000 cap; far more by search |
| Documentation vs config ratio   | 3–5×      | not measured                                                          |
| Median servers per config       | 3         | 1                                                                     |
| Unpinned rate                   | 70%       | 91.9%                                                                 |
| Credential-shaped values in env | 5%        | 3.9%                                                                  |
| Multi-client divergence         | 40%       | 16.3%                                                                 |

The prior overestimated sprawl and divergence and underestimated unpinning. The most
common servers were not the predicted set: browser automation (Playwright) appears, but
the leaders are docs fetchers and hosted services (Context7, GitHub, Supabase), not a
filesystem server.

## 6. Competing explanations

- **Installer-generated configs (exploratory, S-8).** In 314 of 888 deduplicated MCP
  configs (35.4%), Laravel tooling (`artisan boost:mcp` or Herd) wrote the server entry,
  not a person, and it is the only server in 212 of them. These configs account for 250
  of 270 Junie configs. This plausibly pulls the Q2 median down and makes the Junie
  configs uniform. It may also lower Q10 divergence, since one installer writing the same
  server into several clients' configs makes them agree by construction. Even with these
  configs excluded, the median is still 1 server (N = 574).
- **Keyed-literal hits may be dummies.** 28 of the 35 Q8 configs are flagged only by the
  `keyed-literal` detector, which matches any literal assigned to a secret-named key.
  Some are likely placeholders, so 3.9% is an upper bound on real credentials.
- **Lag is not staleness.** A config that needs no edits shows a long lag without being
  stale, and `pushed_at` counts pushes to any branch.
- **The balanced draw shapes prevalence.** Q1, Q4 and Q13 repository counts reflect the
  quota, not how common each file type is.
- **Unpinned by convention.** `npx -y package` is the form most MCP server READMEs tell
  users to paste, so the 91.9% may reflect copied instructions rather than a choice made
  in each repository. That is still exposure, but it suggests the fix sits with
  documentation as much as with each repository.

## 8. Exploratory additions

Anything computed after looking at the data, labeled exploratory wherever it appears (S-8).
Post-hoc questions are recorded in study/plan.md §10 first.

- **Installer-generated MCP configs** (plan §10.2): the Laravel breakdown in §6.
- **Staleness summary** (plan §10.1): the median lag and the share of MCP configs lagging
  more than 90 days, fixed before the second run was read.

## 7. Second run

Prior figures are kept with their collection date rather than silently overwritten (A-4).

Run 2 (collected 2026-10-10) is a partial run (the 5,000-file cap) and is disjoint from
run 1: the draw left out run 1's 1,147 repositories. Its figures are copied from
`study/output/findings-run2.md`, and what changed between the runs is in
`study/runs.md`.

| Measure (plan §2)                                          | Run 1                      | Run 2                      |
| ---------------------------------------------------------- | -------------------------- | -------------------------- |
| Config-class files, deduplicated (raw)                     | 4,152 (5,000)              | 4,112 (4,993)              |
| Median servers per MCP config                              | 1 (N = 888)                | 1 (N = 849)                |
| Unpinned package references                                | 91.9% (N = 518)            | 85.6% (N = 500)            |
| MCP configs with a credential-shaped `env`/`headers` value | 3.9% (N = 888)             | 2.4% (N = 849)             |
| Multi-client repos whose server names differ               | 16.3% (N = 252)            | 14.0% (N = 285)            |
| MCP config lag: median, share > 90 days                    | 22.3 days, 29.0% (N = 893) | 20.5 days, 26.0% (N = 851) |
| MCP configs with Laravel tooling (exploratory)             | 35.4% (N = 888)            | 36.3% (N = 849)            |

What held: most package references are unpinned in both runs, the median config holds one
server, and about a third of MCP configs carry the same installer-written server. What
moved: the credential rate fell from 3.9% to 2.4%. Most of those hits come from the
`keyed-literal` detector (18 of 20 configs in run 2), so the rate is sensitive to a small
number of configs and to placeholders. Divergence and the share of stale configs each fell
by 2–3 points.
