# Corpus Study — Plan

Pre-registered before collection. Governed by study/rules.md; rule IDs below refer to that file.

Anything added to this document after the first collection run is recorded in §10 and labeled exploratory wherever it appears (S-8).

Status: draft v1 · locked on: (date of first run) · owner: Derek Walker

## 1. Why this study exists

Two purposes, in priority order.

1. Decide whether to build driftwood. If committed agent configuration is rare, clean, or static, the product has no basis and the decision is no.
2. Produce test fixtures and an evidence-based severity rubric. Frequency data tells me which checks are worth writing.

A publishable write-up is a byproduct, not a goal. If the data is boring, the correct output is a short honest note and a decision not to build.

## 2. Decision criteria

Written down now so the result cannot be reinterpreted later.

| Signal                                        | Build                 | Don't build |
| --------------------------------------------- | --------------------- | ----------- |
| Config-class files collected                  | ≥ 1,000               | < 300       |
| Median servers per config                     | ≥ 2                   | 1           |
| Unpinned reference rate                       | ≥ 40%                 | < 15%       |
| Configs with a credential-shaped value in env | ≥ 3%                  | < 1%        |
| Repos with 2+ client configs that disagree    | ≥ 20% of that subset  | < 5%        |
| Median config age vs repo age                 | config notably staler | tracks repo |

Mixed results are the likely outcome. The rule: the first row is a gate, and at least three of the remaining five must land on the build side. Anything else means park it and write up what I found.

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

Documentation-class: fenced JSON blocks in README.md containing mcpServers or servers. Collected, classified separately, never merged (C-5, S-7).

### Query strategy

Code search is capped at 10 requests/minute, 256-character queries, five boolean operators, and up to 4,000 repositories reached per query. One query therefore returns a relevance-ranked slice, never the population.

Slices, run independently and unioned:

- by `path:` — one query per target path
- by `stars:` bands — 0..1, 2..10, 11..100, 101..1000, >1000
- by `size:` bands, to break relevance ranking
- by `pushed:` quarter, for 2025–2026

The stars bands are deliberate: comparing popular repos against the long tail is itself one of the questions (Q9).

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

## 8. What would falsify the premise

Stated plainly so I can't dodge it:

- Config files are overwhelmingly documentation-class, meaning almost nobody commits real config. The org-wide inventory has nothing to inventory.
- Pinning rates are already high, meaning the ecosystem solved this without tooling.
- Servers per config is ~1 and it's the same handful of first-party servers everywhere. No sprawl, no inventory problem.
- Config files are as fresh as the repos, meaning they're actively maintained and drift is not going unnoticed.

Any two of these and the answer is no.

## 9. Stop conditions

- Collection stops at 5,000 config-class files or 14 days from the first run, whichever comes first.
- Analysis stops when Q1–Q14 are answered. New questions go to §10, not into this run.
- Total budget: 3 weeks wall-clock. At the deadline I write up whatever exists.

Deliverables at stop: answers to Q1–Q14, a decision recorded against §2, a sanitized fixture set for the parser (A-5, P-4), and a draft write-up.

## 10. Post-hoc additions

Anything here was added after seeing data and is labeled exploratory in every artifact it appears in (S-8).

(none yet)
