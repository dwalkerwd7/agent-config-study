#!/usr/bin/env bash
# verify.sh [base-ref] — THE GATE. Fill in the marked section for this project.
#
# Single source of truth for "what does done mean", run IDENTICALLY by the
# builder and by CI. If the two ever diverge, the builder ships work CI will
# reject, which costs a whole round trip — so CI should invoke this script
# rather than re-listing the commands.
#
# It runs the union of gates for whatever the diff actually touched, so a docs
# change does not pay for a full test suite.
set -uo pipefail

base="${1:-origin/main}"
# Detect what changed from the merge-base, INCLUDING uncommitted and untracked
# files, so the gate is correct whether it runs before or after a commit. (A
# plain `${base}...HEAD` is empty on a fresh branch with no commits yet, which
# would silently skip everything.) CI runs on a clean committed tree, where this
# reduces to the same committed diff.
mergebase="$(git merge-base "$base" HEAD 2>/dev/null || echo "$base")"
files="$( { git diff --name-only "$mergebase"; git ls-files --others --exclude-standard; } | sort -u )"

# ---------------------------------------------------------------------------
# CI (.github/workflows/ci.yml) runs this script, so it is the whole gate:
#   pnpm lint       prettier --check .   (every change — markdown included)
#   pnpm lint:code  eslint, type-aware   (code changes)
#   pnpm typecheck  tsc across every workspace package
#   pnpm test       vitest
#   security.sh     semgrep + gitleaks, and actionlint + zizmor when workflows
#                   changed. Dependency audit is CI-only: it tracks advisories
#                   published upstream, not anything in the diff.
# ---------------------------------------------------------------------------

code=false; workflows=false
if [ -n "$files" ]; then
  echo "$files" | grep -qvE '\.md$|^study/|^\.claude/' && code=true
  echo "$files" | grep -qE '^\.github/' && workflows=true
else
  code=true; workflows=true   # no detectable diff — run the full gate, defensively
fi

echo "verify: code=$code workflows=$workflows (base=$base)"

here="$(dirname "$0")"

pnpm lint || exit 1

if [ "$code" = true ]; then
  pnpm lint:code || exit 1
  pnpm typecheck || exit 1
  pnpm test || exit 1
fi

# Secrets on every change: a key pasted into a markdown file leaks just the same.
checks=(secrets)
[ "$code" = true ] && checks+=(sast)
[ "$workflows" = true ] && checks+=(workflows)
bash "$here/security.sh" "${checks[@]}" --base "$base" || exit 1

echo "verify: ok"
