#!/usr/bin/env python3
"""Corpus study analysis: answers Q1-Q14 (study/plan.md §6) from study/corpus.

Usage: python3 -I study/analyze.py [--corpus study/corpus] [--out study/output/findings-run1.md]

Every figure in the output is computed here from the corpus streams (A-2);
nothing is typed by hand. The output names no repository, owner or
maintainer (P-9, P-13), and reports credential-shaped values as counts by
detector type only (P-8): the corpus holds only `<REDACTED:detector>`
placeholders, and this script never reads redaction hashes.

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# The collector's TARGETS (apps/collector/src/targets.ts): (kind, client) names
# exactly one target, so the target a file counts toward can be recovered.
TARGETS = [
    ('.mcp.json', 'mcp', 'claude-code'),
    ('.cursor/mcp.json', 'mcp', 'cursor'),
    ('.vscode/mcp.json', 'mcp', 'vscode'),
    ('.junie/mcp/mcp.json', 'mcp', 'junie'),
    ('.claude/settings.json', 'settings', 'claude-code'),
    ('.claude/skills/**/SKILL.md', 'skill', 'claude-code'),
    ('.cursor/rules/**', 'rules', 'cursor'),
    ('CLAUDE.md', 'instructions', 'claude-code'),
    ('AGENTS.md', 'instructions', 'agents-md'),
    ('.github/copilot-instructions.md', 'instructions', 'copilot'),
]
TARGET_OF = {(kind, client): pattern for pattern, kind, client in TARGETS}
MCP_CLIENTS = ['claude-code', 'cursor', 'vscode', 'junie']
STAR_BANDS = [(0, 0, '0'), (1, 9, '1–9'), (10, 99, '10–99'), (100, 999, '100–999'), (1000, None, '≥1,000')]
LOCAL_HOSTS = re.compile(r'^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1|host\.docker\.internal)$', re.I)
PLACEHOLDER = re.compile(r'<REDACTED:([a-z-]+)>')


# ---------------------------------------------------------------- loading


def load_jsonl(path: Path) -> list[dict]:
    with path.open() as f:
        return [json.loads(line) for line in f if line.strip()]


def strip_jsonc(text: str) -> str:
    """Drops // and /* */ comments outside strings, then trailing commas."""
    out, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
            out.append(c)
        elif text.startswith('//', i):
            while i < n and text[i] != '\n':
                i += 1
            continue
        elif text.startswith('/*', i):
            end = text.find('*/', i + 2)
            i = n if end < 0 else end + 2
            continue
        else:
            out.append(c)
        i += 1
    return re.sub(r',(\s*[}\]])', r'\1', ''.join(out))


def parse_mcp(text: str) -> dict | None:
    for candidate in (text, strip_jsonc(text)):
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        return value if isinstance(value, dict) else None
    return None


def servers_of(config: dict) -> dict | None:
    """The server map: `mcpServers` (Claude Code, Cursor, Junie) or `servers` (VS Code)."""
    for key in ('mcpServers', 'servers'):
        value = config.get(key)
        if isinstance(value, dict):
            return value
    return None


# ---------------------------------------------------------------- servers


def argv_of(entry: dict) -> list[str]:
    command = entry.get('command')
    if not isinstance(command, str) or not command.strip():
        return []
    args = [a for a in entry.get('args') or [] if isinstance(a, str)] if isinstance(entry.get('args'), list) else []
    if not args and ' ' in command.strip():
        try:
            return shlex.split(command)
        except ValueError:
            return command.split()
    return [command, *args]


def program(arg: str) -> str:
    name = re.split(r'[\\/]', arg)[-1].lower()
    return re.sub(r'\.(cmd|exe|bat)$', '', name)


def unwrap(argv: list[str]) -> list[str]:
    """`cmd /c npx ...`, `wsl npx ...`, `bash -c "npx ..."` -> `npx ...`."""
    for _ in range(3):
        if not argv:
            return argv
        prog = program(argv[0])
        if prog == 'cmd' and len(argv) > 2 and argv[1].lower() in ('/c', '/k'):
            argv = argv[2:]
        elif prog in ('sh', 'bash', 'zsh') and len(argv) > 2 and argv[1] in ('-c', '-lc'):
            try:
                argv = shlex.split(argv[2])
            except ValueError:
                return argv
        elif prog == 'wsl' and len(argv) > 1:
            argv = argv[1:]
        else:
            return argv
    return argv


def first_positional(args: list[str], value_flags: set[str]) -> tuple[str | None, dict[str, str]]:
    """The first non-flag argument, plus any `value_flags` seen before it."""
    seen: dict[str, str] = {}
    i = 0
    while i < len(args):
        a = args[i]
        if a == '--':
            return (args[i + 1] if i + 1 < len(args) else None), seen
        if a.startswith('-'):
            flag, eq, val = a.partition('=')
            if flag in value_flags:
                if eq:
                    seen[flag] = val
                elif i + 1 < len(args):
                    seen[flag] = args[i + 1]
                    i += 1
            i += 1
            continue
        return a, seen
    return None, seen


NPM_VALUE_FLAGS = {'-p', '--package', '--registry', '--cache', '--userconfig', '-c', '--call', '--node-options'}
PY_VALUE_FLAGS = {'--from', '--with', '--python', '-p', '--index-url', '--extra-index-url', '--index', '--spec'}
DOCKER_BOOL = {'-i', '-t', '-it', '-ti', '-d', '--rm', '--init', '--privileged', '--interactive', '--tty',
               '--detach', '--read-only', '-q', '--quiet', '-P', '--publish-all', '--sig-proxy'}


def split_npm(spec: str) -> tuple[str, str | None]:
    at = spec.rfind('@')
    if at > 0:
        return spec[:at], spec[at + 1:]
    return spec, None


def npm_pin(version: str | None) -> str:
    if version is None or version == '':
        return 'none'
    if version in ('latest', 'next', 'beta', 'alpha', 'canary', 'rc', 'dev', 'edge'):
        return 'latest/tag'
    if re.fullmatch(r'v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?', version):
        return 'exact'
    return 'range'


def py_split(spec: str) -> tuple[str, str]:
    if spec.startswith(('git+', 'http://', 'https://')):
        return re.sub(r'\.git$', '', spec.split('@')[0].rstrip('/').split('/')[-1]).lower(), \
            ('exact' if re.search(r'@[0-9a-f]{7,40}$', spec) else 'none')
    m = re.match(r'([A-Za-z0-9_.\[\]-]+)\s*(==|===|@|>=|<=|~=|!=|>|<)?\s*(.*)$', spec)
    if not m:
        return spec.lower(), 'none'
    name, op, ver = m.group(1), m.group(2), m.group(3)
    name = re.sub(r'\[.*\]$', '', name).lower().replace('_', '-')
    if not op:
        return name, 'none'
    if op == '@' and ver in ('latest', ''):
        return name, 'latest/tag'
    if op in ('==', '===', '@') and re.fullmatch(r'v?\d+(\.\d+)*([-.+]?[0-9A-Za-z.]+)?', ver):
        return name, 'exact'
    return name, 'range'


def docker_image(args: list[str]) -> tuple[str | None, list[tuple[str, str]]]:
    """For `docker run ...` args (after `run`): the image and the (flag, value) pairs before it."""
    pairs: list[tuple[str, str]] = []
    i = 0
    while i < len(args):
        a = args[i]
        if not a.startswith('-'):
            return a, pairs
        flag, eq, val = a.partition('=')
        if eq:
            pairs.append((flag, val))
        elif a in DOCKER_BOOL or re.fullmatch(r'-[itdP]+', a):
            pairs.append((a, ''))
        elif i + 1 < len(args):
            pairs.append((a, args[i + 1]))
            i += 1
        i += 1
    return None, pairs


def docker_pin(image: str) -> tuple[str, str]:
    name, digest = image, None
    if '@sha256:' in image:
        name, digest = image.split('@', 1)
    tag = None
    last = name.rsplit('/', 1)[-1]
    if ':' in last:
        tag = last.split(':', 1)[1]
        name = name[: len(name) - len(tag) - 1]
    if digest:
        return name, 'exact'
    if tag is None:
        return name, 'none'
    if tag == 'latest':
        return name, 'latest/tag'
    if re.fullmatch(r'v?\d+\.\d+\.\d+([-.+][0-9A-Za-z.]+)?', tag):
        return name, 'exact'
    return name, 'range'


def url_host(url: str) -> str | None:
    m = re.match(r'^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)', url.strip(), re.I)
    return m.group(1).lower() if m else None


def transport_of(entry: dict) -> str:
    raw = entry.get('type') or entry.get('transport')
    if isinstance(raw, dict):
        raw = raw.get('type')
    if isinstance(raw, str):
        t = raw.lower().replace('_', '-')
        if t == 'stdio':
            return 'stdio'
        if t in ('http', 'streamable-http', 'streamablehttp', 'streamable'):
            return 'http'
        if t == 'sse':
            return 'sse'
        if t in ('ws', 'websocket', 'socket', 'pipe', 'unix'):
            return 'socket/pipe'
        return 'other'
    if isinstance(entry.get('url'), str) or isinstance(entry.get('serverUrl'), str):
        return 'remote, type unstated'
    if isinstance(entry.get('command'), str):
        return 'stdio'
    return 'unclassifiable'


def classify(entry: dict) -> dict:
    """One server entry -> reference type, identity, pin status and risk flags."""
    argv0 = unwrap(argv_of(entry))
    names = [re.split(r'[\\/]', x)[-1] for x in argv0]
    boost = ('artisan' in names and 'boost:mcp' in names) or 'herd-mcp.phar' in names
    out = {'boost': boost, 'transport': transport_of(entry), 'ref': 'unclassifiable', 'id': None, 'pin': None, 'risky': set()}
    url = entry.get('url') or entry.get('serverUrl')
    if isinstance(url, str) and url.strip():
        host = url_host(url)
        local = bool(host and LOCAL_HOSTS.match(host))
        out['ref'] = 'remote URL (local host)' if local else 'remote URL'
        out['id'] = None if local or not host or not re.fullmatch(r'[a-z0-9.-]+', host) else host
        if url.strip().lower().startswith('http://') and not local and host and not PLACEHOLDER.search(host):
            out['risky'].add('http:// to non-local host')
        return out
    argv = unwrap(argv_of(entry))
    if not argv:
        return out
    prog, rest = program(argv[0]), argv[1:]
    if prog in ('npx', 'bunx', 'pnpx') or (prog in ('pnpm', 'yarn', 'bun') and rest[:1] in (['dlx'], ['x'])) \
            or (prog == 'npm' and rest[:1] in (['exec'], ['x'])):
        if prog in ('pnpm', 'yarn', 'bun', 'npm'):
            rest = rest[1:]
        spec, flags = first_positional(rest, NPM_VALUE_FLAGS)
        spec = flags.get('--package') or flags.get('-p') or spec
        out['ref'] = 'npm'
        if spec:
            if spec.startswith(('.', '/', '~')) or spec.endswith(('.js', '.mjs', '.cjs', '.ts')):
                out['ref'] = 'local path'
                return out
            name, version = split_npm(spec)
            if name.lower() in ('tsx', 'ts-node', 'node'):
                out['ref'] = 'local path'
                return out
            out['id'], out['pin'] = name.lower(), npm_pin(version)
        return out
    if prog in ('uvx', 'pipx') or (prog == 'uv' and 'tool' in rest[:3]) :
        if prog == 'pipx' and rest[:1] == ['run']:
            rest = rest[1:]
        if prog == 'uv':
            rest = rest[rest.index('tool') + 2:] if rest[rest.index('tool') + 1:rest.index('tool') + 2] == ['run'] else rest
        spec, flags = first_positional(rest, PY_VALUE_FLAGS)
        spec = flags.get('--from') or flags.get('--spec') or spec
        out['ref'] = 'uvx/PyPI'
        if spec:
            if spec.startswith(('.', '/', '~')):
                out['ref'] = 'local path'
                return out
            out['id'], out['pin'] = py_split(spec)
        return out
    if prog in ('docker', 'podman'):
        if rest[:1] == ['run'] or rest[:2] == ['container', 'run']:
            rest = rest[1:] if rest[0] == 'run' else rest[2:]
            image, pairs = docker_image(rest)
            out['ref'] = 'docker'
            if image:
                out['id'], out['pin'] = docker_pin(image)
            for flag, val in pairs:
                if flag == '--privileged':
                    out['risky'].add('docker --privileged')
                if flag in ('--network', '--net') and val == 'host':
                    out['risky'].add('docker --network host')
                if flag in ('-v', '--volume', '--mount'):
                    src = val
                    if flag == '--mount':
                        m = re.search(r'(?:^|,)(?:source|src)=([^,]+)', val)
                        src = m.group(1) if m else ''
                    else:
                        src = val.split(':', 1)[0] if not re.match(r'^[A-Za-z]:\\', val) else val[:2]
                    if re.fullmatch(r'/|~/?|\$HOME/?|\$\{HOME\}/?|%USERPROFILE%|/home/[^/]+/?|/Users/[^/]+/?|/root/?|[A-Za-z]:\\?', src):
                        out['risky'].add('docker mount of $HOME or /')
        else:
            out['ref'] = 'docker'
        return out
    if argv[0].startswith(('.', '/', '~', '$', '%')) or re.match(r'^[A-Za-z]:\\', argv[0]) or '/' in argv[0] or '\\' in argv[0]:
        out['ref'] = 'local path'
        return out
    if prog in ('node', 'python', 'python3', 'deno', 'bun', 'tsx', 'ts-node', 'uv', 'java', 'dotnet', 'go', 'ruby', 'php'):
        out['ref'] = 'local path'
        return out
    out['ref'] = 'other command on PATH'
    out['id'] = None
    return out


# ---------------------------------------------------------------- stats


def pct(a: int, b: int) -> str:
    return '—' if b == 0 else f'{100 * a / b:.1f}%'


def quart(values: list[float]) -> tuple[float, float, float]:
    if len(values) < 2:
        v = values[0] if values else float('nan')
        return v, v, v
    q = statistics.quantiles(values, n=4, method='inclusive')
    return q[0], statistics.median(values), q[2]


def fmt(x: float) -> str:
    return f'{x:,.0f}' if float(x).is_integer() else f'{x:,.1f}'


def table(head: list[str], rows: list[list], right: set[int] | None = None) -> str:
    right = right if right is not None else set(range(1, len(head)))
    lines = ['| ' + ' | '.join(head) + ' |',
             '| ' + ' | '.join('---:' if i in right else '---' for i in range(len(head))) + ' |']
    lines += ['| ' + ' | '.join(str(c) for c in r) + ' |' for r in rows]
    return '\n'.join(lines)


def band_of(stars: int) -> str:
    for lo, hi, label in STAR_BANDS:
        if stars >= lo and (hi is None or stars <= hi):
            return label
    return '?'


def days(a: str, b: str) -> float:
    pa = datetime.fromisoformat(a.replace('Z', '+00:00'))
    pb = datetime.fromisoformat(b.replace('Z', '+00:00'))
    return (pb - pa).total_seconds() / 86400


# ---------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', default=str(Path(__file__).resolve().parent / 'corpus'))
    ap.add_argument('--out', default=None)
    opts = ap.parse_args()
    root = Path(opts.corpus)
    out_path = Path(opts.out) if opts.out else Path(__file__).resolve().parent / 'output' / 'findings-run1.md'

    runs = load_jsonl(root / 'runs.jsonl')
    responses = load_jsonl(root / 'responses.jsonl')
    repos = {r['full_name']: r for r in load_jsonl(root / 'repos.jsonl')}
    files = load_jsonl(root / 'files.jsonl')
    redactions = load_jsonl(root / 'redactions.jsonl')
    sampling = load_jsonl(root / 'sampling.jsonl')

    run = runs[-1]
    partial = any(r['status'] != 'complete' for r in runs)
    run_date = run['started_at'][:10]
    tag = f'{"partial run, " if partial else ""}collected {run_date}'

    for f in files:
        f['target'] = TARGET_OF[(f['kind'], f['client'])]
        f['text'] = (root / 'files' / f['repo'] / f['path']).read_text(encoding='utf-8', errors='replace')

    # C-7: one representative per normalized content hash, the first collected.
    first_by_hash: dict[str, dict] = {}
    for f in files:
        first_by_hash.setdefault(f['content_hash'], f)
    dedup = list(first_by_hash.values())
    dedup_ids = {id(f) for f in dedup}

    L: list[str] = []
    w = L.append

    # ------------------------------------------------------------ header
    w('# DriftMark corpus study: first collection run')
    w('')
    w(f'Generated by `study/analyze.py` on {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")} '
      'from `study/corpus/`. Every number in this document was computed by that script (A-2); '
      'none was typed by hand. Question IDs refer to `study/plan.md` §6, rule IDs to `study/rules.md`.')
    w('')
    if partial:
        w(f'> **Partial run (C-8, P-15).** The collector recorded this run as `{run["status"]}` '
          f'(stop reason: `{run["stop_reason"]}`). It stopped on the 5,000-file cap from plan §9, which is the '
          'planned stop condition, but the run is still recorded as partial, so every figure below is a '
          'partial-run figure, and the `N` lines say so.')
        w('')
    w('> **Scope (S-1).** Every figure describes this corpus only, not GitHub or the ecosystem. The sample '
      'is a balanced, relevance-capped draw (see Method), so prevalence across file types is mostly set by '
      'the design rather than observed.')
    w('')
    w('> **Disclosure (P-8, P-9, P-13).** No repository, owner or maintainer is named, and credential-shaped '
      'values appear only as counts by detector type.')
    w('')

    # ------------------------------------------------------------ run record
    incomplete = sum(1 for r in responses if r.get('incomplete_results'))
    slices = {r['slice_id'] for r in responses}
    owners = {f['owner'] for f in files}
    dedup_owners = {f['owner'] for f in dedup}
    w('## 1. Run record')
    w('')
    w(table(['Field', 'Value'], [
        ['Collection window (UTC)', f'{run["started_at"][:16].replace("T", " ")} to {run["ended_at"][:16].replace("T", " ")}'],
        ['Run status (C-8)', f'{run["status"]} (stop reason `{run["stop_reason"]}`)'],
        ['Sampling method', f'{sampling[-1]["method"]}, file cap {sampling[-1]["file_cap"]:,}' if sampling else '—'],
        ['Search slices queried', f'{len(slices):,}'],
        ['Search result pages fetched', f'{len(responses):,}'],
        ['Pages with `incomplete_results: true` (C-4)', f'{incomplete:,} of {len(responses):,}'],
        ['Repositories expanded', f'{len(repos):,}'],
        ['Repositories with a truncated tree', f'{sum(1 for r in repos.values() if r.get("tree_truncated")):,}'],
        ['Distinct owners', f'{len(owners):,}'],
        ['Config-class files, raw', f'{len(files):,}'],
        ['Config-class files, deduplicated by content hash (S-4)', f'{len(dedup):,}'],
        ['Files surfaced by a search hit / found by tree expansion', f'{sum(1 for f in files if f["surfaced_by"]["via"] == "search"):,} / {sum(1 for f in files if f["surfaced_by"]["via"] == "tree"):,}'],
        ['Documentation-class blocks (S-7)', 'not collected in v1 (plan §5)'],
        ['Redacted credential-shaped values', f'{len(redactions):,} in {len({(r["repo"], r["path"]) for r in redactions}):,} files'],
    ], right=set()))
    w('')

    # ------------------------------------------------------------ method
    w('## 2. Method and known biases (S-3)')
    w('')
    w('- **Discovery.** GitHub code search, one query per target path × size band (10 targets × 4 bands = '
      f'{len(slices)} slices), forks excluded, each slice paged until exhausted or the 1,000-result cap. '
      'Search returns a relevance-ranked slice, not the population: what lies past the cap is never seen.')
    w('- **Expansion.** Queued repositories were expanded in a seeded, stratified draw (plan §5, Expansion order): '
      'each draw went to the target with the fewest files so far, then to the size band least drawn relative '
      'to its search total, then to a hash-ordered repository in that band. Expansion reads the whole '
      'default-branch tree, so a repository drawn for one target contributes every target file it holds.')
    w('- **Balance is by design.** Because the draw equalizes targets, the file counts per target and the '
      'client mix (Q1, Q4) mostly reflect the quota, not how common each file type is. Search `total_count` '
      'per target (Q1) is the better signal of relative prevalence, with its own caveats.')
    w('- **Overshoot on multi-file targets.** Skills and Cursor rules come many to a repository, so one draw '
      'can add dozens of files; those targets end above their share.')
    w('- **Search-term requirement.** Each query needs a content term (`mcpServers`, `servers`, `permissions`, '
      '`description`, `claude`, `agents`, `copilot`), so a file lacking it is found only through another hit in '
      'its repository.')
    w('- **Default branch only**, and truncated trees can miss files. Stars and push dates are as of collection.')
    w('- **Deduplication (C-7).** Headline per-file figures use one file per normalized content hash (the redacted '
      'text with CRLF normalized), keeping the first collected. Raw figures are shown alongside and labeled. '
      'Owner-level figures count distinct owners.')
    w('- **Credential detection** is pattern-based only and nothing was validated against a live service (D-4). '
      'The `keyed-literal` detector flags any literal assigned to a key named like a secret, so some hits are '
      'likely placeholders or dummy values rather than real credentials (S-9).')
    w('- **No significance testing** (plan §7). Cross-band comparisons are descriptive.')
    w('')

    # ------------------------------------------------------------ MCP parse
    mcp_files = [f for f in files if f['kind'] == 'mcp']
    parsed: dict[int, dict] = {}
    unparsable = 0
    for f in mcp_files:
        cfg = parse_mcp(f['text'])
        if cfg is None:
            unparsable += 1
            continue
        servers = servers_of(cfg)
        entries = []
        for name, entry in (servers or {}).items():
            if not isinstance(entry, dict):
                continue
            c = classify(entry)
            c['name'] = name
            c['env_cred'] = Counter()
            for field in ('env', 'headers'):
                block = entry.get(field)
                if isinstance(block, dict):
                    for v in block.values():
                        if isinstance(v, str):
                            c['env_cred'].update(PLACEHOLDER.findall(v))
            entries.append(c)
        parsed[id(f)] = {'has_map': servers is not None, 'entries': entries,
                         'any_cred': Counter(PLACEHOLDER.findall(f['text']))}
    mcp_dedup = [f for f in mcp_files if id(f) in dedup_ids and id(f) in parsed]
    mcp_raw = [f for f in mcp_files if id(f) in parsed]

    # ------------------------------------------------------------ decision inputs (filled later)
    decision: dict[str, tuple[str, str]] = {}

    # ------------------------------------------------------------ Q1
    w('## 3. Prevalence and shape')
    w('')
    w('### Q1. Config-class files by path type')
    w('')
    totals = defaultdict(int)
    for r in responses:
        if r['page'] == 1:
            totals[r['slice_id'].split('@', 1)[0]] += r['total_count']
    rows = []
    for pattern, kind, client in TARGETS:
        fs = [f for f in files if f['target'] == pattern]
        ds = [f for f in dedup if f['target'] == pattern]
        rows.append([f'`{pattern}`', f'{len(ds):,}', f'{len(fs):,}', f'{len({f["repo"] for f in fs}):,}',
                     f'{len({f["owner"] for f in fs}):,}', f'{totals.get(pattern, 0):,}'])
    rows.append(['**All**', f'**{len(dedup):,}**', f'{len(files):,}', f'{len({f["repo"] for f in files}):,}',
                 f'{len(owners):,}', f'{sum(totals.values()):,}'])
    w(f'N = {len(files):,} files raw, {len(dedup):,} deduplicated, from {len(repos):,} repositories ({tag}).')
    w('')
    w(table(['Target', 'Files (dedup)', 'Files (raw)', 'Repos', 'Owners', 'Search total_count'], rows))
    w('')
    w('`Search total_count` is the sum of GitHub\'s reported `total_count` over the four size bands on each '
      'target\'s first page: an estimate from code search, not a count of files collected, and subject to the '
      'search-term requirement above.')
    w('')
    decision['gate'] = (f'{len(dedup):,} dedup ({len(files):,} raw)',
                        'build' if len(dedup) >= 1000 else ('don\'t build' if len(dedup) < 300 else 'between'))

    # ------------------------------------------------------------ Q2
    w('### Q2. Servers per MCP config')
    w('')
    counts_d = [len(parsed[id(f)]['entries']) for f in mcp_dedup]
    counts_r = [len(parsed[id(f)]['entries']) for f in mcp_raw]
    q1d, medd, q3d = quart(counts_d)
    q1r, medr, q3r = quart(counts_r)
    w(f'N = {len(mcp_dedup):,} parseable MCP configs deduplicated, {len(mcp_raw):,} raw '
      f'({unparsable} of {len(mcp_files):,} raw MCP files could not be parsed even as JSONC and are excluded) ({tag}).')
    w('')
    w(table(['', 'Median', 'IQR', 'Max', 'Configs with 0 servers', 'Configs with 1', 'Configs with ≥ 2'], [
        ['Deduplicated', fmt(medd), f'{fmt(q1d)}–{fmt(q3d)}', max(counts_d, default=0),
         f'{sum(c == 0 for c in counts_d):,} ({pct(sum(c == 0 for c in counts_d), len(counts_d))})',
         f'{sum(c == 1 for c in counts_d):,} ({pct(sum(c == 1 for c in counts_d), len(counts_d))})',
         f'{sum(c >= 2 for c in counts_d):,} ({pct(sum(c >= 2 for c in counts_d), len(counts_d))})'],
        ['Raw', fmt(medr), f'{fmt(q1r)}–{fmt(q3r)}', max(counts_r, default=0),
         f'{sum(c == 0 for c in counts_r):,}', f'{sum(c == 1 for c in counts_r):,}', f'{sum(c >= 2 for c in counts_r):,}'],
    ]))
    w('')
    rows = []
    for client in MCP_CLIENTS:
        cs = [len(parsed[id(f)]['entries']) for f in mcp_dedup if f['client'] == client]
        a, m, b = quart(cs) if cs else (0, 0, 0)
        rows.append([f'`{TARGET_OF[("mcp", client)]}`', f'{len(cs):,}', fmt(m), f'{fmt(a)}–{fmt(b)}', max(cs, default=0)])
    w('By target, deduplicated:')
    w('')
    w(table(['Target', 'N configs', 'Median', 'IQR', 'Max'], rows))
    w('')
    decision['servers'] = (f'{fmt(medd)} (N = {len(mcp_dedup):,})',
                           'build' if medd >= 2 else ('don\'t build' if medd <= 1 else 'between'))

    # ------------------------------------------------------------ Q3
    w('### Q3. Transport mix')
    w('')
    ents_d = [e for f in mcp_dedup for e in parsed[id(f)]['entries']]
    ents_r = [e for f in mcp_raw for e in parsed[id(f)]['entries']]
    tc_d, tc_r = Counter(e['transport'] for e in ents_d), Counter(e['transport'] for e in ents_r)
    w(f'N = {len(ents_d):,} server entries in deduplicated configs, {len(ents_r):,} raw ({tag}).')
    w('')
    order = ['stdio', 'http', 'sse', 'remote, type unstated', 'socket/pipe', 'other', 'unclassifiable']
    w(table(['Transport', 'Entries (dedup)', 'Share (dedup)', 'Entries (raw)'],
            [[t, f'{tc_d[t]:,}', pct(tc_d[t], len(ents_d)), f'{tc_r[t]:,}'] for t in order if tc_d[t] or tc_r[t]]))
    w('')
    w('`stdio` includes entries with a `command` and no stated type. `http` includes `streamable-http`. '
      '`remote, type unstated` is a `url` with no `type`, which clients resolve differently.')
    w('')

    # ------------------------------------------------------------ Q4
    w('### Q4. Client mix')
    w('')
    w('Shaped by the balanced draw: these figures are what the quota produced, not relative popularity '
      '(see Q1 search totals for that).')
    w('')
    rows = []
    for client in ['claude-code', 'cursor', 'vscode', 'junie', 'agents-md', 'copilot']:
        fs = [f for f in files if f['client'] == client]
        ds = [f for f in dedup if f['client'] == client]
        ms = [f for f in mcp_files if f['client'] == client]
        rows.append([client, f'{len(ds):,}', f'{len(fs):,}', f'{len({f["repo"] for f in fs}):,}',
                     f'{len(ms):,}', f'{len({f["repo"] for f in ms}):,}'])
    w(f'N = {len(files):,} files raw ({len(dedup):,} dedup) in {len(repos):,} repositories ({tag}).')
    w('')
    w(table(['Client', 'All files (dedup)', 'All files (raw)', 'Repos', 'MCP configs (raw)', 'Repos with an MCP config'], rows))
    w('')
    w('`agents-md` is `AGENTS.md`, a convention several clients read, not one client\'s file. Claude Code '
      'counts `.mcp.json`, `.claude/settings.json`, skills and `CLAUDE.md`.')
    w('')

    # ------------------------------------------------------------ Q5
    w('## 4. Supply-chain hygiene')
    w('')
    w('### Q5. Reference targets by type')
    w('')
    rc_d, rc_r = Counter(e['ref'] for e in ents_d), Counter(e['ref'] for e in ents_r)
    w(f'N = {len(ents_d):,} server entries (dedup), {len(ents_r):,} raw ({tag}).')
    w('')
    w(table(['Reference type', 'Entries (dedup)', 'Share (dedup)', 'Entries (raw)'],
            [[t, f'{c:,}', pct(c, len(ents_d)), f'{rc_r[t]:,}'] for t, c in rc_d.most_common()]))
    w('')
    w('`local path` covers a script or binary in the repository or on the machine, including `node`, `python`, '
      '`uv run` and similar runtimes pointed at a local file. `other command on PATH` is a bare executable name '
      'that is not a package runner. Wrappers such as `cmd /c` and `bash -c` are unwrapped first.')
    w('')

    boost_cfg = [f for f in mcp_dedup if any(e['boost'] for e in parsed[id(f)]['entries'])]
    boost_only = [f for f in boost_cfg if len(parsed[id(f)]['entries']) == 1]
    boost_ents = sum(1 for e in ents_d if e['boost'])
    rest = [len(parsed[id(f)]['entries']) for f in mcp_dedup if f not in boost_cfg]
    ra, rm, rb = quart(rest)
    w('**Exploratory (S-8): framework-generated configs.** Not a pre-registered metric; added after seeing '
      f'that `php` dominates the local-path entries. {boost_ents:,} of {len(ents_d):,} deduplicated entries '
      f'({pct(boost_ents, len(ents_d))}) run `artisan boost:mcp` or `herd-mcp.phar`: Laravel tooling, whose Boost '
      f'package installs its MCP server by writing it into each detected client\'s config, alongside Herd\'s '
      f'where Herd is present. {len(boost_cfg):,} of {len(mcp_dedup):,} deduplicated MCP '
      f'configs ({pct(len(boost_cfg), len(mcp_dedup))}) contain it, and in {len(boost_only):,} it is the only '
      f'server. Excluding configs that contain it, servers per config are median {fmt(rm)}, IQR '
      f'{fmt(ra)}–{fmt(rb)} (N = {len(rest):,}, {tag}). By target, configs containing it:')
    w('')
    w(table(['Target', 'Configs with Laravel tooling', 'Configs (dedup)'],
            [[f'`{TARGET_OF[("mcp", c)]}`', f'{sum(1 for f in boost_cfg if f["client"] == c):,}',
              f'{sum(1 for f in mcp_dedup if f["client"] == c):,}'] for c in MCP_CLIENTS]))
    w('')
    w('This is a competing explanation for the low median in Q2 and the uniform Junie configs (S-9): a '
      'large share of the MCP configs here were written by one installer rather than by hand.')
    w('')

    # ------------------------------------------------------------ Q6
    w('### Q6. Pinning')
    w('')
    pin_types = ['npm', 'uvx/PyPI', 'docker']
    pins_d = [e for e in ents_d if e['ref'] in pin_types and e['pin']]
    pins_r = [e for e in ents_r if e['ref'] in pin_types and e['pin']]
    w(f'N = {len(pins_d):,} package references (npm, uvx/PyPI, docker) in deduplicated configs, '
      f'{len(pins_r):,} raw ({tag}). Local paths and URLs carry no version and are excluded.')
    w('')
    rows = []
    for t in pin_types + ['All']:
        es = pins_d if t == 'All' else [e for e in pins_d if e['ref'] == t]
        c = Counter(e['pin'] for e in es)
        rows.append([f'**{t}**' if t == 'All' else t, f'{len(es):,}',
                     *[f'{c[p]:,} ({pct(c[p], len(es))})' for p in ('exact', 'range', 'latest/tag', 'none')]])
    w(table(['Type', 'N', 'Exact version or digest', 'Range', '@latest or other tag', 'Nothing'], rows))
    w('')
    unpinned_d = sum(e['pin'] != 'exact' for e in pins_d)
    unpinned_r = sum(e['pin'] != 'exact' for e in pins_r)
    w(f'Unpinned (anything but exact): {unpinned_d:,} of {len(pins_d):,} deduplicated references '
      f'({pct(unpinned_d, len(pins_d))}); raw {unpinned_r:,} of {len(pins_r):,} ({pct(unpinned_r, len(pins_r))}).')
    w('')
    w('Docker tags that look like exact versions count as exact here, although tags are mutable; only a '
      '`@sha256:` digest is immutable. For npm, a bare `-y package` runs whatever the registry serves at '
      'that moment.')
    w('')
    rate = unpinned_d / len(pins_d) if pins_d else 0
    decision['unpinned'] = (f'{pct(unpinned_d, len(pins_d))} (N = {len(pins_d):,})',
                            'build' if rate >= 0.40 else ('don\'t build' if rate < 0.15 else 'between'))

    # ------------------------------------------------------------ Q7
    w('### Q7. Top 50 servers by frequency')
    w('')
    by_id: dict[tuple[str, str], dict] = defaultdict(lambda: {'configs': set(), 'owners': set()})
    for f in mcp_dedup:
        for e in parsed[id(f)]['entries']:
            if e['id'] and e['ref'] in ('npm', 'uvx/PyPI', 'docker', 'remote URL') and not PLACEHOLDER.search(e['id']):
                slot = by_id[(e['ref'], e['id'])]
                slot['configs'].add(f['content_hash'])
                slot['owners'].add(f['owner'])
    ranked = sorted(((k, v) for k, v in by_id.items() if len(v['owners']) >= 2),
                    key=lambda kv: (-len(kv[1]['owners']), -len(kv[1]['configs']), kv[0][1]))[:50]
    w(f'N = {len(mcp_dedup):,} deduplicated MCP configs ({tag}). Ranked by the number of distinct owners '
      'referencing the server, then by configs. Identity is the npm or PyPI package name without version, the '
      'docker image without tag, or the hostname of a remote URL. Only servers seen under at least two '
      'distinct owners are listed, so that no single owner\'s private package or host is identifiable.')
    w('')
    w(table(['#', 'Server', 'Type', 'Owners', 'Configs (dedup)'],
            [[i + 1, f'`{k[1]}`', k[0], len(v['owners']), len(v['configs'])] for i, (k, v) in enumerate(ranked)],
            right={0, 3, 4}))
    w('')
    w(f'{len(by_id):,} distinct server identities in total; '
      f'{sum(1 for v in by_id.values() if len(v["owners"]) == 1):,} were seen under a single owner only.')
    w('')

    # ------------------------------------------------------------ Q8
    w('### Q8. Credential-shaped literals in MCP configs')
    w('')
    cred_env_d = [f for f in mcp_dedup if any(e['env_cred'] for e in parsed[id(f)]['entries'])]
    cred_env_r = [f for f in mcp_raw if any(e['env_cred'] for e in parsed[id(f)]['entries'])]
    cred_any_d = [f for f in mcp_dedup if parsed[id(f)]['any_cred']]
    w(f'N = {len(mcp_dedup):,} deduplicated MCP configs, {len(mcp_raw):,} raw ({tag}).')
    w('')
    w(f'- With at least one credential-shaped literal in `env` or `headers`: **{len(cred_env_d):,} of '
      f'{len(mcp_dedup):,} ({pct(len(cred_env_d), len(mcp_dedup))})**; raw {len(cred_env_r):,} of '
      f'{len(mcp_raw):,} ({pct(len(cred_env_r), len(mcp_raw))}).')
    w(f'- With one anywhere in the file (including `args` and URLs): {len(cred_any_d):,} of {len(mcp_dedup):,} '
      f'({pct(len(cred_any_d), len(mcp_dedup))}).')
    w('')
    det = Counter()
    for f in cred_env_d:
        det.update({d for e in parsed[id(f)]['entries'] for d in e['env_cred']})
    w('Deduplicated configs with an `env`/`headers` hit, by detector (a config can appear under more than one):')
    w('')
    w(table(['Detector', 'Configs'], [[d, f'{c:,}'] for d, c in det.most_common()]))
    w('')
    rate = len(cred_env_d) / len(mcp_dedup) if mcp_dedup else 0
    decision['creds'] = (f'{pct(len(cred_env_d), len(mcp_dedup))} (N = {len(mcp_dedup):,})',
                         'build' if rate >= 0.03 else ('don\'t build' if rate < 0.01 else 'between'))
    w('Across all config-class files, not only MCP configs (redaction records, raw):')
    w('')
    by_kind = defaultdict(set)
    for r in redactions:
        f = next((x for x in files if x['repo'] == r['repo'] and x['path'] == r['path']), None)
        if f:
            by_kind[f['target']].add((r['repo'], r['path']))
    det_all = Counter((r['detector'], r['value_type']) for r in redactions)
    w(table(['Target', 'Files with ≥ 1 redaction', 'Files collected'],
            [[f'`{p}`', f'{len(by_kind[p]):,}', f'{sum(1 for f in files if f["target"] == p):,}'] for p, _, _ in TARGETS]))
    w('')
    w(table(['Detector', 'Value type', 'Values redacted'], [[d, t, f'{c:,}'] for (d, t), c in det_all.most_common()],
            right={2}))
    w('')

    # ------------------------------------------------------------ Q9
    w('## 5. Governance signals')
    w('')
    w('### Q9. Pinning and credential rates by stars band')
    w('')
    w('Descriptive only; the sample is not random and no significance test is applied (plan §7).')
    w('')
    rows = []
    for _, _, label in STAR_BANDS:
        fs = [f for f in mcp_dedup if band_of(repos[f['repo']]['stars']) == label]
        ps = [e for f in fs for e in parsed[id(f)]['entries'] if e['ref'] in pin_types and e['pin']]
        cr = [f for f in fs if any(e['env_cred'] for e in parsed[id(f)]['entries'])]
        rows.append([label, f'{len({f["repo"] for f in fs}):,}', f'{len(fs):,}', f'{len(ps):,}',
                     pct(sum(e['pin'] != 'exact' for e in ps), len(ps)), pct(len(cr), len(fs))])
    w(f'N = {len(mcp_dedup):,} deduplicated MCP configs ({tag}); each row states its own N.')
    w('')
    w(table(['Stars', 'Repos', 'Configs (N)', 'Package refs (N)', 'Unpinned', 'Configs with env/headers credential'], rows))
    w('')

    # ------------------------------------------------------------ Q10
    w('### Q10. Repositories with MCP configs for two or more clients')
    w('')
    per_repo: dict[str, dict[str, dict]] = defaultdict(dict)
    for f in mcp_raw:
        per_repo[f['repo']][f['client']] = parsed[id(f)]
    multi = {r: c for r, c in per_repo.items() if len(c) >= 2}
    diff_names = sum(1 for c in multi.values() if len({frozenset(e['name'] for e in p['entries']) for p in c.values()}) > 1)
    diff_ids = sum(1 for c in multi.values()
                   if len({frozenset(e['id'] or f'name:{e["name"]}' for e in p['entries']) for p in c.values()}) > 1)
    w(f'N = {len(multi):,} repositories with parseable MCP configs for 2+ clients, out of '
      f'{len(per_repo):,} with any ({tag}).')
    w('')
    w(f'- Server **names** differ between the clients\' configs: **{diff_names:,} of {len(multi):,} '
      f'({pct(diff_names, len(multi))})**.')
    w(f'- Server **identities** (package, image or host; name where none) differ: {diff_ids:,} of {len(multi):,} '
      f'({pct(diff_ids, len(multi))}).')
    w('')
    combos = Counter(' + '.join(sorted(c)) for c in multi.values())
    w(table(['Client combination', 'Repos'], [[k, f'{v:,}'] for k, v in combos.most_common()]))
    w('')
    rate = diff_names / len(multi) if multi else 0
    decision['diverge'] = (f'{pct(diff_names, len(multi))} (N = {len(multi):,})',
                           'build' if rate >= 0.20 else ('don\'t build' if rate < 0.05 else 'between'))

    # ------------------------------------------------------------ Q11
    w('### Q11. Staleness')
    w('')
    w('Days between the last commit touching the config file and the repository\'s last push '
      '(`pushed_at`, which counts pushes to any branch: a proxy for the last commit to the repository).')
    w('')
    rows = []
    mcp_lag = []
    all_lag = []
    for pattern, _, _ in TARGETS:
        lags = [max(0.0, days(f['last_commit_at'], repos[f['repo']]['pushed_at']))
                for f in dedup if f['target'] == pattern and f.get('last_commit_at')]
        all_lag += lags
        if pattern in [TARGET_OF[('mcp', c)] for c in MCP_CLIENTS]:
            mcp_lag += lags
        a, m, b = quart(lags) if lags else (0, 0, 0)
        rows.append([f'`{pattern}`', f'{len(lags):,}', fmt(m), f'{fmt(a)}–{fmt(b)}',
                     pct(sum(x > 90 for x in lags), len(lags))])
    a, m, b = quart(mcp_lag)
    rows.append(['**All MCP configs**', f'{len(mcp_lag):,}', fmt(m), f'{fmt(a)}–{fmt(b)}', pct(sum(x > 90 for x in mcp_lag), len(mcp_lag))])
    a2, m2, b2 = quart(all_lag)
    rows.append(['**All files**', f'{len(all_lag):,}', fmt(m2), f'{fmt(a2)}–{fmt(b2)}', pct(sum(x > 90 for x in all_lag), len(all_lag))])
    w(f'N = deduplicated files with a known last commit ({tag}); each row states its own N.')
    w('')
    w(table(['Target', 'N', 'Median lag (days)', 'IQR (days)', 'Lag > 90 days'], rows))
    w('')
    ages = [days(f['last_commit_at'], run['started_at']) for f in mcp_dedup if f.get('last_commit_at')]
    repo_ages = [days(repos[f['repo']]['pushed_at'], run['started_at']) for f in mcp_dedup if f.get('last_commit_at')]
    w(f'For MCP configs, median days since the config last changed: {fmt(statistics.median(ages))}; '
      f'median days since the repository was last pushed: {fmt(statistics.median(repo_ages))} '
      f'(N = {len(ages):,}, {tag}).')
    w('')
    decision['stale'] = (f'median lag {fmt(m)} days; {pct(sum(x > 90 for x in mcp_lag), len(mcp_lag))} > 90 days '
                         f'(N = {len(mcp_lag):,})', 'judgment (no numeric threshold in plan §2)')

    # ------------------------------------------------------------ Q12
    w('### Q12. Risky invocation patterns')
    w('')
    risk_d = Counter()
    risk_cfg = Counter()
    for f in mcp_dedup:
        seen = set()
        for e in parsed[id(f)]['entries']:
            risk_d.update(e['risky'])
            seen |= e['risky']
        risk_cfg.update(seen)
    docker_d = sum(1 for e in ents_d if e['ref'] == 'docker')
    remote_d = sum(1 for e in ents_d if e['ref'] == 'remote URL')
    w(f'N = {len(ents_d):,} server entries in {len(mcp_dedup):,} deduplicated MCP configs '
      f'({docker_d:,} docker entries, {remote_d:,} non-local remote URLs) ({tag}).')
    w('')
    pats = ['docker mount of $HOME or /', 'docker --privileged', 'docker --network host', 'http:// to non-local host']
    w(table(['Pattern', 'Entries', 'Configs'], [[p, f'{risk_d[p]:,}', f'{risk_cfg[p]:,}'] for p in pats]))
    w('')
    w('A home or root mount means the mount source is exactly `/`, `~`, `$HOME`, `${HOME}`, `/root`, '
      '`/home/<user>`, `/Users/<user>` or a bare Windows drive. Local hosts are `localhost`, `127.x`, `0.0.0.0`, '
      '`::1` and `host.docker.internal`.')
    w('')

    # ------------------------------------------------------------ Q13
    w('## 6. Skills and instruction files')
    w('')
    w('### Q13. Repositories shipping skills or Cursor rules')
    w('')
    rows = []
    for pattern in ('.claude/skills/**/SKILL.md', '.cursor/rules/**'):
        per = Counter(f['repo'] for f in files if f['target'] == pattern)
        vals = list(per.values())
        a, m, b = quart(vals) if vals else (0, 0, 0)
        rows.append([f'`{pattern}`', f'{len(per):,}', f'{sum(vals):,}', fmt(m), f'{fmt(a)}–{fmt(b)}', max(vals, default=0),
                     pct(sum(v >= 10 for v in vals), len(vals))])
    w(f'Of {len(repos):,} repositories expanded ({tag}). Counts are raw files per repository (a repository\'s '
      'own files are not duplicates of each other in any meaningful sense, though identical copies are '
      'possible).')
    w('')
    w(table(['Target', 'Repos with ≥ 1', 'Files (raw)', 'Median per repo', 'IQR', 'Max', 'Repos with ≥ 10'], rows))
    w('')
    w('How many repositories ship them is set by the draw (each target got a quota), so the repo counts are '
      'not a prevalence figure; files per repository is.')
    w('')

    # ------------------------------------------------------------ Q14
    w('### Q14. Size of instruction files')
    w('')
    rows = []
    for pattern in ('CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md', '.claude/skills/**/SKILL.md', '.cursor/rules/**'):
        sizes = sorted(f['size'] for f in dedup if f['target'] == pattern)
        if not sizes:
            continue
        a, m, b = quart(sizes)
        p90 = statistics.quantiles(sizes, n=10, method='inclusive')[8] if len(sizes) > 1 else sizes[0]
        rows.append([f'`{pattern}`', f'{len(sizes):,}', fmt(m), f'{fmt(a)}–{fmt(b)}', fmt(p90), f'{max(sizes):,}'])
    w(f'Bytes, deduplicated files ({tag}); each row states its own N.')
    w('')
    w(table(['Target', 'N', 'Median', 'IQR', 'p90', 'Max'], rows))
    w('')
    w('Search was sliced by size band and the draw balanced bands by their search totals, so this '
      'distribution is shaped by the bands as well as by the files.')
    w('')
    per_repo_bytes = defaultdict(int)
    for f in files:
        if f['kind'] in ('instructions', 'skill', 'rules'):
            per_repo_bytes[f['repo']] += f['size']
    vals = list(per_repo_bytes.values())
    a, m, b = quart(vals)
    w(f'Per repository, total bytes across all its instruction, skill and rules files (raw): median {fmt(m)}, '
      f'IQR {fmt(a)}–{fmt(b)}, max {max(vals):,} (N = {len(vals):,} repositories, {tag}).')
    w('')

    # ------------------------------------------------------------ decision
    w('## 7. Against the decision criteria (plan §2)')
    w('')
    w(f'Observed values from the sections above ({tag}). The first row is a gate; at least three of the '
      'other five must land on the build side.')
    w('')
    w(table(['Signal', 'Build', 'Don\'t build', 'Observed', 'Side'], [
        ['Config-class files collected (gate)', '≥ 1,000', '< 300', *decision['gate']],
        ['Median servers per config', '≥ 2', '1', *decision['servers']],
        ['Unpinned reference rate', '≥ 40%', '< 15%', *decision['unpinned']],
        ['Configs with credential-shaped env value', '≥ 3%', '< 1%', *decision['creds']],
        ['Repos with 2+ client configs that disagree', '≥ 20%', '< 5%', *decision['diverge']],
        ['Median config age vs repo age', 'staler', 'tracks repo', *decision['stale']],
    ], right=set()))
    w('')
    builds = sum(1 for k in ('servers', 'unpinned', 'creds', 'diverge') if decision[k][1] == 'build')
    w(f'Non-gate rows on the build side by their numeric thresholds: {builds} of 4, plus the staleness row, '
      'which the plan leaves to judgment. The gate row counts every config-class target, as plan §5 defines '
      'config-class; the decision itself is the owner\'s to record in `study/results.md`.')
    w('')
    w('Priors (plan §3) for calibration: median servers per config 3, unpinned rate 70%, credential-shaped '
      'values in env 5%, multi-client divergence 40%.')
    w('')

    text = '\n'.join(L)
    if '<REDACTED' in text:
        raise SystemExit('refusing to write: a redaction placeholder reached the output')
    out_path.write_text(text)
    print(f'wrote {out_path} ({len(text):,} chars)')


if __name__ == '__main__':
    main()
