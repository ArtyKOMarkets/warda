#!/bin/bash
#
# Start the covenant auditor: free analysis at /v1/scan, the rendered report
# behind a 402 at /v1/report.
#
# Three things have to be true before this can take money, and all three fail
# in ways that are quiet rather than loud, which is why they are checked here
# and not discovered at the first sale:
#
#   PAY_TO         the address every quote tells a buyer to pay. server.mjs
#                  refuses to start without it, because the alternative is a
#                  quote naming nobody and a failure that lands after the
#                  money has moved.
#
#   QUOTE_SECRET   signs quotes, and must be the SAME across restarts. A
#                  secret generated per process makes every quote issued
#                  before the restart unverifiable after it — so a buyer who
#                  paid against an old quote is refused, having paid.
#
#   the scan binary  a release build of covenant/harness. The service shells
#                  out to it; without it every request fails at the point a
#                  buyer has already been charged.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
svc="$here/../covenant/auditor-service"

# The environment lives in ops/auditor.env, which is gitignored: it holds the
# quote secret, which is a password. `set -a` exports what the file assigns
# without every line needing `export`.
if [ -f "$here/auditor.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$here/auditor.env"
  set +a
else
  echo "ops/auditor.env not found. Copy ops/auditor.env.example to it and fill it in." >&2
  exit 1
fi

# Named here rather than left to the vendor package, which throws an uncaught
# Error with a stack trace. The message is right; the presentation says "this
# program is broken" when what happened is "one line of a config file is
# blank", and the file it is blank in is not mentioned anywhere in the trace.
if [ -z "${PAY_TO:-}" ]; then
  echo "PAY_TO is empty in $here/auditor.env." >&2
  echo "It is the address every quote tells a buyer to pay." >&2
  exit 1
fi
if [ -z "${QUOTE_SECRET:-}" ]; then
  echo "QUOTE_SECRET is empty in $here/auditor.env." >&2
  echo >&2
  echo "Generate one straight into the file, so it is never on screen or in" >&2
  echo "your shell history:" >&2
  echo >&2
  echo "    printf 'QUOTE_SECRET=%s\\n' \"\$(openssl rand -hex 32)\" >> $here/auditor.env" >&2
  echo >&2
  echo "Then delete the earlier blank QUOTE_SECRET= line. Keep the value: every" >&2
  echo "restart must use the same one, or quotes issued before it stop verifying." >&2
  exit 1
fi

SCAN_BIN="${SCAN_BIN:-$here/../covenant/harness/target/release/scan}"
if [ ! -x "$SCAN_BIN" ]; then
  echo "no scan binary at $SCAN_BIN" >&2
  echo >&2
  echo "    cargo build --release --bin scan --manifest-path $here/../covenant/harness/Cargo.toml" >&2
  exit 1
fi
export SCAN_BIN

# Absolute, and outside the repo. The spent file is the only thing between one
# payment and unlimited reports; a relative path would put it wherever launchd
# happened to start the process, which is not the same place twice.
export SPENT_FILE="${SPENT_FILE:-$HOME/Library/Application Support/warda/auditor-spent.log}"
mkdir -p "$(dirname "$SPENT_FILE")"

cd "$svc"
exec node server.mjs
