Corpus Study — Results

Findings from the study pre-registered in study-plan.md, governed by corpus-study-rules.md.
Question IDs (Q1–Q14) and rule IDs refer to those files.

Status: not yet run · no data collected · owner: Derek Walker

Nothing below is filled in. Every figure that lands here is emitted by the analysis script
and copied from `study/output/`, never typed from memory (A-2). Until a run completes,
this file states that it is empty rather than carrying placeholder numbers that could be
mistaken for findings.

## 1. Run record

| Field                                                 | Value     |
| ----------------------------------------------------- | --------- |
| Collection window                                     | (pending) |
| Analysis date                                         | (pending) |
| Complete or partial (C-8)                             | (pending) |
| Responses with incomplete_results (C-4)               | (pending) |
| Config-class files, deduplicated (S-4)                | (pending) |
| Config-class files, raw                               | (pending) |
| Documentation-class blocks, reported separately (S-7) | (pending) |
| Repositories                                          | (pending) |
| Distinct owners after dedup (C-7)                     | (pending) |

## 2. Method and known bias

Required in the same artifact as any statistic drawn from it (S-3). Summarize the
collection method here and state its biases plainly: code search returns a
relevance-ranked slice rather than the population, queries are capped, and the stars,
size and pushed-date bands are an attempt to break that ranking rather than a random
sample. No figure here extrapolates beyond the corpus (S-1).

(pending)

## 3. Decision

Recorded against the criteria fixed in study-plan.md §2, which were written before
collection so the result cannot be reinterpreted.

| Signal                                   | Build   | Don't build | Observed  | Side      |
| ---------------------------------------- | ------- | ----------- | --------- | --------- |
| Config-class files collected (gate)      | ≥ 1,000 | < 300       | (pending) | (pending) |
| Median servers per config                | ≥ 2     | 1           | (pending) | (pending) |
| Unpinned reference rate                  | ≥ 40%   | < 15%       | (pending) | (pending) |
| Configs with credential-shaped env value | ≥ 3%    | < 1%        | (pending) | (pending) |
| Repos with 2+ configs that disagree      | ≥ 20%   | < 5%        | (pending) | (pending) |
| Median config age vs repo age            | staler  | tracks repo | (pending) | (pending) |

The first row is a gate. At least three of the remaining five must land on the build side.

**Decision: (pending)**

Reasoning: (pending)

## 4. Answers

Each answer states N in the same row or axis (S-2) and is scoped to the corpus (S-1).
Deduplicated figures are the headline; raw shown alongside and labeled (S-4).

### Prevalence and shape

- **Q1** Config-class files by path type, deduplicated and raw — (pending)
- **Q2** Servers per config: median, IQR, max — (pending)
- **Q3** Transport mix: stdio / http / sse / socket — (pending)
- **Q4** Client mix by file count and repo count — (pending)

### Supply-chain hygiene

- **Q5** Reference targets by type: npm, uvx/PyPI, docker, local path, remote URL — (pending)
- **Q6** Pinning: exact version or digest, versus range, `@latest`, or nothing — (pending)
- **Q7** Top 50 servers by frequency (publishable under P-3) — (pending)
- **Q8** Configs with a credential-shaped literal, by detector type only (P-8) — (pending)

### Governance signals

- **Q9** Pinning and credential rates across stars bands — descriptive only, no significance
  testing; the sample is not random (pending)
- **Q10** Among repos with 2+ client configs, how often server sets differ — (pending)
- **Q11** Staleness: days between last commit to the config and to the repo — (pending)
- **Q12** Risky invocation patterns: broad `-v` mounts, `--privileged`, `--network host`,
  plaintext `http://` to non-local hosts — (pending)

### Skills and instruction files

- **Q13** Repos shipping skills or rules files, and how many each — (pending)
- **Q14** Size distribution of instruction files — (pending)

## 5. Falsification check

The four outcomes from study-plan.md §8 that would sink the premise. Any two and the
answer is no.

| Outcome                                         | Holds?    |
| ----------------------------------------------- | --------- |
| Config is overwhelmingly documentation-class    | (pending) |
| Pinning rates are already high                  | (pending) |
| Servers per config ≈ 1, same handful everywhere | (pending) |
| Config is as fresh as the repos                 | (pending) |

## 6. Calibration

Priors were recorded in study-plan.md §3 before collection, so a result that merely
matches expectation is not mistaken for a discovery.

| Prior                           | Predicted | Observed  |
| ------------------------------- | --------- | --------- |
| Config-class files findable     | ~2,000    | (pending) |
| Documentation vs config ratio   | 3–5×      | (pending) |
| Median servers per config       | 3         | (pending) |
| Unpinned rate                   | 70%       | (pending) |
| Credential-shaped values in env | 5%        | (pending) |
| Multi-client divergence         | 40%       | (pending) |

## 7. Competing explanations

Where a result has a plausible alternative reading, it is stated here. Absence of a
counter-explanation is not evidence (S-9).

(pending)

## 8. Fixtures produced

Sanitized fixtures derived from the corpus, each satisfying P-4 before entering the
repository, never added by copy-paste from the raw corpus (A-5).

(pending)

## 9. Exploratory additions

Anything computed after looking at the data, labeled exploratory wherever it appears (S-8).
Post-hoc questions are recorded in study-plan.md §10 first.

(none yet)

## 10. Re-runs

If the study is re-run, prior figures are kept with their collection date rather than
silently overwritten (A-4).

(none yet)
