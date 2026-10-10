#!/usr/bin/env bash
set -euo pipefail
# worktree-setup.sh <path> — called by worktree-add.sh on a new worktree.
# Installs dependencies, which is all the verify gate needs.
cd "${1:?usage: worktree-setup.sh <path>}"
pnpm install --frozen-lockfile
