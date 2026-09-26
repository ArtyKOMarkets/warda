#!/bin/bash
# Are the HOSTED agents' grants where the runner thinks they are?
#
#     ops/check-hosted.sh              # ask the runner, print a line per agent
#     ops/check-hosted.sh --quiet      # same, no stdout on success
#
# ## Why this is a curl and not a second copy of check-located.ts
#
# ops/check-located.ts watches the grants whose manifests live in this
# repository. The hosted fleet's do not: the runner keeps its records in the
# registry, and `runner/agents/first-hosted-grant.json` is a snapshot of genesis
# that nothing advances — its own commit says so. Watching that file produced the
# only failure on check-located's first real run, about a grant that was fine.
#
# So the question has to be asked where the records are. The runner already had
# everything needed to answer it — the registry, a chain connection, and a
# GrantReader whose own comment says null means "the address the runner has on
# file holds nothing" — and nothing asked. GET /v1/admin/stats reported each
# agent's budget and spend from the manifest and never whether the money was at
# the address that manifest derives, which means through the 25 September
# covenant-freeze outage it would have shown a page of healthy agents.
#
# It asks now, once per agent, and this file reads the answer. No second database
# credential: the admin secret that already exists is the whole of it.
#
# ## Exit codes, which ops/monitor.sh reads
#
#   0  every hosted grant with a record is located
#   1  at least one is NOT — the coin is not at the address its record derives
#   2  cannot check: no secret, no runner, or the runner could not reach a node
#
# 2 for "the runner could not reach a node" matters as much as the others. The
# route answers `located: null` for that rather than false, because an unreachable
# node and a grant that has moved are the same observation and completely
# different news — the distinction ops/check-node.sh spent a day and a half on
# the wrong side of.
set -uo pipefail

REPO="${WARDA_REPO:-$HOME/Desktop/warda}"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

[ -f "$REPO/ops/alerts.env" ] && { set +u; . "$REPO/ops/alerts.env"; set -u; }
[ -f "$REPO/runner/.env" ] && { set +u; . "$REPO/runner/.env"; set -u; }

SECRET="${WARDA_ADMIN_SECRET:-${ADMIN_SECRET:-}}"
URL="${WARDA_RUNNER_URL:-${RUNNER_URL:-}}"

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1
say() { [ "$QUIET" = 1 ] || echo "$@"; }

if [ -z "$SECRET" ] || [ -z "$URL" ]; then
  echo "check-hosted: not configured — nothing to check." >&2
  [ -n "$URL" ] || echo "  WARDA_RUNNER_URL is unset (the runner's base URL, e.g. https://runner.example)." >&2
  [ -n "$SECRET" ] || echo "  WARDA_ADMIN_SECRET is unset (the operator's password for /v1/admin/stats)." >&2
  echo "  Put them in ops/alerts.env. Exiting 2: this says nothing about the hosted grants." >&2
  exit 2
fi

body="$(curl -sS -m 20 -H "authorization: Bearer $SECRET" "$URL/v1/admin/stats?days=1" 2>&1)" || {
  echo "check-hosted: the runner did not answer at $URL — $body" >&2
  echo "  Exiting 2: an unreachable runner is not a missing grant." >&2
  exit 2
}

# Parsed in node rather than with grep, because the answer is three-valued and a
# regex that cannot tell `false` from `null` is a regex that reports a sleeping
# node as seven lost grants.
out="$(printf '%s' "$body" | node -e '
let raw = ""; process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let j;
  try { j = JSON.parse(raw); } catch {
    console.error("the runner answered something that is not JSON:");
    console.error("  " + raw.slice(0, 300));
    process.exit(2);
  }
  if (j.error) { console.error("the runner refused: " + j.error); process.exit(2); }
  const agents = Array.isArray(j.agents) ? j.agents : [];
  if (!j.totals || j.totals.chainAsked !== true) {
    console.error("this runner does not ask the chain (totals.chainAsked is not true), so it");
    console.error("cannot say whether any grant is where its record puts it. Deploy a runner");
    console.error("that passes `grants` to adminStats — runner/src/api.ts.");
    process.exit(2);
  }
  const withGrant = agents.filter((a) => a.grant);
  const bad = withGrant.filter((a) => a.located === false);
  const unknown = withGrant.filter((a) => a.located === null);
  for (const a of withGrant) {
    const mark = a.located === true ? "ok      " : a.located === false ? "MISSING " : "unknown ";
    console.log(`  ${mark} ${String(a.agent).padEnd(18)} ${a.grant.left} KAS left of ${a.grant.budget}`);
  }
  if (bad.length) {
    console.error("");
    console.error(`${bad.length} hosted grant(s) have a record and no coin at the address it derives:`);
    for (const a of bad) console.error(`  ${a.agent} — ${a.grant.left} KAS should be there`);
    console.error("");
    console.error("Three causes, and the runner cannot tell them apart from where it stands:");
    console.error("  it spent and the record did not follow; it was revoked or reclaimed; or the");
    console.error("  address is being derived under the wrong covenant. The third is the");
    console.error("  25 September outage — check the manifest’s `covenant` against the");
    console.error("  templates the runner ships.");
    process.exit(1);
  }
  if (unknown.length === withGrant.length && withGrant.length > 0) {
    console.error(`the runner could not locate ANY of its ${withGrant.length} grants — its node is`);
    console.error("  probably unreachable. Nothing is concluded about the grants themselves.");
    process.exit(2);
  }
  console.log("");
  console.log(`check-hosted: ${withGrant.length - unknown.length} hosted grant(s) located` +
    (unknown.length ? `, ${unknown.length} unknown (the node did not answer for those)` : "") + ".");
});
' 2>&1)"
code=$?

if [ "$code" = 0 ]; then
  say "$out"
else
  # Loud even with --quiet: the wrapper reads this into the alert.
  printf '%s\n' "$out" >&2
fi
exit "$code"
