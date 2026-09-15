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
# ## One source for the commands
#
# It does not contain the commands. It reads them out of `site/build.py`,
# which already holds them in order to print them when it drops a page. A copy
# here would be a second place to update and therefore a second place to be
# wrong — and the thing being guarded against is precisely a recorded command
# that stopped matching the tool.
set -uo pipefail

cd "$(dirname "$0")/.."

WANT=("$@")
wanted() {
  [ ${#WANT[@]} -eq 0 ] && return 0
  for w in "${WANT[@]}"; do [[ "$1" == *"$w"* ]] && return 0; done
  return 1
}

# The same extraction check-commands.mjs uses: ask Python, rather than parse
# its string-continuation syntax in another language.
mapfile -t COMMANDS < <(python3 - <<'PY'
import re, pathlib
s = pathlib.Path("site/build.py").read_text()
m = re.search(r"^AGENTS = \[(.*?)^\]", s, re.S | re.M)
ns = {}
exec("AGENTS = [" + m.group(1) + "]", ns)
for data, _page, how in ns["AGENTS"]:
    print(data + "\t" + how.replace("\\\n", " ").replace("\n", " "))
PY
)

if [ ${#COMMANDS[@]} -eq 0 ]; then
  echo "no commands found in site/build.py — has AGENTS moved?" >&2
  exit 1
fi

failed=()
ran=0
for entry in "${COMMANDS[@]}"; do
  data="${entry%%$'\t'*}"
  cmd="${entry#*$'\t'}"
  wanted "$data" || continue
  ran=$((ran + 1))
  echo
  echo "=== $data ==============================================="
  # A subshell, because one of these begins `cd agent &&` and the next must
  # not inherit it.
  if ( eval "$cmd" ); then
    echo "  ok"
  else
    echo "  FAILED — $data was NOT replaced." >&2
    failed+=("$data")
    # The half-written .new, which is usually empty: the shell creates it
    # before the tool runs, so a tool that refuses leaves a zero-byte file
    # behind. Harmless until somebody finds one and wonders whether it is a
    # reading. That already cost a confused minute with agent-005.json, where
    # a truncated file read as "unreadable" rather than "missing" and the build
    # said so instead of printing the command.
    rm -f "site/src/$data.new" "$data.new"
  fi
done

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "$ran reading(s) refreshed. Now: python3 site/build.py"
  exit 0
fi

# Named individually. "3 failed" sends you back to the scrollback; the names
# are what you act on, and a grant that MOVED needs a different answer from one
# that ENDED.
echo "${#failed[@]} of $ran failed:" >&2
for f in "${failed[@]}"; do echo "  $f" >&2; done
echo >&2
echo "Each refusal above says which it is. The two that matter:" >&2
echo "  the grant MOVED  — sdk/tools/follow-grant.ts, then run this again" >&2
echo "  the grant ENDED  — the command needs --ended <txid>, in site/build.py" >&2
echo >&2
echo "Nothing was overwritten by a failure: each command writes .new and moves it." >&2
exit 1
