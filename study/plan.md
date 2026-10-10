# Corpus Study — Plan

Pre-registered before collection. Governed by study/rules.md; rule IDs below refer to that file.

Anything added to this document after the first collection run is recorded in §10 and labeled exploratory wherever it appears (S-8).

Status: v1 · locked on: 2026-10-10 (first run) · owner: Derek Walker

Revised after both runs to describe the study on its own terms. The questions, population,
collection method, measures and priors are unchanged from the locked version.

## 1. Why this study exists

To measure how AI coding-agent configuration committed to public repositories is written and maintained: how much there is, what it references, whether it is pinned, whether it carries credentials, whether a repository's configs for different clients agree, and how stale it gets. Frequency data from real repositories says more about these files than intuition about what seems alarming.

If the data is boring, the correct output is a short honest note.

## 2. Headline measures

Fixed before collection, so the measures that lead the write-up could not be chosen after seeing the data.

| Measure                                       | Question |
| --------------------------------------------- | -------- |
| Config-class files collected                  | Q1       |
| Median servers per config                     | Q2       |
| Unpinned reference rate                       | Q6       |
| Configs with a credential-shaped value in env | Q8       |
| Repos with 2+ client configs that disagree    | Q10      |
| Config age vs repo age                        | Q11      |

## 3. Priors

Recorded so I can score my own calibration afterward, and so a result that merely matches my expectations isn't mistaken for a discovery.

- Config-class files findable: ~2,000
- Documentation-class blocks will outnumber config-class by 3–5×
- Median servers per config: 3
- Unpinned rate: 70%
- Credential-shaped values in env: 5%
- Most common servers: a docs fetcher, a browser automation server, a filesystem server
- Multi-client divergence: 40% of the multi-client subset

## 4. Population and unit of analysis

- Population: public, non-fork GitHub repositories containing at least one agent-config file at a known path.
- Unit: one config file, at one commit, at one path.
- Secondary unit: one repository, for cross-file questions (divergence, staleness).
- Owner-level rollup retained for deduplication (C-7).

Not in scope: private repositories (P-14), user-scope config outside repos, gists, non-GitHub forges.

## 5. Collection method

### Target paths

Config-class:

- `.mcp.json`
- `.cursor/mcp.json`
- `.vscode/mcp.json`
- `.junie/mcp/mcp.json`
- `.claude/settings.json`
- `.claude/skills/**/SKILL.md`
- `.cursor/rules/**`
- `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`

Documentation-class: fenced JSON blocks in README.md containing mcpServers or servers. Classified separately and never merged with config-class (C-5, S-7). The collector as built does not collect them; it searches and collects the config-class paths above only (see Query strategy).

### Query strategy

This section describes the collector as built in `apps/collector`. It was rewritten after the collector was written and before any collection run; that is allowed without a §10 entry only because the plan is not locked until the first run, and any change after that goes to §10.

Collection runs in two phases, discovery and expansion.

**Discovery: code search sliced by target path × file-size band** (`apps/collector/src/queries.ts`). Each target path gets one search term plus `path:`/`filename:` qualifiers, and every target is crossed with every size band, one query per pair. The size bands, as defined in `SIZE_BANDS`, are `size:<1000`, `size:1000..4999`, `size:5000..19999` and `size:>=20000`; they exist to break relevance ranking into slices small enough to stay under the result cap, and the owner may revise them before the first run. `fork:` is left at its default, which excludes forks (C-6). A query that breaks code search's limits — 256 characters, five boolean operators — fails when the slices are built, before any request. Each slice is paged until it runs out or hits the cap (`apps/collector/src/collect.ts`), code search is paced to 10 requests a minute (`apps/collector/src/github.ts`), and every response is recorded with its slice, query and `incomplete_results` (C-3, C-4). Search hits from forks and private repositories are dropped; every other hit queues its repository.

**Expansion order: a stratified, seeded draw** (`apps/collector/src/sampling.ts`). Queued repositories are not expanded in the order search found them; first come, first served would spend the file cap (§9) on the targets searched first and leave the rest under-sampled. Each slice is a stratum (target path × size band). Its pool is the repositories its recorded search pages queued, and its weight is the `total_count` its first page reported. Before each draw, the target with the fewest files collected so far, among targets whose strata still have undrawn repositories, gets the draw, ties going to the earlier target in the list above. The 5,000 files therefore split roughly evenly across the ten targets, about 500 each, and a target whose pools run out passes its unused share to the others; nothing sets a per-target number. Within that target, the draw goes to the band with the fewest draws relative to its weight, so draws follow `total_count` across bands: a target whose small-file band holds 95% of its hits gets about 95% of its draws from that band. Within a band, repositories are taken in order of `sha256(seed:repository)`, which is random but reproducible. A repository found by several slices is drawn once, for whichever stratum reaches it first, and is recorded with that slice as `drawn_slice` alongside every slice that found it. Files are counted toward their own target, whichever stratum drew their repository. The seed is 32 random bytes, written to `sampling.jsonl` by the first run that reaches expansion, before anything is expanded, and reused by every later run. It is not the redaction salt (C-2) and is not derived from it. Every run replays the draw from the start, taking the file counts of repositories already completed from the corpus without fetching them again, so a resumed run follows the same sequence as an uninterrupted one (C-8). The one exception: a repository that failed with an API error is retried at its position, and if it succeeds on the retry, the sequence from there on can differ from the one the failing run would have followed.

**Expansion: one tree call per repository** (`apps/collector/src/collect.ts`). Each drawn repository gets one metadata call, one call for its default-branch head commit, and exactly one recursive tree call at that commit; each target file in the tree then gets its own blob fetch and last-commit lookup. Every target path in that tree is collected, whether or not a search hit named it, so search decides which repositories are reached and the tree decides which files are collected. Each file records the slices that surfaced it, and whether it came from a search hit or only from the tree.

**Stars and recency are not search qualifiers.** No query carries `stars:` or `pushed:`. The collector records each repository's star count and `pushed_at` from its repository metadata during expansion, and the stars bands (0..1, 2..10, 11..100, 101..1000, >1000) and `pushed_at` bands (by quarter, 2025–2026) are assigned afterwards, at analysis, from those recorded fields. The stars bands are deliberate: comparing popular repos against the long tail is itself one of the questions (Q9). Because the bands are not sliced at search time, the corpus's mix across them follows whatever search surfaced rather than a quota per band.

Discovery covers the config-class target paths only. No slice searches README files, so documentation-class blocks are not collected by this collector.

Known biases, stated with every statistic derived from the corpus (S-3):

- **The result cap.** Code search returns at most 1,000 results per query, and most slices are larger than that. The cap does not limit how many files can be collected: four bands of up to 1,000 reachable results per target is far more than a target's share of about 500. It limits which files can be: within a band only the top 1,000 by relevance are reachable, and what lies past the cap is never seen, so the random draw within a band is random over that reachable set, not over the band. The band weights still come from the full `total_count`. A slice whose `total_count` exceeds what was paged is visible in the recorded responses.
- **Tree files are not stratified by their own band.** A file collected because its repository's tree holds it, rather than because a search hit named it, counts toward its own target but was drawn through another stratum, so its size band plays no part in how it was sampled.
- **The search-term requirement.** Code search needs at least one search term, and without `in:` it matches that term against file content. Each target's term is the most neutral word its format always contains (`SEARCH_TERMS` in `queries.ts`), but a file without that word is not found by search. It is still collected if another hit reaches its repository, because expansion reads the whole tree.
- **Default-branch-only indexing.** Code search indexes only default branches, and expansion reads only the default-branch head. Config on any other branch is invisible to both phases.
- **Truncated trees.** A very large repository's recursive tree can come back truncated; the collector records `tree_truncated` for the repository, and target files beyond the cut are missed.

### Collector requirements

- Resumable, incremental writes (C-8)
- Records provenance per file (C-3)
- Records incomplete_results per response (C-4)
- Redacts credential-shaped values before writing (C-1, C-2)
- Logs the query that surfaced each file, for bias analysis

## 6. Questions and metrics (locked)

Confirmatory. Each is answerable from the collected fields alone.

### Prevalence and shape

- **Q1** How many config-class files, by path type, deduplicated and raw?
- **Q2** Distribution of servers per config: median, IQR, max.
- **Q3** Transport mix: stdio vs http vs sse vs socket/pipe.
- **Q4** Client mix: Claude Code vs Cursor vs VS Code vs Junie, by file count and by repo count.

### Supply-chain hygiene

- **Q5** Reference targets by type: npm, uvx/PyPI, docker, local path, remote URL.
- **Q6** Pinning: share of references pinned to an exact version or digest, versus a range, @latest, or nothing.
- **Q7** Top 50 distinct servers by frequency (publishable under P-3).
- **Q8** Share of configs with at least one credential-shaped literal in env or headers, by detector type only (P-8).

### Governance signals

- **Q9** Do pinning and credential rates differ across stars bands?
- **Q10** Among repos with 2+ client configs, how often do the server sets differ?
- **Q11** Staleness: days between last commit to the config file and last commit to the repo.
- **Q12** Risky invocation patterns: docker with -v mounting $HOME or /, --privileged, --network host; http:// URLs to non-local hosts.

### Skills and instruction files

- **Q13** How many repos ship skills or rules files, and how many files each?
- **Q14** Size distribution of instruction files (a proxy for how much unreviewed text an agent ingests).

## 7. Analysis plan

- Deduplicated figures are headline; raw shown alongside, labeled (S-4).
- All proportions reported with N in the same row or axis (S-2).
- No population-level extrapolation (S-1).
- Cross-band comparisons (Q9) are descriptive only. No significance testing; the sample is not random and a p-value would imply a rigor the sampling does not support.
- Partial runs excluded from headline figures or labeled partial (P-15).
- Every published number emitted by the analysis script, never transcribed (A-2).

## 8. Null outcomes

Results that would mean committed agent config is simple and well kept, stated in advance so they are reported if they appear:

- Config files are overwhelmingly documentation-class, meaning almost nobody commits real config.
- Pinning rates are already high.
- Servers per config is ~1 and it's the same handful of first-party servers everywhere.
- Config files are as fresh as the repos, meaning they're actively maintained.

## 9. Stop conditions

- Collection stops at 5,000 config-class files or 14 days from the first run, whichever comes first. The 5,000 are balanced across the target paths as described in §5 (Expansion order): roughly equal shares, with a target that runs out of repositories passing its share on to the others.
- Analysis stops when Q1–Q14 are answered. New questions go to §10, not into this run.
- Total budget: 3 weeks wall-clock. At the deadline I write up whatever exists.

Deliverables at stop: answers to Q1–Q14, the headline measures in §2, a check of the priors in §3, and a write-up.

## 10. Post-hoc additions

Anything here was added after seeing data and is labeled exploratory in every artifact it appears in (S-8).

### 10.1 Staleness summary (added 2026-10-10)

**Why.** The §2 measure "Config age vs repo age" names no summary statistic, so the write-up needs one fixed before it is read against a second run.

**Measure.** For each deduplicated MCP config (C-7) with a known last commit, the lag in days between the last commit touching the file and the repository's `pushed_at` at collection, floored at 0. Reported as the median lag and the share of configs lagging more than 90 days. The paired lag is the measure. The difference between the median config age and the median repository age is not: those are two separate distributions, not a comparison within each repository.

**Known limits** (S-9). Lag cannot tell a stale config from a finished one that needs no edits. `pushed_at` counts pushes to any branch, so a repository can look fresher than its default branch is, which lengthens the measured lag. Configs written by an installer (see §10.2) may change only when the tool is re-run.

### 10.2 Installer-generated MCP configs (added 2026-10-10)

**Why.** In the first run, `php` dominated the local-path entries in Q5. Most turned out to be `artisan boost:mcp`, which the Laravel Boost package writes into each detected client's MCP config (alongside Herd's `herd-mcp.phar` where Herd is present). Configs written by an installer are a competing explanation for Q2's median and for the agreement measured by Q10 (S-9).

**Measure.** The share of deduplicated MCP server entries and configs whose command runs `artisan boost:mcp` or `herd-mcp.phar`, with the share broken down by target, plus servers per config with those configs excluded. Exploratory in every artifact (S-8). It is reported alongside the §2 measures, not in place of them.
