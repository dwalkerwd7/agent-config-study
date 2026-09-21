#!/usr/bin/env bash
# security.sh <check>... [--base <ref>] — security scans, run identically by
# verify.sh, the builder, and CI.
#
#   sast       semgrep over the whole tree, with the rulesets in SEMGREP_CONFIGS
#   secrets    gitleaks over the commits since <base> plus the uncommitted and
#              untracked files, or over the full history with --base ''
#   deps       pnpm or npm audit, failing on high or critical advisories
#   workflows  actionlint + zizmor over .github/workflows
#
# Every tool is pinned. Binaries are downloaded once into $TOOLS_DIR and
# checked against a SHA-256, so a local run and a CI run use the same bytes.
# Python tools run through `uvx`, which also pins the exact version.
set -uo pipefail

GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ACTIONLINT_VERSION=1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
SEMGREP_VERSION=1.177.0
ZIZMOR_VERSION=1.30.1

# PER-PROJECT: semgrep registry rulesets for this stack (https://semgrep.dev/r).
# p/default covers most languages; add the stack-specific packs, e.g.
#   p/typescript p/nodejs p/react p/nextjs p/python p/django p/golang
SEMGREP_CONFIGS=(p/typescript p/javascript p/nodejs p/react p/nextjs
  p/owasp-top-ten p/github-actions)

TOOLS_DIR="${TOOLS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/agent-tools}"

base="origin/main"
checks=()
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="${2-}"; shift 2 ;;
    sast|secrets|deps|workflows) checks+=("$1"); shift ;;
    *) echo "security.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[ ${#checks[@]} -gt 0 ] || { echo "usage: security.sh sast|secrets|deps|workflows... [--base <ref>]" >&2; exit 2; }

cd "$(git rev-parse --show-toplevel)" || exit 2

# The pinned binaries below are linux/x86_64 builds — what CI runs on.
if [ "$(uname -sm)" != "Linux x86_64" ]; then
  echo "security.sh: pinned tool binaries are linux/x86_64 only (this is $(uname -sm))" >&2
  exit 2
fi

# fetch_tool <name> <version> <url> <sha256> — prints the binary's path.
fetch_tool() {
  local name="$1" version="$2" url="$3" sha="$4"
  local dir="$TOOLS_DIR/$name-$version"
  if [ ! -x "$dir/$name" ]; then
    echo "security: fetching $name $version" >&2
    mkdir -p "$dir" || return 1
    local tgz="$dir/$name.tar.gz"
    curl -fsSL "$url" -o "$tgz" || return 1
    echo "$sha  $tgz" | sha256sum -c --quiet - >&2 || { rm -f "$tgz"; echo "security: $name checksum mismatch" >&2; return 1; }
    tar -xzf "$tgz" -C "$dir" "$name" && rm -f "$tgz" || return 1
  fi
  echo "$dir/$name"
}

need_uvx() {
  command -v uvx >/dev/null || { echo "security: uvx not found — install uv (https://docs.astral.sh/uv/)" >&2; return 1; }
}

run_sast() {
  need_uvx || return 1
  # Registry rulesets are fetched at run time, so a new rule can surface a
  # finding in unchanged code. That is the point of SAST, not flakiness.
  local args=() c
  for c in "${SEMGREP_CONFIGS[@]}"; do args+=(--config "$c"); done
  uvx "semgrep==$SEMGREP_VERSION" scan --metrics off --error --quiet "${args[@]}"
}

run_secrets() {
  local gitleaks
  gitleaks="$(fetch_tool gitleaks "$GITLEAKS_VERSION" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    "$GITLEAKS_SHA256")" || return 1

  if [ -z "$base" ]; then
    "$gitleaks" git --no-banner --redact . || return 1
    return 0
  fi

  local mergebase
  mergebase="$(git merge-base "$base" HEAD 2>/dev/null)" || { echo "security: cannot resolve base '$base'" >&2; return 1; }
  if [ "$mergebase" != "$(git rev-parse HEAD)" ]; then
    "$gitleaks" git --no-banner --redact --log-opts="$mergebase..HEAD" . || return 1
  fi
  # Uncommitted and untracked files, one at a time: `gitleaks dir .` would
  # also read the gitignored .env, which holds real local credentials.
  local f rc=0
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    "$gitleaks" dir --no-banner --redact --log-level warn "$f" || rc=1
  done < <( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u )
  return $rc
}

run_deps() {
  if   [ -f pnpm-lock.yaml ];    then pnpm audit --audit-level high
  elif [ -f package-lock.json ]; then npm audit --audit-level=high
  else echo "security: no pnpm or npm lockfile — add this stack's audit here" >&2; return 1
  fi
}

run_workflows() {
  [ -d .github/workflows ] || { echo "security: no .github/workflows — nothing to check"; return 0; }
  local actionlint
  actionlint="$(fetch_tool actionlint "$ACTIONLINT_VERSION" \
    "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
    "$ACTIONLINT_SHA256")" || return 1
  "$actionlint" || return 1
  need_uvx || return 1
  uvx "zizmor==$ZIZMOR_VERSION" --offline .github/workflows
}

for check in "${checks[@]}"; do
  echo "security: $check"
  "run_$check" || { echo "security: $check FAILED" >&2; exit 1; }
done
echo "security: ok"
