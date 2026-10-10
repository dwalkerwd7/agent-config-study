# agent-config-study

A pre-registered study of AI coding-agent configuration committed to public GitHub
repositories: MCP server configs, Claude Code settings and skills, Cursor rules, and
instruction files such as `CLAUDE.md`, `AGENTS.md` and `.github/copilot-instructions.md`.

The study asks how these files are written and maintained:

- How many MCP servers a config holds, and over which transports.
- Whether package references are pinned to a version.
- Whether configs carry credential-shaped values.
- Whether one repository's configs for different clients agree.
- How stale configs are compared with the rest of the repository.

The questions, the collection method and the headline measures were fixed before any data
was collected, so the results could not be reinterpreted afterwards.

## Findings

Two independent collection runs, both on 2026-10-10. The second run left out every repository
the first one collected. Both stopped on the planned 5,000-file cap, so both are recorded as
partial runs. Every figure describes the collected corpus only, not GitHub as a whole, and
comes from the analysis output in [study/output/](study/output/). Percentages are over
deduplicated files (one per content hash).

|                                                                         | Run 1         | Run 2         |
| ----------------------------------------------------------------------- | ------------- | ------------- |
| Repositories                                                            | 1,147         | 1,038         |
| Config files, deduplicated (raw)                                        | 4,152 (5,000) | 4,112 (4,993) |
| MCP configs, deduplicated                                               | 888           | 849           |
| Median servers per MCP config                                           | 1             | 1             |
| Package references not pinned to an exact version                       | 91.9% of 518  | 85.6% of 500  |
| MCP configs with a credential-shaped value in `env` or `headers`        | 3.9% of 888   | 2.4% of 849   |
| Multi-client repositories whose configs name different servers          | 16.3% of 252  | 14.0% of 285  |
| MCP configs: median days behind the repository's last push              | 22.3          | 20.5          |
| MCP configs: share more than 90 days behind                             | 29.0%         | 26.0%         |
| MCP configs containing Laravel's installer-written server (exploratory) | 35.4%         | 36.3%         |

The clearest result is pinning. In both runs most package references run whatever version
the registry serves at launch: a bare `npx -y package`, or an explicit `@latest`. Other
signals were weaker or less stable between runs. Many MCP configs hold a single server, and a
large share of those were written by one framework's installer rather than by hand.

Credential-shaped values were redacted when the files were collected. They appear only as
counts by detector type, and none was tested against a live service. No repository or owner
is named anywhere in the published output.

The full write-up is in [study/results.md](study/results.md), including:

- the method and its known biases
- the per-question answers
- a calibration check against priors recorded in advance
- competing explanations for each signal

## Method in brief

1. **Discovery.** GitHub code search across ten config file paths, each split into four file
   size bands, with forks excluded.
2. **Sampling.** A seeded draw balanced across the ten paths and the size bands, so the cap
   isn't spent on whichever path was searched first.
3. **Collection.** Each drawn repository's default-branch tree is read, and every matching
   file is fetched. Credential-shaped values are redacted before anything is written to disk.
4. **Analysis.** A standard-library Python script parses the configs and writes one findings
   file per run.

Because the sample is balanced by design, file counts per path reflect the sampling quota,
not how common each file type is.

## Repository layout

| Path                                 | Contents                                                    |
| ------------------------------------ | ----------------------------------------------------------- |
| [study/plan.md](study/plan.md)       | The pre-registered plan: questions Q1–Q14, criteria, priors |
| [study/rules.md](study/rules.md)     | Rules for collection, redaction, analysis and publication   |
| [study/results.md](study/results.md) | The write-up                                                |
| [study/runs.md](study/runs.md)       | What changed from one collection run to the next            |
| [study/output/](study/output/)       | Generated findings, one file per run                        |
| [study/analyze.py](study/analyze.py) | The analysis script                                         |
| [apps/collector/](apps/collector/)   | The collector (TypeScript)                                  |
| `study/corpus/`                      | Raw collected files. Gitignored and never published         |

The other directories under `apps/` and `packages/` are an unused application scaffold and
play no part in the study.

## Reproducing

Requires Node 22+, pnpm 11+ and Python 3.11+.

```bash
git clone git@github.com:dwalkerwd7/agent-config-study.git
cd agent-config-study
pnpm install
```

The collector needs two environment variables:

- `GITHUB_TOKEN`: a GitHub token with read access to public repositories.
- `CORPUS_SALT`: a secret of your own. The collector fingerprints each redacted value with
  it (HMAC-SHA256), so repeated values can be matched without being stored.

`pnpm collect` runs the collector under the 1Password CLI, with `.env` holding `op://`
references. Without 1Password, set the two variables in your shell and run the collector
directly:

```bash
pnpm -C apps/collector collect --run run1
pnpm -C apps/collector collect --run run2 --exclude-from run1   # disjoint from run1
python3 -I study/analyze.py --run run1      # writes study/output/findings-run1.md
```

A new collection will not reproduce these figures exactly. Search results and repositories
change over time, and the sampling seed is stored only in the corpus, which is never
published.

## License

MIT. See [LICENSE](LICENSE).
