#!/bin/bash
#
# One purchase a day from a vendor nobody here controls. Agent #005.
#
# ## Why this exists
#
# The 14 September interop win was real and it was one transaction on one
# afternoon. Nothing about it would notice if their facilitator changed
# tomorrow — which is the same shape as every claim this project has had to go
# back and correct: true when written, quietly false later, with nothing
# arranged to notice. A daily purchase turns the claim into something that
# decays LOUDLY, because the status file the site reads goes stale and the
# page stops rendering it.
#
# It is also the only thing watching for the failure of 15 September, where a
# relayed payment settled on chain and came back `invalid_transaction_state`.
# That was not reproduced by the next run and its cause is still unknown. A
# schedule is how an intermittent failure becomes a rate.
#
# ## What it costs, and when it stops
#
# 0.2 KAS invoiced plus about 0.02 in fees per run, against a grant holding
# 2.55 and no way to top itself up — call it eleven or twelve days. When it
# runs dry it starts failing, and that failure is a true thing about a bounded
# agent reaching its bound. A cron that refunds a grant has reinvented the hot
# wallet this project exists to replace.
#
# ## The environment
#
# cron runs with a near-empty PATH and does not read ~/.zshrc, so node is not
# on the path and neither is anything else. Everything is named absolutely. A
# cron entry that leans on the interactive shell's environment works perfectly
# when tested by hand and silently does nothing at 3am.
#
# No node, deliberately: --borsh is set inside interop.ts, so this run reaches
# the chain through whichever of sixteen public resolvers answers first. That
# is the claim being exercised, not a fallback.
set -euo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/bin:/bin"

KEY="$REPO/agent-005/agent.key"
if [ ! -f "$KEY" ]; then
  echo "no agent key at $KEY — nothing to buy with." >&2
  exit 1
fi

cd "$REPO"

set +e
WARDA_AGENT_SK="$(cat "$KEY")" node --experimental-strip-types agents/tools/interop.ts \
  --grant x402/demo/agent-005-grant.json \
  --recipients agent-005/payees.txt \
  --url https://demo.kaspa-x402.org/exact \
  --status site/src/interop-status.json \
  --out agent-005/purchases
rc=$?
set -e

# The status file is written on every outcome, so the site tells the truth
# whichever of these fired. These messages are for the log, which is read only
# when something has already gone wrong.
case $rc in
  0) echo "bought from a stranger." ;;
  3) echo "the covenant refused it. Nothing was spent — this is the budget ending." >&2 ;;
  4) echo "PAID AND NOT SERVED. The proof is in agent-005/purchases, on a record whose" >&2
     echo "outcome is paid-then-failed. Do not re-run to compensate: that buys it twice." >&2 ;;
  *) echo "failed with $rc — see above." >&2 ;;
esac

# The agent's own page, after the purchase that changes it.
#
# Nothing else refreshes #005. site/refresh-demo.sh deliberately reads only
# #001 and #003 hourly — #002 and #004 have ended and there is nothing left to
# re-read — so without this line #005's page would go on saying "0 recorded, 0
# served" after every purchase it ever makes, on the page whose whole argument
# is that its claim can be checked rather than believed.
#
# Whatever the purchase did, including failing: a refusal is a reading too, and
# the reconciliation on that page is more interesting when it is wrong than
# when it is clean. refresh-agents.sh will not replace a reading that is poorer
# than the one it has, and refresh-demo.sh deploys it within the hour.
ops/refresh-agents.sh agent-005 || echo "the reading did not refresh — the page keeps the last one." >&2

exit $rc
