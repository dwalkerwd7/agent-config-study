Corpus Study — Publication Rules

Governs the public-repo scan of AI coding-agent configuration files and every artifact derived from it: the README, blog posts, charts, talks, social posts, and the published collector.

Every rule has an ID. Any change to the README or any other published artifact can be checked against these IDs. If a change cannot be traced to a rule that permits it, the change does not ship.

Status: draft v1 · owner: Derek Walker

1. Definitions
   Term Meaning
   Corpus The set of agent-config files collected from public repositories.
   Raw corpus Collected file contents, unredacted.
   Sanitized fixture A config file with all credential-shaped values replaced by typed placeholders.
   Aggregate claim A statement about counts or proportions within the corpus, naming no repository.
   Identified claim Any statement naming a repository, owner, organization, or individual.
   Live credential A credential-shaped value that has not been confirmed revoked or fake.
2. Collection rules (C)
   C-1 Redact at collection. A credential-shaped value MUST be replaced with a typed placeholder before the file is written to disk. Raw secret values are never persisted, not in the corpus, not in logs, not in cache, not in error output.
   C-2 For each redacted value, record only: detector name, value type, file path, byte offset, and a salted hash of the value. The salt is never published.
   C-3 Record provenance for every file: repository full name, commit SHA, file path, retrieval timestamp, and the query that surfaced it.
   C-4 Record incomplete_results for every search response. Any result set with incomplete_results: true is flagged and its partial status carried through to analysis.
   C-5 Classify each file at collection time as config (a real config file at a known path) or documentation (a fenced block inside Markdown). The two are never merged in analysis.
   C-6 Exclude forks (fork:false) at query time.
   C-7 Deduplicate on (a) normalized content hash and (b) owner. Both raw and deduplicated counts are retained.
   C-8 The collector is resumable and writes results incrementally. A partial run is labeled partial and is never reported as a complete run.
   C-9 The raw corpus lives in a single directory, excluded by .gitignore, never committed, never uploaded, never attached to an issue or a post.
3. Publication rules (P)
   MAY publish
   P-1 Aggregate counts and proportions within the corpus.
   P-2 Distributions: servers per config, transport mix, client mix, pinning rates, staleness.
   P-3 Names of packages, images, and public MCP servers by frequency of appearance. These are published software artifacts, not private facts.
   P-4 Sanitized fixtures, provided every credential-shaped value has been replaced per C-1 and the source repository is not identified.
   P-5 Named repositories ONLY where all of P-4's sanitization holds AND the rule in P-9 is satisfied.
   P-6 The collector source, the detector rules, and the full methodology.
   P-7 Screenshots, provided every credential-shaped value, repository name, and owner name is masked in the image itself, not merely cropped.
   MUST NOT publish
   P-8 Any credential value, in whole or in part, redacted or not. No prefixes, no last-four, no character counts, no "it started with ghp_."
   P-9 The name of any repository in which a live credential was found — no matter how the finding is framed, and not even to praise a fix. This holds permanently, including after remediation.
   P-10 The raw corpus, in any form, to anyone.
   P-11 The hash salt from C-2.
   P-12 Any claim that a specific named repository is vulnerable, exploitable, or compromised.
   P-13 Individual names, email addresses, or handles of maintainers, including those appearing in commit metadata or config comments.
   P-14 Anything from a private repository. If a private repository is reachable at any point, its data is deleted and never analyzed.
   P-15 A count or proportion drawn from a run flagged partial under C-4 or C-8, unless labeled partial in the same sentence.
4. Claim rules (S)
   S-1 Every statistic MUST be scoped to the corpus. Permitted: "of the N configs collected, X% …". Prohibited: "X% of repositories on GitHub …".
   S-2 Every published statistic MUST state N in the same sentence, table row, or chart axis.
   S-3 The sampling method and its known biases MUST appear in the same artifact as any statistic derived from it. A chart shared standalone carries a one-line method note.
   S-4 Deduplicated counts are the headline figure. Raw counts may appear alongside, labeled.
   S-5 No claim that a finding constitutes an attack, a breach, or exploitation. Permitted framing: what was present in the file.
   S-6 No projection to dollar impact, breach likelihood, or affected user counts.
   S-7 Findings from documentation-class files (C-5) are reported separately and never combined into a config-class statistic.
   S-8 Questions and metrics are recorded in study-plan.md before collection begins. Any metric added after looking at the data is labeled exploratory in every artifact it appears in.
   S-9 Where a competing explanation for a result is plausible, it is stated. Absence of counter-explanation is not evidence.
5. Disclosure rules (D)
   D-1 A live credential is reported to GitHub's secret scanning intake so the provider can revoke it. This is the primary channel.
   D-2 No direct contact with the repository owner unless GitHub's channel does not cover the credential type.
   D-3 No public artifact mentioning a specific finding ships before the credential is revoked or 90 days have passed, whichever is first — and even then, P-9 still forbids naming the repository.
   D-4 No attempt is made to validate a credential against any live service. Detection is pattern-based only. Testing a key is unauthorized access.
   D-5 A disclosure log is kept privately: what type, when reported, when resolved. The log is never published.
6. Artifact rules (A)
   A-1 The README's findings section states N, the collection date, and links to the methodology.
   A-2 Any number in the README appears in the analysis output; no figure is typed by hand.
   A-3 Charts embed their own N and date, so a screenshot cannot be stripped of context.
   A-4 If the study is re-run, prior figures are marked with their collection date rather than silently overwritten.
   A-5 Test fixtures derived from the corpus satisfy P-4 before entering the repository. A fixture is never added by copy-paste from the raw corpus.
7. Pre-publication checklist (V)

Run against every changed artifact before it ships. All must be yes.

V-1 No credential-shaped string appears anywhere in the diff (P-8).
V-2 Every named repository is checked against the live-credential list (P-9).
V-3 Every statistic states N and is scoped to the corpus (S-1, S-2).
V-4 Method and known bias are present in or linked from this artifact (S-3).
V-5 Config-class and documentation-class figures are not mixed (S-7).
V-6 No metric added post-hoc appears without the exploratory label (S-8).
V-7 Any partial-run figure is labeled partial (P-15).
V-8 Every image is inspected at full resolution for unmasked names and values (P-7).
V-9 Every number traces to analysis output, not to memory (A-2).
V-10 Disclosure timelines under D-3 have elapsed for every finding referenced. 8. Amendments
X-1 These rules may be tightened at any time. Loosening a rule requires writing down the reason in this file, dated, before the change ships.
X-2 Rule IDs are permanent. A retired rule is marked retired with a date; the ID is never reused.
X-3 When in doubt, the aggregate version of the claim ships and the specific one does not.
Amendment log

(none yet)
