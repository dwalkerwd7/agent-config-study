# study

Working directories for the corpus study. The write-up lives in
[results.md](results.md).

| Path      | Contents                                                        |
| --------- | --------------------------------------------------------------- |
| `corpus/` | Raw collected files. Gitignored, never committed, never shared. |
| `output/` | Analysis output. Every figure published traces back to this.    |

`corpus/` is excluded by `.gitignore` under rule C-9: the raw corpus may contain
credential-shaped values and is never persisted outside this machine. Redaction happens
at collection time (C-1), so even the collector never writes a raw secret to disk.

`output/` is committed. Rule A-2 requires that any number appearing in the README or the
results file was emitted by the analysis script rather than typed by hand, which only
works if the output is in version control alongside the claim.
