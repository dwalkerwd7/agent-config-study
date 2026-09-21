#!/usr/bin/env bash
set -euo pipefail
# worktree-add.sh <issue#|branch> — create (or reuse) an isolated worktree for a
# build, and print its path on the LAST stdout line. All other output goes to
# stderr, so a caller can do: path=$(bash worktree-add.sh 42 | tail -1)
#
# Portable across layouts. Worktrees are placed under, in order of preference:
#   $WORKTREE_ROOT, if set
#   the container directory, when this is a bare repo with sibling worktrees
#   <checkout>-worktrees/, for an ordinary checkout
#
#   <issue#>   reuse an existing remote `agent/<n>-*` branch if there is one
#              (resumed work), else cut `agent/<n>-<slug>` fresh from the default
#              branch, slug taken from the issue title.
#   <branch>   check out that exact branch from origin.
#
# Post-create setup runs `.claude/scripts/worktree-setup.sh <path>` if the repo
# has one — that is where dependency install, code generation or anything else
# the verify gate needs belongs. Without it, a recognised lockfile gets the
# matching install and nothing else.

arg="${1:?usage: worktree-add.sh <issue#|branch>}"
git fetch origin --prune --quiet

common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
primary="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"
default="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"

if [ -n "${WORKTREE_ROOT:-}" ]; then
  root="$WORKTREE_ROOT"
elif [ "$(dirname "$common")" != "$primary" ]; then
  root="$(dirname "$common")"          # bare repo + sibling worktrees
else
  root="${primary}-worktrees"          # ordinary checkout
fi

if [[ "$arg" =~ ^[0-9]+$ ]]; then
  existing="$(git ls-remote --heads origin "agent/${arg}-*" \
    | awk '{print $2}' | sed 's#refs/heads/##' | head -1 || true)"
  if [ -n "$existing" ]; then
    branch="$existing"; reuse=true
  else
    title="$(gh issue view "$arg" --json title --jq .title 2>/dev/null || echo "")"
    slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' \
      | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -d- -f1-6)"
    branch="agent/${arg}${slug:+-$slug}"; reuse=false
  fi
else
  branch="$arg"; reuse=true
fi

path="$root/$branch"

if ! git worktree list --porcelain | grep -qxF "worktree $path"; then
  mkdir -p "$(dirname "$path")"
  if [ "$reuse" = true ]; then
    git worktree add "$path" -B "$branch" "origin/$branch" >&2
  else
    git worktree add "$path" -b "$branch" "$default" >&2
  fi

  if [ -x .claude/scripts/worktree-setup.sh ]; then
    bash .claude/scripts/worktree-setup.sh "$path" >&2
  elif [ -f "$path/pnpm-lock.yaml" ]; then ( cd "$path" && pnpm install ) >&2
  elif [ -f "$path/yarn.lock" ];      then ( cd "$path" && yarn install ) >&2
  elif [ -f "$path/bun.lockb" ];      then ( cd "$path" && bun install ) >&2
  elif [ -f "$path/package-lock.json" ]; then ( cd "$path" && npm ci ) >&2
  else echo "worktree-add: no setup hook and no recognised lockfile — skipping install" >&2
  fi
else
  echo "worktree already present: $path (branch $branch)" >&2
fi

echo "$path"
