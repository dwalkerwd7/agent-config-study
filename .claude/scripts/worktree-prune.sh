#!/usr/bin/env bash
set -euo pipefail
# worktree-prune.sh [--landed-only] [--force] — remove finished agent worktrees.
#
# Portable: it selects worktrees by BRANCH NAME (anything under `agent/`, or
# $AGENT_BRANCH_PREFIX), never by path, so it works whether worktrees live in a
# bare-repo container, beside the checkout, or anywhere else.
#
# A worktree is LANDED when its work is provably on the default branch:
#
#   - its branch is the head of a merged PR (a squash merge rewrote the commits,
#     so only the merged-PR list can say so), or
#   - it has local commits and every one of them has an identical patch on the
#     default branch (`git cherry`: a rebase or single-commit squash merge).
#
# Landed is the ONLY state in which the work is known to exist somewhere else,
# so it is what decides. These states all look alike from the remote, and are
# not landed:
#
#   - never pushed, with commits -> an interrupted build; the work exists
#                                   nowhere else                        -> KEEP
#   - clean, no commits, issue open -> a FRESH build: a builder has just been
#                                   handed this worktree and has not written
#                                   anything yet. Deleting it is how a live
#                                   builder lost its worktree before    -> KEEP
#   - clean, no commits, issue closed -> abandoned                      -> prune
#
# Guards that apply to everything, landed or not:
#   - a process whose cwd is inside the worktree (a builder, a dev server, a
#     shell) means it is in use. Never removed, not even with --force.
#   - uncommitted or untracked files are work that exists nowhere else. Kept
#     unless --force.
#
# A branch that STILL exists on origin is kept unless its PR merged: it is in
# review, or a pushed build to resume. A detached worktree is reported, never
# removed: with no branch there is no way to tell what it is.
#
# --landed-only  remove landed worktrees and nothing else. Safe during a drain;
#                dispatch-prepare.sh runs it before every pick.
# --force        also remove unlanded worktrees and ones with uncommitted files.
#                For a person cleaning up by hand, never for an agent.

force=false
landed_only=false
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    --landed-only) landed_only=true ;;
    *) echo "worktree-prune: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done
prefix="${AGENT_BRANCH_PREFIX:-agent/}"

git worktree prune
git fetch origin --prune --quiet || true
base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
primary="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"

# Agent branches that still exist on origin (space-padded for substring matching).
remote_set=" $(git ls-remote --heads origin 2>/dev/null \
  | sed -nE 's#.*refs/heads/(.*)$#\1#p' | tr '\n' ' ') "

# Head branches of merged PRs, and open issue numbers. Both empty if gh is
# unavailable: then nothing counts as merged and every issue counts as open,
# which keeps worktrees rather than removing them, the safe direction to fail.
merged_set=" $(gh pr list --state merged --limit 200 --json headRefName \
  --jq '.[].headRefName' 2>/dev/null | tr '\n' ' ') "
if open_issues="$(gh issue list --state open --limit 1000 --json number --jq '.[].number' 2>/dev/null)"; then
  open_set=" $(printf '%s' "$open_issues" | tr '\n' ' ') "
else
  open_set="unknown"
fi

# Processes whose cwd is inside the worktree, as "pid:comm" (dispatch-verify.sh's
# definition of live work). Empty when nothing is working there.
live_in() {
  local real d cwd out=""
  real="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  for d in /proc/[0-9]*; do
    [ "${d#/proc/}" = "$$" ] && continue
    cwd="$(readlink "$d/cwd" 2>/dev/null || true)"
    case "$cwd" in "$real"|"$real"/*) out+="${d#/proc/}:$(tr -d '\0' < "$d/comm" 2>/dev/null) " ;; esac
  done
  printf '%s' "$out"
}

# How the work landed, or empty when it has not.
landed_how() {
  local path="$1" branch="$2" ahead
  case "$merged_set" in *" $branch "*) echo "PR merged"; return ;; esac
  ahead="$(git -C "$path" rev-list --count "$base"..HEAD 2>/dev/null || echo 0)"
  if [ "$ahead" -gt 0 ] && ! git -C "$path" cherry "$base" HEAD 2>/dev/null | grep -q '^+'; then
    echo "every commit already on $base"
  fi
}

remove_worktree() {
  local path="$1" branch="$2"
  git worktree remove --force "$path" 2>/dev/null || true
  [ -n "$branch" ] && git branch -D "$branch" 2>/dev/null || true
}

# Emit one "<path>\t<branch>" line per worktree (branch empty if detached).
git worktree list --porcelain | awk '
  /^worktree /{ path = substr($0, 10); branch = "" }
  /^branch /  { b = $2; sub(/^refs\/heads\//, "", b); branch = b }
  /^$/        { if (path != "") print path "\t" branch; path = ""; branch = "" }
  END         { if (path != "") print path "\t" branch }
' | while IFS=$'\t' read -r path branch; do
  [ "$path" = "$primary" ] && continue          # never touch the primary checkout

  if [ -z "$branch" ]; then
    echo "SKIPPED (detached, cannot identify): $path"
    continue
  fi
  case "$branch" in "$prefix"*) : ;; *) continue ;; esac   # not an agent worktree

  live="$(live_in "$path")"
  if [ -n "$live" ]; then
    echo "KEPT (in use by ${live% }): $path ($branch)"
    continue
  fi

  how="$(landed_how "$path" "$branch")"
  if [ -z "$how" ]; then
    case "$remote_set" in *" $branch "*) continue ;; esac   # in review or to resume
  fi
  [ -z "$how" ] && [ "$landed_only" = true ] && continue

  dirty="$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$dirty" -gt 0 ] && [ "$force" = false ]; then
    echo "KEPT ($dirty uncommitted/untracked file(s)${how:+, though $how}): $path ($branch)"
    echo "     commit and push them, or re-run with --force to discard them."
    continue
  fi

  if [ -n "$how" ]; then
    remove_worktree "$path" "$branch"
    echo "pruned worktree ($how): $path ($branch)"
    continue
  fi

  if [ "$force" = false ]; then
    ahead="$(git -C "$path" rev-list --count "$base"..HEAD 2>/dev/null || echo 0)"
    if [ "$ahead" -gt 0 ]; then
      echo "KEPT ($ahead unpushed commit(s), not on $base, no merged PR): $path ($branch)"
      echo "     commit and push it, or re-run with --force to discard it."
      continue
    fi
    n="$(printf '%s' "$branch" | sed -nE "s#^${prefix}([0-9]+)-.*#\1#p")"
    if [ -z "$n" ] || [ "$open_set" = unknown ]; then
      echo "KEPT (clean, but cannot tell whether its issue is open: possibly a fresh build): $path ($branch)"
      continue
    fi
    case "$open_set" in
      *" $n "*)
        echo "KEPT (clean, but issue #$n is open: possibly a fresh build): $path ($branch)"
        continue ;;
    esac
  fi
  remove_worktree "$path" "$branch"
  echo "pruned worktree: $path ($branch)"
done
