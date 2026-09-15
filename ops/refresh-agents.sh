#!/bin/bash
#
# Regenerate every agent's published reading.
#
#   ops/refresh-agents.sh              all of them
#   ops/refresh-agents.sh 003 005      just those
#
# ## Why this exists
#
# Each agent's page is built from a JSON reading that `dashboard.ts` derives
# from the chain, and each reading needs its own command with its own flags —
# the grant it describes, the payees it commits to, whether it succeeded
# another agent or was delegated by one, and the txid that ended it if it is
# retired. Five commands, each long, none of them memorable.
#
# So they were run by hand, which means they were run once. Agent #002's
# reading was generated in September and never again, because the command
# recorded for it omitted the `--ended` flag its retirement requires and
# nobody found out until the day something else needed regenerating. When the
# reading's SHAPE changes — as it did when the disclosure stopped being
# hardcoded in the template — every page has to be rebuilt at once, and four
# commands pasted one at a time is how three of them get rebuilt.
#
# ## bash 3.2
#
# macOS ships bash 3.2, from 2007, and `#!/bin/bash` gets it. So: no `mapfile`,
# no `readarray`, no associative arrays, no `${x^^}`, and no `"${arr[@]}"` on a
# possibly-empty array under `set -u`.
#
# The first version of this file used `mapfile` and died on line 44 of the
# user's machine — in a repository where `site/refresh-demo.sh` already carries
# a paragraph about `sort -z` being a GNU extension that BSD does not have,
# which I had read the same afternoon. Hence `ops/check-portable.mjs`.
#
# ## One source for the commands
#
# It does not contain the commands. It reads them out of `site/build.py`,
# which already holds them in order to print them when it drops a page. A copy
# here would be a second place to update and therefore a second place to be
# wrong — and the thing being guarded against is precisely a recorded command
# that stopped matching the tool.
set -o pipefail

cd "$(dirname "$0")/.."

# A padded string rather than an array: bash 3.2 under `set -u` errors on
# "${empty[@]}", and this has to be runnable with no arguments at all.
WANT=" $* "
wanted() {
  [ "$WANT" = "  " ] && return 0
  for w in $WANT; do
    case "$1" in *"$w"*) return 0;; esac
  done
  return 1
}

# The same extraction check-commands.mjs uses: ask Python rather than parse its
# string-continuation syntax in another language. Into a temp file read by a
# while-loop, because `mapfile` is bash 4.
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
python3 - > "$LIST" <<'ENDOFPY'
import re, pathlib
s = pathlib.Path("site/build.py").read_text()
m = re.search(r"^AGENTS = \[(.*?)^\]", s, re.S | re.M)
ns = {}
exec("AGENTS = [" + m.group(1) + "]", ns)
for data, _page, how in ns["AGENTS"]:
    print(data + "\t" + how.replace("\\\n", " ").replace("\n", " "))
ENDOFPY

if [ ! -s "$LIST" ]; then
  echo "no commands found in site/build.py — has AGENTS moved?" >&2
  exit 1
fi

# A regenerated reading must not be POORER than the one it replaces.
#
# The command each of these runs is recorded in build.py, and those records had
# drifted from the commands refresh-demo.sh was actually using. Running the
# recorded ones succeeded, exited 0, wrote a valid file — and agent #001 lost
# its digest, its run count and its second grant, while #003 lost its mission.
# A page quietly missing three sections, from a run that reported success.
#
# So the move is refused when a top-level key disappears. It compares the file
# that is about to be replaced, so it says exactly what would have been lost.
# A key going from present to null counts: that is how a missing --readings
# shows up.
# Compared AFTER the command, against a snapshot taken before it, because the
# recorded commands do their own `mv` — they have to, since they are also
# printed for a human to paste and a command that leaves a .new file behind
# would be a command that does nothing.
keptEverything() {
  data="$1"
  before="$2"
  target="site/src/$data"
  [ -s "$before" ] || return 0          # first run: nothing to lose
  [ -f "$target" ] || return 0
  lost="$(python3 - "$before" "$target" <<'ENDCHECK'
import json, sys
try:
    old = json.load(open(sys.argv[1]))
    new = json.load(open(sys.argv[2]))
except Exception:
    raise SystemExit(0)
if not isinstance(old, dict) or not isinstance(new, dict):
    raise SystemExit(0)
print(" ".join(k for k in old if old.get(k) and not new.get(k)))
ENDCHECK
)"
  [ -z "$lost" ] && return 0
  echo "  REFUSED — the new reading drops: $lost" >&2
  echo "            The previous one has been put back. This is usually a flag" >&2
  echo "            missing from the command in site/build.py; compare it with" >&2
  echo "            what actually produced the live page." >&2
  cp "$before" "$target"
  return 1
}

TAB="$(printf '\t')"
failed=""
nfailed=0
ran=0

while IFS="$TAB" read -r data cmd; do
  [ -n "$data" ] || continue
  wanted "$data" || continue
  ran=$((ran + 1))
  echo
  echo "=== $data ==============================================="
  # A subshell, because one of these begins `cd agent &&` and the next must
  # not inherit it.
  BEFORE="$(mktemp)"
  [ -f "site/src/$data" ] && cp "site/src/$data" "$BEFORE"
  if ( eval "$cmd" ) && keptEverything "$data" "$BEFORE"; then
    echo "  ok"
  else
    echo "  FAILED — $data was NOT replaced." >&2
    # The half-written .new, usually empty: the shell creates it before the
    # tool runs, so a tool that refuses leaves a zero-byte file behind.
    # Harmless until somebody finds one and wonders whether it is a reading —
    # which cost a confused minute today, when a truncated agent-005.json read
    # as "unreadable" rather than "missing" and the build said so instead of
    # printing the command.
    rm -f "site/src/$data.new" "$data.new"
    failed="$failed  $data
"
    nfailed=$((nfailed + 1))
  fi
  rm -f "$BEFORE"
done < "$LIST"

echo
if [ "$nfailed" -eq 0 ]; then
  echo "$ran reading(s) refreshed. Now: python3 site/build.py"
  exit 0
fi

# Named individually. "3 failed" sends you back to the scrollback; the names
# are what you act on, and a grant that MOVED needs a different answer from one
# that ENDED.
echo "$nfailed of $ran failed:" >&2
printf '%s' "$failed" >&2
echo >&2
echo "Each refusal above says which it is. The two that matter:" >&2
echo "  the grant MOVED  — sdk/tools/follow-grant.ts, then run this again" >&2
echo "  the grant ENDED  — the command needs --ended <txid>, in site/build.py" >&2
echo >&2
echo "Nothing was overwritten by a failure: each command writes .new and moves it." >&2
exit 1
