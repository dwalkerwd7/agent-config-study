# driftwood

A GitHub App that inventories AI coding-agent configuration across an organization's
repositories and reports when it changes.

**Status: scaffold only.** The monorepo, services and build pipeline described under
[Install](#install) work today. None of the scanning, inventory or drift behaviour below is
implemented yet, and whether it gets built at all depends on the
[corpus study](#corpus-study). See [Status](#status).

## The problem

The files that configure a coding agent — which MCP servers it can call, which skills it loads,
which instructions it follows — sit in the repository and change what the agent does and what
tools it can reach. They are committed like any other file, but they are rarely reviewed in a
pull request and nobody tracks them across an organization.

## What it does

Three layers:

1. **Static checks.** Reads each config file and reports hardcoded secrets, package and image
   references with no version pin, plaintext `http://` endpoints, and `docker` invocations that
   mount broad host paths such as `/` or the Docker socket.
2. **Org-wide inventory.** Walks every repository in the organization and records which agent
   config files exist, which MCP servers they declare, and how they are launched.
3. **Drift detection.** Compares each scan against a baseline you have approved and reports what
   was added, removed or modified since.

driftwood reports and compares. It does not block merges, gate CI or prevent anything; a finding
is a thing to go look at, not an incident.

## What it checks

| Kind         | Paths                                                       |
| ------------ | ----------------------------------------------------------- |
| MCP servers  | `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`         |
| Agent skills | `.claude/skills/**/SKILL.md`                                |
| Rules files  | `.cursor/rules/**/*.mdc`                                    |
| Instructions | `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md` |

MCP config is parsed as JSON with comments and trailing commas, because that is what the editors
themselves accept. Markdown surfaces are split into YAML frontmatter and body.

## Install

Requires Node 22+, pnpm 11+ and Docker.

```bash
git clone git@github.com:dwalkerwd7/driftwood.git
cd driftwood
pnpm install

cp .env.example .env          # then fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
openssl rand -base64 32       # use this for AUTH_SECRET

pnpm services:up              # postgres + redis via docker compose
pnpm db:migrate               # apply the schema
pnpm build
```

Run the pieces:

```bash
pnpm --filter @driftwood/api dev       # fastify api on :3001
pnpm --filter @driftwood/api worker    # bullmq worker
pnpm --filter @driftwood/web dev       # next.js app on :3000
pnpm test
```

The GitHub OAuth callback URL is `http://localhost:3000/api/auth/callback/github`.

## Example output

Planned reporting format, not yet produced by the code:

```
$ driftwood scan --org acme

acme/payments-api
  .mcp.json                         3 servers
    high    secret/github-pat        Hardcoded GitHub token in server "github" env.GITHUB_TOKEN
    medium  mcp/unpinned-reference   server "fetch" runs "mcp-server-fetch" with no version pin
  CLAUDE.md                         4.1 KB
  .claude/skills/deploy/SKILL.md    allowed-tools: Bash, Read, Write

acme/internal-tools
  .cursor/mcp.json                  1 server
    medium  mcp/broad-docker-mount   server "fs" mounts /var/run/docker.sock into a container
    high    mcp/insecure-url         server "notes" uses a plaintext http:// URL

acme/marketing-site
  no agent configuration found

3 repositories, 6 config files, 4 findings (2 high, 2 medium)
```

```
$ driftwood drift --org acme --since 7d

acme/payments-api   .mcp.json                       modified   a1b2c3d -> 9f8e7d6
                    + server "shell"  command: bash -c
acme/web            .claude/skills/deploy/SKILL.md  added
acme/billing        AGENTS.md                       removed

3 changes against baseline, none acknowledged
```

## Status

What exists: a pnpm monorepo (`apps/api`, `apps/web`, `packages/core`, `packages/db`), a Fastify
API with health and readiness checks, a BullMQ queue and worker, a Prisma schema covering the
Auth.js tables, GitHub OAuth sign-in in the Next.js app, an MCP server with a placeholder tool,
and parsing and hashing helpers in `packages/core`.

Not built yet:

- The GitHub App itself — manifest, installation flow, webhook receiver and signature check.
  Only a personal-access-token Octokit client exists.
- Repository walking and config-file discovery.
- Every static check listed above.
- Baseline approval and drift comparison.
- Any user interface beyond a sign-in button, and the `driftwood` CLI shown above.
- Notifications of any kind.

The Prisma schema currently holds only the Auth.js tables; the inventory, findings and drift
models are not designed yet.

## Corpus study

Whether driftwood gets built at all depends on a study of agent configuration in public
repositories, pre-registered before any data was collected.

The study exists to test the premise above. If committed agent config turns out to be rare,
already pinned, or actively maintained, there is nothing worth inventorying and the answer is
no. The criteria were fixed in advance so the result cannot be reinterpreted afterwards: a gate
on how many config files exist at all, then at least three of five signals — servers per config,
unpinned reference rate, credential-shaped values, cross-client divergence, staleness — landing
on the build side. A secondary purpose is to produce sanitized test fixtures and a severity
rubric grounded in what actually appears in the wild, rather than in what seems alarming.

- [study-plan.md](study-plan.md) — population, collection method, the locked questions Q1–Q14,
  the decision criteria, and the priors recorded in advance to check calibration against
- [corpus-study-rules.md](corpus-study-rules.md) — what may and may not be published, redaction
  at collection, and disclosure handling
- [corpus-study-results.md](corpus-study-results.md) — findings and the recorded decision, once
  the study has run

**Status: not started.** No data has been collected and there are no findings. Any figure that
reaches this README will state N and its collection date, be scoped to the corpus rather than
projected onto GitHub as a whole, and trace to analysis output instead of being typed by hand.

The raw corpus is never committed — it stays in `study/corpus/`, which is gitignored. Analysis
output goes to `study/output/`, which is committed so that published numbers have a source.

## License

MIT.
