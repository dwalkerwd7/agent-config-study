#!/usr/bin/env bash
set -euo pipefail
# worktree-setup.sh <path> — called by worktree-add.sh on a new worktree.
# Installs dependencies and generates the Prisma client, which is gitignored
# and required before `pnpm typecheck` can pass. `prisma generate` needs no
# database, so no .env or running services are required for the verify gate.
cd "${1:?usage: worktree-setup.sh <path>}"
pnpm install --frozen-lockfile
pnpm db:generate
