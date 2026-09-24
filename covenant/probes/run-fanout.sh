#!/usr/bin/env bash
#
# Step 2 of covenant/V5.md: find out whether `#[covenant.fanout(to = N)]` is
# real above 2.
#
#     covenant/probes/run-fanout.sh          # N = 2 3 4 5
#     covenant/probes/run-fanout.sh 2 8      # whichever values you want
#
# Needs the scan binary, which compiles a covenant and reports on it:
#
#     cargo build --release --bin scan --manifest-path covenant/harness/Cargo.toml
#
# N = 2 is the CONTROL and it must pass. If it does not, the probe is wrong
# rather than the compiler, and nothing the other values say means anything —
# the same rule the audit suite applies to its own baseline.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
scan="${SCAN_BIN:-$repo/covenant/harness/target/release/scan}"
out="$here/out"

if [ ! -x "$scan" ]; then
  echo "no scan binary at $scan" >&2
  echo >&2
  echo "    cargo build --release --bin scan --manifest-path $repo/covenant/harness/Cargo.toml" >&2
  exit 2
fi

mkdir -p "$out"
values=("$@")
[ ${#values[@]} -eq 0 ] && values=(2 3 4 5)

control=""
declare -a results=()

for n in "${values[@]}"; do
  src="$out/fanout$n.sil"
  # The template, with the ONLY substitutions being the number and the one
  # require per child that the number implies.
  python3 - "$here/fanout.sil.tmpl" "$src" "$n" <<'PY'
import sys
tmpl, dst, n = sys.argv[1], sys.argv[2], sys.argv[3]
body = "".join(f"        require(newStates[{i}].counter == counter + 1);\n" for i in range(int(n)))
open(dst, "w").write(open(tmpl).read().replace("__CHILDREN__", body.rstrip("\n")).replace("__N__", n))
PY

  log="$out/fanout$n.log"
  if "$scan" "$src" > "$log" 2>&1; then
    bytes=$(grep -Eo '[0-9,]+ bytes' "$log" | head -1)
    echo "  to = $n   COMPILES   ${bytes:-size not reported}"
    results+=("$n ok")
    [ "$n" = "2" ] && control="ok"
  else
    echo "  to = $n   REFUSED"
    sed 's/^/             /' "$log" | head -8
    results+=("$n refused")
    [ "$n" = "2" ] && control="refused"
  fi
done

echo
if [ "$control" = "refused" ]; then
  echo "The CONTROL failed. to = 2 is what the shipped covenant uses, so this probe"
  echo "is wrong rather than the compiler, and nothing above means anything."
  echo "Full output in $out/fanout2.log"
  exit 1
fi
echo "Logs in $out/. Record the answer in covenant/V5.md — C1 and C2 are plans"
echo "against documentation until this says otherwise."
