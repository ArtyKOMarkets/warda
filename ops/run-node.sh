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

# Finding kaspad.
#
# The first version of this guessed ~/.cargo/bin and told you to go and look
# when the guess was wrong — which is a script asking a person to do the one
# thing a script is good at. `cargo install` and `cargo build --release` put the
# binary in different places, and a rusty-kaspa checkout can live anywhere, so
# the usual spots are tried in order and then the home directory is searched
# once, shallowly.
find_kaspad() {
  [ -n "${KASPAD:-}" ] && { echo "$KASPAD"; return; }
  command -v kaspad 2>/dev/null && return
  for p in \
    "$HOME/.cargo/bin/kaspad" \
    "$HOME/kaspa/target/release/kaspad" \
    "$HOME/rusty-kaspa/target/release/kaspad" \
    "$HOME/Desktop/rusty-kaspa/target/release/kaspad" \
    "$HOME/Documents/rusty-kaspa/target/release/kaspad" \
    "/usr/local/bin/kaspad" "/opt/homebrew/bin/kaspad"
  do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  # Last resort. Bounded depth so this cannot turn into a disk crawl, and
  # -prune on the noisy trees so it stays quick.
  find "$HOME" -maxdepth 5 \
    \( -name node_modules -o -name .git -o -name Library -o -name .Trash \) -prune -o \
    -type f -name kaspad -perm -u+x -print 2>/dev/null | head -1
}

KASPAD="$(find_kaspad)"
if [ -z "$KASPAD" ] || [ ! -x "$KASPAD" ]; then
  echo "kaspad not found." >&2
  echo >&2
  echo "Looked on PATH, in ~/.cargo/bin, in the usual rusty-kaspa checkouts, and" >&2
  echo "through $HOME to five levels deep. If it is somewhere else:" >&2
  echo >&2
  echo "    KASPAD=/path/to/kaspad $0" >&2
  echo >&2
  echo "and put that path in ops/node.env so it is not a guess next time." >&2
  exit 1
fi
echo "kaspad: $KASPAD" >&2

exec "$KASPAD" \
  --testnet \
  --netsuffix=10 \
  --utxoindex \
  --rpclisten-json=127.0.0.1:18210 \
  "$@"
