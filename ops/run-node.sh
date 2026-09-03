#!/bin/bash
#
# Start the kaspad this project talks to.
#
# Two flags matter and both fail quietly when they are wrong:
#
#   --rpclisten-json=HOST:PORT
#       The JSON wRPC port, which is NOT the Borsh one (18210 vs 17210 on
#       testnet). Note the '=': the flag rejects a space-separated value, and
#       without the flag entirely the port simply never opens — the node runs
#       perfectly and every tool here reports "cannot reach".
#
#   --utxoindex
#       Without it, getUtxosByAddresses answers with an EMPTY LIST rather than
#       an error. An empty list is indistinguishable from a grant that has been
#       spent, so every tool would report the grant gone and be believed.
#       NodeClient.open refuses such a node for exactly this reason.
#
# Bound to 127.0.0.1 on purpose. cloudflared runs on this same machine and
# connects locally, so the port never needs to face the network — and a JSON
# RPC port open to the internet is a node anyone can use as their own.
set -euo pipefail

KASPAD="${KASPAD:-$(command -v kaspad || echo "$HOME/.cargo/bin/kaspad")}"
if [ ! -x "$KASPAD" ]; then
  echo "kaspad not found at $KASPAD" >&2
  echo "Set KASPAD to its path, or put it on PATH. If you built rusty-kaspa," >&2
  echo "it is usually target/release/kaspad in that checkout." >&2
  exit 1
fi

exec "$KASPAD" \
  --testnet \
  --netsuffix=10 \
  --utxoindex \
  --rpclisten-json=127.0.0.1:18210 \
  "$@"
