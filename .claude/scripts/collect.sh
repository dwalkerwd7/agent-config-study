#!/usr/bin/env bash
set -euo pipefail
# collect.sh [collector args...] — what `pnpm collect` runs.
# Starts the corpus collector under `op run`, which resolves the op:// secret
# references in the repo-root .env (GITHUB_TOKEN, CORPUS_SALT) into the
# collector's environment only. The resolved values never touch disk, and the
# collector itself never reads .env. Arguments pass straight through, e.g.
#   pnpm collect --dry-run
#   pnpm collect --max-repos 5
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
env_file="$root/.env"

command -v op >/dev/null || {
  echo "collect.sh: the 1Password CLI (op) is not installed" >&2
  exit 1
}
[[ -f "$env_file" ]] || {
  echo "collect.sh: no .env at $env_file (copy .env.example and fill it in)" >&2
  exit 1
}

cd "$root"
exec op run --env-file="$env_file" -- pnpm --filter @driftmark/collector collect "$@"
