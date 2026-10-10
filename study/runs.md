Corpus Study — Run Log

What changed from one collection run to the next: the collector, its configuration, the
analysis, and the plan. A figure from one run is only comparable with another run's
figure when nothing listed here between them affects it. Rule IDs refer to
study/rules.md and section numbers to study/plan.md.

Each run gets one entry, newest first. Each entry records what that run used and what
changed since the run before it. Figures live in `study/output/` and `study/results.md`,
not here. A prior run's figures are kept with their collection date and never overwritten
(A-4).

## Entry template

Copy this block for each new run.

```markdown
## Run N — YYYY-MM-DD

| Field             | Value                                |
| ----------------- | ------------------------------------ |
| Collection window | YYYY-MM-DD HH:MM to HH:MM UTC        |
| Status (C-8)      | complete / partial (stop reason)     |
| Collector         | commit `<sha>` (PR #)                |
| Analysis          | `study/analyze.py` at commit `<sha>` |
| Output            | `study/output/findings-runN.md`      |

### Changed since run N-1

- **Collector:** targets, size bands, search terms, sampling method, file cap, redaction
  detectors.
- **Analysis:** classifier rules, metric definitions, deduplication.
- **Plan:** §10 entries that apply to this run.

### Effect on comparability

Which figures can be compared with run N-1 as they stand, and which cannot, and why.
```

## Run 2 — 2026-10-10

| Field             | Value                                                      |
| ----------------- | ---------------------------------------------------------- |
| Collection window | 2026-10-10 07:08 to 09:34 UTC                              |
| Status (C-8)      | partial (stop reason `file-cap`, the 5,000-file cap in §9) |
| Collector         | commit `2179f64` (PR #42)                                  |
| Analysis          | `study/analyze.py` as changed in the PR adding this entry  |
| Output            | `study/output/findings-run2.md`                            |

### Changed since run 1

- **Collector:** the corpus is now written per run (`study/corpus/run2/`), and the draw
  left out every repository run 1 completed (1,147, `--exclude-from run1`). The exclusion
  is recorded in `sampling.jsonl`. Targets, size bands, search terms, sampling method,
  file cap and redaction detectors are unchanged. A new seed was drawn.
- **Analysis:**
  - `--run` selects the corpus and names the output file.
  - Files of a repository with no repository record are left out. The file cap stopped
    run 2 partway through one repository, leaving 7 files without a record. Run 1 had
    none, so its figures are unchanged.
- **Plan:** §10.1 (the staleness summary) was fixed before this run was read.
- **After this run:** the threshold table was removed from the analysis output, and both
  findings files were regenerated. No figure changed.

### Effect on comparability

- No repository is in both runs, so the two are independent samples of the same search
  results, drawn the same way. An owner or identical file content can still appear in
  both.
- Discovery ran again, so search ranking and `total_count` reflect a later moment. The
  pool run 2 drew from is the same as run 1's minus the run-1 repositories, so it leans
  further down each slice's relevance order.
- Every figure is comparable with run 1.

## Run 1 — 2026-10-10

| Field             | Value                                                      |
| ----------------- | ---------------------------------------------------------- |
| Collection window | 2026-10-10 01:20 to 03:51 UTC                              |
| Status (C-8)      | partial (stop reason `file-cap`, the 5,000-file cap in §9) |
| Collector         | commit `f865c36` (PR #37)                                  |
| Analysis          | `study/analyze.py` as merged in PR #38 (commit `69d06d4`)  |
| Output            | `study/output/findings-run1.md`                            |

### Configuration

- **Targets:** the ten config-class paths in §5. Documentation-class blocks are not
  collected.
- **Size bands:** `size:<1000`, `size:1000..4999`, `size:5000..19999`, `size:>=20000`.
- **Search terms:** `mcpServers` (`.mcp.json`, Cursor, Junie), `servers` (VS Code),
  `permissions` (settings), `description` (skills, Cursor rules), `claude`, `agents` and
  `copilot` (the instruction files).
- **Sampling:** `stratified-v1`, a seeded draw balanced across targets (§5, Expansion
  order). The seed is stored in the corpus (`sampling.jsonl`), not here.
- **File cap:** 5,000.
- **Redaction detectors:** pem, jwt, github, aws, anthropic, openai, slack, stripe,
  google, keyed-literal.

### Changed before this run

The baseline. Changes made before the first run were folded into the plan, which was
locked on this date. The one that matters for later comparisons: expansion order changed
from first come, first served to the stratified draw (PR #37). Without it, the cap would
have been spent on the targets searched first.

### Analysis choices made after seeing the data

These were made while analyzing run 1 and apply from run 1 on.

- **`npx tsx` and `npx ts-node`** are classified as local scripts, not npm packages. This
  changed the Q5 npm count and the Q6 unpinned rate. Only the corrected figures were
  published.
- **Q7 hostnames** are kept only when they are plain hostnames, which drops unresolved
  VS Code `${input:…}` variables.
- **Installer-generated configs** (Laravel `artisan boost:mcp`, `herd-mcp.phar`) are
  broken out as an exploratory measure (§10.2, S-8).

### Added for the next run

- **§10.1:** a staleness summary (median lag and the share lagging more than 90 days),
  fixed after this run and before the next.
