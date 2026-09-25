# Spike: a Warda grant that holds dollars (25 Sep 2026)

> **Done on testnet-10, 25 Sep 2026.** A Warda grant held a KCC20 dollar
> compiled from KUSD's own token program, paid $5, $5 and $2 against a $5 cap
> and a $12 budget, and was revoked with $38 returned. The node refused all
> three attacks. Transactions are listed below.

**Question.** Can a Warda grant hold a KCC20 dollar token (a KUSD stand-in)
instead of KAS, with every limit enforced *in dollars* by Kaspa consensus?

**Answer: yes — 17 of 17 scenarios behaved as expected in the node's own script engine, against both silverscript's example token and KUSD's own token program.**

## Mechanism

KCC2 owner scheme `covenant-id`: the token coin's owner is the grant's
**covenant ID**. The token covenant refuses to move the coin unless an input of
that covenant is in the same transaction; the grant covenant then decides
whether the move is allowed.

```
INPUTS                               OUTPUTS
0  token $50  (owner = GRANT id)     0  token $5   -> payee          (KCC20 family)
1  grant  (spent = 0)                1  token $45  (owner = GRANT id)
                                     2  grant  (spent = 5)
```

- **KCC20 checks:** amounts conserve; the owner covenant participates.
- **Grant checks:** agent signed; payee allowed; ≤ $5 per payment; running
  total ≤ budget; change goes back under the grant's covenant ID; the KAS
  carried by the held token coin and by the grant coin stays with their
  successors (added 25 Sep after the first run — without it an agent could
  skim the coins' KAS to itself, scenarios 16–17). It reads the
  held amount *through the token's own template* (`readInputStateWithTemplate`)
  and checks the real outputs (`validateOutputStateWithInputTemplate`), so
  nothing the agent claims is trusted.

The owner is the covenant **ID**, not the address, so it survives every state
change. Scenario 2 pays from the successor coin to prove it.

## Results

Cap $5.00, budget $12.00, funded $50.00. Amounts in cents.

```
1. pay $5.00 to the allowed payee (spent 0 -> 5)                  accept
2. pay again from the SUCCESSOR coin (covenant id stable)         accept
3. pay $2.00 — brings spent to $12.00 = budget                    accept
4. pay $5.01 — over the $5 per-payment cap                        refuse (grant)
5. pay $5.00 when $10 already spent — over $12 budget             refuse (grant)
6. pay $5.00 to an address not on the allowlist                   refuse (grant)
7. pay $5 correctly but take the $45 change to the agent's key    refuse (grant)
8. tell the grant $5.00, put $6.00 in the real output             refuse (grant)
9. pay $5 but claim the running total did not move                refuse (grant)
10. a stranger signs the payment                                  refuse (grant)
11. move the dollars WITHOUT the grant in the transaction         refuse (token)
12. drain all $50 to a stranger with no grant input               refuse (token)
13. revoker ends the grant, all $45 back to principal             accept
14. agent tries to 'revoke' to itself                             refuse (grant)
15. revoker signs but sends the $45 to itself                     refuse (grant)
```

Full output in `results.txt`. Every refusal is `VerifyError`. The engine does
not say *which* `require` failed. The control is that each refusal differs
from an accepted transaction by exactly one field.

## Rerun against KUSD's own token program: 15/15

KUSD (`github.com/bitcoffee0/kusd`, branch `tn10`, commit `e3cabc0f`) uses
`contracts/kcc20.sil`. It has the same logic as silverscript's example,
including covenant-id owners (`0x02`), renamed entrypoints (`transferPolicy`,
exposed as `transfer`), and `maxCovIns = maxCovOuts = 8`. It is compiled with
the same silverscript commit (`3ed97333`) as the TN10 deployment. It is
copied here as `kusd-kcc20.sil`. `warda_kusd_program_tests.rs` runs the same 15
scenarios against it with KUSD's constructor parameters; the results are in
`results-kusd-program.txt`. All 15 match.

KUSD TN10 Asset ID: `a2d81080bd74ab419f0bfea73b20c5154100520be15d68a190a5d1adf52f32b5`.

## What this does NOT prove

- **Not KUSD on chain.** Same program and compiler, but real KUSD coins on
  TN10 have not been used. The KCC-0020 draft ABI (`0x04` for covenant-id) is
  a different program; KUSD follows the silverscript example.
- **Engine, not network.** Run through `TxScriptEngine` input by input, as
  silverscript's own tests do. It has not been broadcast; mass and fees are unmeasured.
- **The grant is minimal.** No expiry, epoch limits, delegation or Merkle
  allowlist. Those are v5's mechanisms and don't depend on the asset. Revoke
  leaves a dead successor (spent = budget) instead of terminating.
- **One held coin.** The grant requires exactly one token input, so a top-up
  means consolidating first, or accepting several held coins later.
- **KAS for fees.** Each token coin and the grant coin still carry some KAS.

## On chain (testnet-10): `onchain/`

A small Rust tool that runs the whole lifecycle against your node: mint $50 of
our own test dollar (compiled from KUSD's `kcc20.sil`, so the program is
KUSD's, only the asset is ours), create the grant, fund it, pay $5 twice,
**submit three attacks so the node's own refusal is on record** (over cap,
over budget, moving the dollars without the grant), pay $2 to hit the budget
exactly, and revoke $38 back to the principal.

Every transaction goes through the script engine with real signature costs
before it is broadcast; compute budgets are set from what the engine measured;
state is written before each broadcast. Results go to `onchain/onchain-log.json`.

Engine simulation of the full run (no node), per transaction:

| step | compute mass | transient | storage | fee (sompi) | budgets |
|---|---|---|---|---|---|
| token genesis | 2,283 | 1,412 | 13,345 | 14,566 | 12 |
| grant genesis | 2,283 | 1,412 | 13,348 | 14,566 | 12 |
| fund | 8,645 | 19,820 | 12,429 | 49,640 | 14, 12 |
| pay | 13,819 | 29,796 | ~27,000 | 69,592 | 12, 25, 12 |
| revoke | 12,780 | 29,120 | 19,870 | 68,240 | 12, 20, 12 |

A payment is ~7.4 KB. (The simulation's fee column used a wrong relay rate; see on-chain results.) One real
cost: every covenant coin occupies two storage units, so each coin carries
KAS (3 KAS here) to keep storage mass down. The payment coin's KAS goes to the
seller together with the dollars.

```
cd spike/kusd-grant/onchain
cargo run --release -- keys        # prints the funding address (fresh testnet keys)
# send 30+ TN10 KAS to it, in one transaction
cargo run --release -- simulate    # whole lifecycle through the engine, no node
cargo run --release -- run         # on chain; resumable; KASPA_WRPC to override the node URL
```

## On-chain results (testnet-10, node 2.0.1)

Token covenant `56791b2d0e4f5b6d15c56ca8fe6b6e1352b382b884e007af4580ec28a15f9570`
· Grant covenant `820bce13b49ee18ad46185f588f6b24c4f212d4878b20946718198d7788c4538`

| step | txid | result | fee (sompi) | bytes |
|---|---|---|---|---|
| token genesis ($50) | `7663dba552dfb91a6feca5ccca17223eec2579b593b17d0ee9f9b79ba4c37b9e` | accepted | 261,130 | 353 |
| grant genesis | `9609365508b72da0597da6c3b8bfa8fc0540b88176234dc36ccf5a6b6956bd6a` | accepted | 261,130 | 353 |
| fund ($50 under the grant) | `e22f56ab590c831cf36cb31bea961a117ab4d7d5fd5a7276ab9ac066fbee68f3` | accepted | 2,190,200 | 4,955 |
| pay $5 | `b1cdc8d198c6778a669c61394212371d30e4a91f6ad6fa972b1fc4a7cf4d78f2` | accepted | 3,287,560 | 7,449 |
| pay $5 (from successor) | `4887af6ca5560a25ecd1a4c63c68c76a5a142e64bb0ab7d308f169cc9ac64c8d` | accepted | 3,287,560 | 7,449 |
| attack: pay $6 (cap) | `c90f500be9ae873d80fb4bb9776940687038032a27fe11dda003f773b131a62f` | **node refused**: script ran, verification failed | | |
| attack: $3 over budget | `b3da566983f4ff3a35bf4122701a5252b8cea245cd932eee78eb06a2ee24687e` | **node refused**: script ran, verification failed | | |
| attack: move $38 without grant | `0f2c9d3b912cb6dcaccc7c8bbe38e891ffc1d59ecf1dd4a94e01edbd1a5a106d` | **node refused**: script ran, verification failed | | |
| pay $2 (budget exactly) | `529ba09cfddcb394f0b5b4c1d63d27fd3d9d7119db15c2de75cf7198602af74a` | accepted | 3,287,560 | 7,449 |
| revoke ($38 → principal) | `eee5afe58421fa8dcd04d3d155860820449b429f99b299a08b6e2802876074ef` | accepted | 3,213,200 | 7,280 |

**Learned on chain:**
- **Relay floor: 100 sompi per gram of fee mass.** The first submission paid
  about 6/gram and was refused (2,283 compute mass needed 228,300). This
  matches state-of-warda's six measurements. The tool pays 110/gram on the
  larger of compute and transient mass, so a dollar payment costs about 0.033
  KAS. That is probably an overpay, because the node prices transient mass
  normalised. It hasn't been measured.
- **The binding survived JSON wRPC.** After each accepted transaction, the tool
  checks the coin's covenant ID on chain. All matched.
- **Storage mass is the design cost.** Each covenant coin needs about 3 KAS,
  and the payment coin's KAS goes to the seller with the dollars.
- **Not yet:** real KUSD coins (asset `a2d81080…`), expiry and delegation, and
  measuring the actual minimum fee.

## The two KCC20 families, and what "asset-agnostic" actually means

Added 25 Sep after the run above. The question was whether a grant can hold
*anyone's* dollar rather than one project's, and it turns on a disagreement
that is larger than the one byte it is usually described as.

| | silverscript example, which KUSD ships | draft KCC-0020 |
|---|---|---|
| state | `ownerIdentifier byte[32]`, `identifierType byte`, `amount int`, `isMinter bool` | `amount int`, `owner byte[32]`, `ownerScheme byte`, `borrowScheme byte`, `borrowGuard byte[32]`, `extensionCommitment byte[32]` |
| `0x00` | pubkey | p2pk-schnorr |
| `0x01` | script hash | p2pkh-schnorr |
| `0x02` | **covenant id** | p2pkh-ecdsa |
| `0x03` | — | p2sh |
| `0x04` | — | **covenant id** |

Different field order, different field set, and — the line to be frightened of
— `0x02` is valid in both and means different things. "Owned by a covenant"
against "owned by an ECDSA key hash". Nothing in a coin says which table it
came from.

### What is parameterised, and what must not be

`warda-dollar-grant-0020.sil` is the twin of `warda-dollar-grant.sil`: same
rules, same order, same refusals, written for the draft layout. **Two sources,
not one parameterised source**, and that is the finding rather than a shortcut.

- A state layout is a compile-time type in silverscript. One source cannot span
  both.
- Once a source is pinned to a layout, making the scheme byte a constructor
  parameter would add a way to be wrong without adding a capability: a grant
  compiled for the draft layout and handed `0x02` would be asking whether the
  coin is owned by an ECDSA key hash while believing it asked about a covenant.
  **The byte belongs to the layout.** It is welded in each file on purpose.
- What makes the grant asset-agnostic is that the token PROGRAM is a parameter
  — `templatePrefixLen`, `templateSuffixLen`, `expectedTemplateHash`. The grant
  reads the held coin through that template, so it holds any token of its own
  layout: KUSD's, a competitor's, one that does not exist yet.

### The cross-family test, and the one that nearly passed for the wrong reason

`warda_kcc0020_tests.rs` runs all 17 scenarios against the draft pair — same
results as the table above — and then asks the question that matters: a grant
built for one layout, handed a coin of the other.

The first version of that test swapped only the HELD coin and left the payment
and change outputs on the grant's own layout. The token program then refused
its own transaction, both inputs errored, and the test passed. Green, proving
nothing: a refusal by the wrong input is the same mistake as a refusal for the
wrong reason. A fair cross-family transaction is self-consistent on the token
side, so the token has no complaint and whatever happens is the grant's answer.

```
cross-family:         token: ok | grant: InvalidIndex(-971)
wrong template hash:  token: ok | grant: VerifyError
```

Both refuse, and they refuse differently, which is worth recording:

- **A corrupted template hash, same program, same lengths** → `VerifyError`.
  The hash binds. This is the protection the design relies on.
- **The other family's token** → `InvalidIndex`. It never reaches the hash: the
  prefix/suffix lengths belong to a different program, so the read goes out of
  range first.

An out-of-range read is SAFE — an invalid transaction cannot be mined — and it
is not the same as being DETECTED. A layout whose template happened to have
compatible lengths would get past the arithmetic and be judged by the hash,
which is the check that means something. Today both paths refuse. Neither
allowed a wrong amount through in any scenario.

`cross_family_control` sits beside the refusal and requires the identical
transaction with the grant's own family to be ACCEPTED, because a grant that
refused everything would pass the refusal test and be useless.

### What this settles, and what it does not

**Settled:** a grant holds any token of its layout, refuses the other, and the
scheme byte is not a knob. Asset-agnostic means program-parameterised, one
source per layout.

**Not settled:** which layout the ecosystem lands on. KUSD follows the
silverscript example; the draft says otherwise, and there is an open issue
saying implementations do not match it either
(`Manyfestation/kcc20-live#1`). These scenarios are offered as conformance
vectors — `kaspanet/kccs#20` is asking for first-cut ones, and owner-scheme
bytes are listed there as future work.

**Not tested:** the draft's `borrowScheme` / `borrowGuard` / `extensionCommitment`
are carried in the state and never exercised; `kcc0020-token.sil` implements
conservation and the owner schemes and does not mint. It exists to test the
grant against the draft's SHAPE, not to be an implementation of the draft.

## Run the engine tests

From the warda repo root (the clone goes in `spike/kusd-grant/silverscript`, which is gitignored):

```
cd spike/kusd-grant
git clone https://github.com/kaspanet/silverscript && cd silverscript
git checkout 3ed973335b59269293564805cc2c58a14595ec03
cp ../warda-dollar-grant.sil ../warda-dollar-grant-0020.sil ../kusd-kcc20.sil ../kcc0020-token.sil silverscript-lang/tests/examples/
cp ../warda_dollar_grant_tests.rs ../warda_kusd_program_tests.rs ../warda_kcc0020_tests.rs silverscript-lang/tests/
cargo test -p silverscript-lang --test warda_dollar_grant_tests --test warda_kusd_program_tests --test warda_kcc0020_tests -- --nocapture
```

The first build takes about 8 minutes.
