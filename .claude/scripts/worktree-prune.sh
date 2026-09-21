#!/usr/bin/env bash
set -euo pipefail
# worktree-prune.sh [--force] — remove finished agent worktrees.
#
# Portable: it selects worktrees by BRANCH NAME (anything under `agent/`, or
# $AGENT_BRANCH_PREFIX), never by path, so it works whether worktrees live in a
# bare-repo container, beside the checkout, or anywhere else.
#
# Run between builds, when nothing is in flight. The dispatcher is the sole
# owner of agent worktrees, so there is no cross-instance race.
#
# A worktree becomes a candidate once its branch is gone from origin. That alone
# is NOT enough to delete it, because two very different states look identical
# from the remote's point of view:
#
#   - its PR was squash-merged  -> the host deleted the branch; the work is in
#                                  the default branch under a new commit  -> prune
#   - it was never pushed       -> an interrupted or abandoned build; the work
#                                  exists nowhere else                    -> KEEP
#
# Squash is exactly why the local commits are unreachable from the default
# branch in the first case, so "has commits main doesn't" cannot tell the two
# apart — it flags every finished build as unbacked. The merged-PR list can, so
# that is what decides.
#
# Two further guards, applied to anything not known-merged. A worktree is never
# removed while it holds work that exists nowhere else:
#   - uncommitted or untracked files, or
#   - local commits not reachable from the default branch.
# Either one makes it skip and say why. `--force` overrides every guard.
#
# A branch that STILL exists on origin is always kept — it is either in review
# or a pushed build to resume after an interruption. A detached worktree is
# reported, never removed: with no branch there is no way to tell what it is.

force=false
[ "${1:-}" = "--force" ] && force=true
prefix="${AGENT_BRANCH_PREFIX:-agent/}"

git worktree prune
git fetch origin --prune --quiet || true
base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
primary="$(git worktree list --porcelain | awk '/^worktree /{print substr($0,10); exit}')"

# Agent branches that still exist on origin (space-padded for substring matching).
remote_set=" $(git ls-remote --heads origin 2>/dev/null \
  | sed -nE 's#.*refs/heads/(.*)$#\1#p' | tr '\n' ' ') "

# Head branches of merged PRs — the only reliable "this work landed" signal once
# a squash merge has rewritten the commits. Empty if gh is unavailable or this
# repo has no host, which makes every unpushed-looking worktree fall through to
# the guards and be kept: the safe direction to fail.
merged_set=" $(gh pr list --state merged --limit 200 --json headRefName \
  --jq '.[].headRefName' 2>/dev/null | tr '\n' ' ') "

# Why this worktree must not be removed, or empty when it is safe to remove.
unsafe_reason() {
  local path="$1" dirty ahead
  [ "$force" = true ] && return 1
  dirty="$(git -C "$path" status --porcelain 2>/dev/null | wc -l)"
  if [ "$dirty" -gt 0 ]; then echo "$dirty uncommitted/untracked file(s)"; return 0; fi
  ahead="$(git -C "$path" rev-list --count "$base"..HEAD 2>/dev/null || echo 0)"
  if [ "$ahead" -gt 0 ]; then echo "$ahead unpushed commit(s)"; return 0; fi
  return 1
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

  case "$remote_set" in
    *" $branch "*) continue ;;   # still on origin — in review or to resume; keep
  esac

  case "$merged_set" in
    *" $branch "*)               # PR merged — the work landed, under a squash
      remove_worktree "$path" "$branch"
      echo "pruned worktree (PR merged): $path ($branch)"
      continue ;;
  esac

  if reason="$(unsafe_reason "$path")"; then
    echo "KEPT ($reason, no merged PR, nothing on origin): $path ($branch)"
    echo "     commit and push it, or re-run with --force to discard it."
    continue
  fi
  remove_worktree "$path" "$branch"
  echo "pruned worktree: $path ($branch)"
done
