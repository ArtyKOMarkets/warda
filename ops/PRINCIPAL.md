# The principal key, and where it is supposed to live

The principal is the one key in a Warda grant that **receives money**. On
`revoke` or `reclaim` the grant's entire remaining balance goes to it, and
nothing in the covenant bounds that — bounding it is the covenant's whole
purpose for the *agent*, and the principal is the party the agent is bounded
in favour of.

`ops/known-keys.json` has said where it belongs since the file was written:

> three keys, not one. On mainnet the principal must be generated offline on a
> machine that never runs an agent.

This is the procedure for doing that, and the reasoning for why it is worth the
inconvenience.

## Why it cannot wait until mainnet

A grant's address is a hash of its state, and its state includes its three
keys. So the principal is decided **at genesis and for the grant's whole
life**. There is no setting to change later, no migration path, and no fix
short of revoking and reissuing.

Twenty-nine grants in this repository name a funder key as their principal.
Every one of them is permanently that way. `test/key-separation.test.ts` pins
that number so it cannot grow quietly, and `sdk/tools/genesis.ts` refuses the
shape outright on mainnet with no override flag.

That is why this is on the before-mainnet list rather than in it: the cost is
not paid when mainnet arrives, it is paid by every grant issued between now and
then.

## What "offline" has to mean here

Not "a different file". Not "a different directory". The property that matters
is that the machine holding the secret has no path by which an agent, a runner,
a deploy script or a web service could ever read it.

The funder key fails this by construction. `WARDA_SK` signs genesis because
genesis spends the funder's coin, so that key is on a machine that is online,
runs things, and has an agent on it. It is exactly the wrong place for the key
that receives everything.

A machine qualifies if all of these are true:

- it has never run an agent, a runner or a node, and is not going to
- nothing on it reads `WARDA_SK`, `runner/.env`, or any `*.key` in this repo
- it is not the machine any deploy, CI job or scheduled task runs on
- if it is networked at all, nothing on it listens

An old laptop that has been wiped, or a live USB session on one, is enough. The
key is thirty-two bytes and the machine's only job is to print the public half.

## The procedure

### 1. Build the bundle, on this machine

    ops/principal-bundle.sh

**This step did not used to exist, and the instruction it replaces was wrong.**
It said "with this repo checked out (no `npm install` needed — `new-key.ts` uses
only the SDK's own code)". That is false: `new-key.ts` imports `sdk/src/sign.ts`,
which imports `@noble/curves`, and `sdk/tools/network.ts` resolves
`@warda_protocol/kaspa` through `node_modules`. On a wiped laptop it exits with
`ERR_MODULE_NOT_FOUND` before generating anything — and the entire premise is
that the machine has no way to fetch what it is missing.

A procedure that fails at the one step you cannot improvise around is worse than
no procedure. It gets attempted, it fails at the far end of a trip, and the key
gets made on the online machine "just for now", which is the exact outcome this
document exists to prevent.

So the bundle is assembled here, where the dependencies already are: the SDK's
source, `@noble/curves`, `@noble/hashes`, and the self-link the SDK's tools
resolve through. About 4 MB, no compiler, no install, no network.

It is then **verified here**, in a temporary directory with nothing above it on
the module path — because running it inside this repo lets Node walk upward and
find the real `node_modules`, which is precisely how the false claim survived: it
works everywhere except the machine it is for. The verification generates two
keys and requires them to differ, and if anything fails it deletes the bundle
rather than letting an unusable one be carried anywhere.

It writes to `$HOME/warda-principal-offline` by default and **refuses an `--out`
inside this repository**, with no override. The first version defaulted into the
working tree, which is how a bundle ends up being run on the machine you are
standing at — and then the principal secret exists on a machine that is online,
runs agents and has `WARDA_SK` on it, which is the entire property this document
buys. (`*.key` is gitignored, so the secret could not have been *committed* by
accident. That is the net, not the plan.)

Copy the directory to removable media. `MAKE-THE-KEY.txt` inside it is the rest
of the procedure, written to be readable on a machine that cannot open this file.

### 2. Make the key, on the offline machine

    cd <the bundle>
    node --experimental-strip-types sdk/tools/new-key.ts --label principal \
      --network testnet-10 > principal.key

It writes the secret to `principal.key` and prints the public half and its
address on screen. `new-key.ts` refuses to overwrite an existing key file — that
refusal exists because on 17 September 2026 a re-run of a pasted block wrote over
a funder key and stranded the coin the old one controlled.
`ops/check-key-writes.mjs` makes it a rule rather than a habit.

Run it a second time with `>/dev/null` and check the public key printed is
DIFFERENT. Two identical keys would mean something is returning a constant, and
it is the one failure worth the ten seconds: a principal everybody can derive is
a principal that receives every grant's balance for somebody else.

**Write the public half down.** It is what every grant will carry and what
every tool needs. It is meant to be readable; publishing it costs nothing.

**Take the secret nowhere.** It does not go in this repository, in a password
manager that syncs, in a note, or through a chat window. Back it up the way
you would back up a seed phrase: on paper or metal, in a second physical place,
and never by copying the file onto a machine that is online.

**And take only the public half back.** Carrying the USB stick to an online
machine to "just copy the public key off it" puts the secret on a machine that is
online, which is the whole property being bought here. Read the public key off
the screen and type it.

Then delete the bundle from this machine. It holds no secret; leaving it around
invites making the key in the wrong place on a day you are in a hurry.

### 3. Then issue grants against the public half

    WARDA_SK=$(cat covenant/deploy/warda-testnet.key) \
      node --experimental-strip-types sdk/tools/genesis.ts \
      --principal <the public key the offline machine printed> \
      --revocation <the ops revocation key> \
      ...

The funder still signs genesis. It simply stops being the party that would
receive the balance if the grant were ever pulled back.

The v4 → v5 migration in `covenant/MIGRATION.md` is waiting on exactly this: a
reissued grant should not be reissued under a principal that has to be separated
again afterwards, because the principal is fixed at genesis and reissuing is the
only way to change it. Doing them in the wrong order costs a second transaction
per grant and a second new address for everything that references them.

## What this does NOT fix

**The existing twenty-nine.** They are what they are. The options are to let
each term expire, or to revoke and reissue under a separated principal — which
costs a transaction per grant and a new address for anything that references
them.

**The revocation key**, which is a separate role with a separate rule. It is
allowed to be warmer than the principal: `revoke` pays the principal rather
than its own signer precisely so a monitor can be trusted to stop a grant
without being trusted with its balance. `ops/warda-revocation.key` on the ops
machine is the intended shape, and `ops/grants.ts` already passes it on every
path.

**Genesis itself.** `AUTHORITY.md` is blunt that the creation of the authority
is assumed rather than enforced: *"The key that funds it can spend everything
it holds, and no covenant covers that step."* Separating the principal does not
change that. It changes what happens to a grant's balance afterwards, which is
the part the covenant is otherwise very specific about.
