#!/usr/bin/env bash
#
# Apply the Warda plugin to a KeeperHub checkout, and survive their drift.
#
#     ./apply.sh /path/to/keeperhub
#
# KeeperHub moves fast — 403 commits in the twelve days between the first
# version of this patch and the second. What goes stale is never the plugin: it
# is the three SHARED, SORTED lists that every other plugin author also edits —
# the allowlist, the integration union, and the generated plugins/index.ts.
# Taking those by patch context is the one thing guaranteed to break.
#
# So this applies only the files that are ours, by name, and derives the rest
# the way their own tooling does. Every edit is idempotent; re-running is safe.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
patch="$here/warda-keeperhub-plugin.patch"
target=${1:-}

if [ -z "$target" ]; then
  echo "usage: $0 /path/to/keeperhub" >&2
  exit 2
fi
if [ ! -f "$target/plugins/plugin-allowlist.json" ]; then
  echo "$target does not look like a KeeperHub checkout" >&2
  exit 2
fi
if [ ! -f "$patch" ]; then
  echo "missing $patch" >&2
  exit 2
fi

cd "$target"
echo "keeperhub at $(git rev-parse --short HEAD), $(git log -1 --format=%cd --date=short)"

# 1. The files that are ours, taken by name rather than by context. git apply
#    refuses to create a file that exists, so a second run skips this rather
#    than failing — the point of the script is that re-running it is safe.
if [ -e plugins/warda/index.ts ]; then
  echo "applied: plugins/warda already present, left alone"
else
  git apply --include='plugins/warda/*' \
            --include='tests/unit/warda-check-authority.test.ts' "$patch"
  echo "applied: plugins/warda and its tests"
fi

# 2. The two hand-maintained lists.
python3 - <<'PY'
import io, json, re

changed = []

p = "plugins/plugin-allowlist.json"
data = json.loads(io.open(p, encoding="utf-8").read())
names = data["plugins"] if isinstance(data, dict) and "plugins" in data else data
if "warda" not in names:
    names.append("warda")
    names.sort()
    io.open(p, "w", encoding="utf-8").write(json.dumps(data, indent=2) + "\n")
    changed.append("allowlist")

p = "lib/types/integration.ts"
s = io.open(p, encoding="utf-8").read()
if not re.search(r'^  \| "warda"$', s, re.M):
    m = re.search(r'^( \* Generated types: )(.+)$', s, re.M)
    if m:
        gen = [n.strip() for n in m.group(2).split(",")]
        if "warda" not in gen:
            gen.append("warda")
            gen.sort()
            s = s[:m.start()] + m.group(1) + ", ".join(gen) + s[m.end():]
    lines = s.split("\n")
    idx = [i for i, l in enumerate(lines) if re.match(r'^  \| "[a-z0-9-]+"$', l)]
    if not idx:
        raise SystemExit("could not find the IntegrationType union")
    entry = '  | "warda"'
    after = [i for i in idx if lines[i] > entry]
    lines.insert(after[0] if after else idx[-1] + 1, entry)
    io.open(p, "w", encoding="utf-8").write("\n".join(lines))
    changed.append("union")

print("lists: " + (", ".join(changed) + " updated" if changed else "already carried warda"))
PY

# 3. plugins/index.ts is generated. Never hand-edit it; run what generates it.
echo "running discover-plugins"
pnpm discover-plugins >/dev/null
if ! grep -q 'import "./warda";' plugins/index.ts; then
  echo "discover-plugins did not register warda — check plugins/plugin-allowlist.json" >&2
  exit 1
fi
echo "registry: warda registered"

# 4. Their checks, not ours. A plugin that passes our tests and fails theirs is
#    a pull request that wastes a maintainer's afternoon.
echo "running their unit tests"
npx vitest run tests/unit/warda-check-authority.test.ts

echo "running their plugin egress check"
matches=$(git grep --no-index -nE '(^|[^0-9A-Za-z_.])fetch\(|(^|[^0-9A-Za-z_])axios([^0-9A-Za-z_]|$)|https?\.request\(' -- \
  'plugins/' ':!*.test.ts' ':!plugins/*/test.ts' ':!*.md' ':!*.txt' \
  | grep -vE 'safeFetch\(' || true)
if [ -n "$matches" ]; then
  echo "raw network egress under plugins/ — their CI will refuse this:" >&2
  echo "$matches" >&2
  exit 1
fi
echo "egress: clean"

echo
echo "done. Review with: git -C $target status"
