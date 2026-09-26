#!/bin/bash
# Build the bundle that generates the principal key on a machine with no network.
#
#     ops/principal-bundle.sh                 # build it, verify it, say where it is
#     ops/principal-bundle.sh --out /Volumes/USB/warda-principal
#
# ## Why this exists
#
# ops/PRINCIPAL.md said, from the day it was written: "with this repo checked out
# (no `npm install` needed — `new-key.ts` uses only the SDK's own code)".
#
# That is false. `sdk/tools/new-key.ts` imports `sdk/src/sign.ts`, which imports
# `@noble/curves`, and `sdk/tools/network.ts` resolves `@warda_protocol/kaspa`
# through node_modules. On a wiped laptop it dies with ERR_MODULE_NOT_FOUND before
# generating anything — and the whole premise of the exercise is that the machine
# has no way to fetch what it is missing. A procedure that fails at the one step
# you cannot improvise around is worse than no procedure: it gets attempted, it
# fails, and the key ends up being made on the online machine "just for now".
#
# So the bundle is built HERE, where the dependencies already are, and verified
# HERE, in an isolated directory with nothing else on the module path — because a
# bundle that is only believed to be complete is the same false claim in a new
# place.
#
# ## What goes in it
#
# 2.5 MB: the SDK's source, @noble/curves, @noble/hashes, and the self-link the
# SDK's own tools resolve through. No compiler, no install, no network.
set -uo pipefail

REPO="${WARDA_REPO:-$HOME/Desktop/warda}"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

# Parsed with shift, not with `for i in $(seq 1 $#)` and `${!i}`.
#
# That is what was here, and it worked on every Linux I tried it on and died on
# the Mac it is for: BSD `seq 1 0` counts DOWN and prints "1 0", where GNU seq
# prints nothing. So with no arguments the loop ran once with i=1, `${!i}`
# expanded $1, which is unset, and `set -u` ended the script on line 36 before it
# had done anything —
#
#     ops/principal-bundle.sh: line 36: !i: unbound variable
#
# I had tested it only with --out. The default path, which is the one anybody
# runs first, was never executed anywhere. Same mistake as the rest of today, in
# a new costume: the flag was tested and the default was not.
#
# `shift` needs no indirect expansion and no seq, and is the same in every shell
# this could plausibly run in.
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      shift
      [ $# -gt 0 ] || { echo "--out needs a directory." >&2; exit 2; }
      OUT="$1"
      ;;
    -h|--help)
      # Literal, not `sed -n '2,12p' "$0"`: a help text sliced out of this file
      # by line number printed the middle of a comment about BSD seq the moment
      # the header above it grew.
      echo "usage: ops/principal-bundle.sh [--out <directory>]"
      echo
      echo "Builds and verifies the bundle that generates the principal key on a"
      echo "machine with no network. Copy the result to removable media; the"
      echo "instructions for the offline machine are MAKE-THE-KEY.txt inside it."
      echo
      echo "Read ops/PRINCIPAL.md first."
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "  usage: ops/principal-bundle.sh [--out <directory>]" >&2
      exit 2
      ;;
  esac
  shift
done
# The default is OUTSIDE the repository, and inside it is refused.
#
# It used to default to $REPO/principal-offline, and the first real run left a
# directory sitting in the working tree with `new-key.ts` in it. `*.key` is
# gitignored so the secret could not have been committed by accident — but that is
# the net, not the plan. The hazard is simpler: a bundle that is already in the
# repo on the machine you are standing at is a bundle somebody runs THERE, and
# then the principal secret exists on a machine that is online, runs agents, and
# has WARDA_SK on it. That is the one property this whole document buys.
#
# So the default is $HOME, the repo is refused, and there is no --force: a flag to
# bypass this would be used the first time it was inconvenient, which is the same
# afternoon.
if [ -n "$OUT" ]; then
  case "$(cd "$(dirname "$OUT")" 2>/dev/null && pwd -P || echo "$OUT")/$(basename "$OUT")" in
    "$(cd "$REPO" && pwd -P)"/*)
      echo "refusing to build the bundle inside the repository." >&2
      echo >&2
      echo "  $OUT is under $REPO." >&2
      echo >&2
      echo "  A bundle already sitting in the working tree is one somebody runs there, and" >&2
      echo "  the principal secret must never exist on a machine that runs agents. Build it" >&2
      echo "  somewhere you will carry from:" >&2
      echo >&2
      echo "    ops/principal-bundle.sh                      # \$HOME/warda-principal-offline" >&2
      echo "    ops/principal-bundle.sh --out /Volumes/USB/warda-principal" >&2
      exit 2
      ;;
  esac
else
  OUT="$HOME/warda-principal-offline"
fi

cd "$REPO" || { echo "cannot cd to $REPO — set WARDA_REPO." >&2; exit 2; }

for d in sdk node_modules/@noble/curves node_modules/@noble/hashes; do
  [ -d "$d" ] || { echo "missing $d — run npm install in $REPO first." >&2; exit 2; }
done

if [ -e "$OUT" ]; then
  echo "$OUT already exists. Remove it, or pass --out <somewhere else>." >&2
  echo "  Refusing to write over it: if a previous bundle is there, it may hold a key." >&2
  exit 2
fi

echo "building the offline bundle in $OUT"
mkdir -p "$OUT/node_modules/@noble" "$OUT/node_modules/@warda_protocol"
# The SOURCE, not dist. new-key.ts is run with --experimental-strip-types, so the
# TypeScript is what executes; a dist/ would need a build on a machine that cannot
# run one.
cp -R sdk "$OUT/sdk"
# Anything that could carry a secret out of here, or is simply weight.
rm -rf "$OUT/sdk/dist" "$OUT/sdk/node_modules" "$OUT/sdk/test"
find "$OUT/sdk" -name '*.key' -delete 2>/dev/null || true
cp -R node_modules/@noble/curves "$OUT/node_modules/@noble/curves"
cp -R node_modules/@noble/hashes "$OUT/node_modules/@noble/hashes"
# How sdk/tools/network.ts reaches the package by name. A relative link, so it
# survives being copied to a USB stick and mounted somewhere else.
ln -s ../../sdk "$OUT/node_modules/@warda_protocol/kaspa"

cat > "$OUT/MAKE-THE-KEY.txt" <<'TXT'
The principal key. Read ops/PRINCIPAL.md first, on a machine that can read it.

This directory needs no network, no npm install and no compiler. Node 20 or
newer, and nothing else.

  cd <this directory>
  node --experimental-strip-types sdk/tools/new-key.ts --label principal \
    --network testnet-10 > principal.key

It prints the PUBLIC half and the address on screen, and writes the SECRET to
principal.key.

Then:

  If it refuses, read what it says. new-key.ts will not make a PRINCIPAL key on a
  machine that looks like it runs agents, because on 26 September one was made in
  a repository root when a `cd` into this bundle failed and the next line ran
  anyway. In this bundle it will not refuse; anywhere else, it is telling you
  something true.

  1. Write the public key down. It is meant to be readable and publishing it
     costs nothing. Every grant will carry it.
  2. Check what it wrote, without a network:
       node --experimental-strip-types sdk/tools/new-key.ts --label check \
         --network testnet-10 >/dev/null
     A second run printing a DIFFERENT public key is the proof that the first
     one was random rather than a constant.
  3. The secret goes nowhere. Not this repo, not a syncing password manager,
     not a note, not a chat window. Back it up like a seed phrase: paper or
     metal, a second physical place, and never onto a machine that is online.
  4. Take only the PUBLIC key back. If you carry the USB stick back to an
     online machine, the secret is on a machine that is online.

The public half is what genesis needs:

  node --experimental-strip-types sdk/tools/genesis.ts \
    --principal <the public key> --revocation <the ops revocation key> ...
TXT

# ---------------------------------------------------------------- verify
#
# In a directory of its own, with the bundle's own node_modules and nothing
# above it. Run inside $REPO the resolver walks upward and finds the real
# node_modules, which is exactly how the original false claim went unnoticed for
# as long as it did: it works perfectly everywhere except the one machine it is
# for.
echo "verifying it in isolation"
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
cp -R "$OUT" "$probe/bundle"
first="$(cd "$probe/bundle" && node --experimental-strip-types sdk/tools/new-key.ts \
  --label verify --network testnet-10 2>&1 >/dev/null | sed -n 's/.*public  *: \(.*\)/\1/p')"
second="$(cd "$probe/bundle" && node --experimental-strip-types sdk/tools/new-key.ts \
  --label verify --network testnet-10 2>&1 >/dev/null | sed -n 's/.*public  *: \(.*\)/\1/p')"

fail() { echo; echo "✗ $1" >&2; echo "  The bundle is NOT usable offline. Nothing has been left in $OUT." >&2; rm -rf "$OUT"; exit 1; }

case "$first" in
  [0-9a-f]*) : ;;
  *) fail "the bundle could not generate a key at all: ${first:-no output}" ;;
esac
[ "${#first}" = 64 ] || fail "the public key is ${#first} characters, not 64: $first"
# Two runs, two keys. A bundle that returns the same key twice is generating
# something that is not random, and that would be the one failure mode worth
# more than the inconvenience of catching it.
[ "$first" != "$second" ] || fail "two runs produced the SAME public key — this is not generating randomness"

# And nothing that could leak: the verification made keys in a temporary copy,
# never in $OUT.
if find "$OUT" -name '*.key' | grep -q .; then
  fail "the bundle contains a .key file. It must be built empty and used once, offline."
fi

echo
echo "✓ verified: the bundle generated two different valid keys with no network"
echo "  and nothing above it on the module path."
echo
echo "  $OUT  ($(du -sh "$OUT" | cut -f1))"
echo
echo "Copy that whole directory to removable media, take it to the offline machine,"
echo "and follow MAKE-THE-KEY.txt inside it. Then delete it from THIS machine:"
echo
echo "  rm -rf $OUT"
echo
echo "It holds no secret — it is the means of making one, and leaving it here"
echo "invites making the key in the wrong place on a day you are in a hurry."
