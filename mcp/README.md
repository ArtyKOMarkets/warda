# @warda_protocol/mcp

An MCP server that lets an agent framework reason about its own economic
authority — and now get a ready-to-sign payment without a Kaspa integration.

```bash
node --experimental-strip-types src/server.ts    # stdio
npm test                                          # 17 tests, real transport
```

## It builds. It does not sign, and it does not enforce.

`warda_build_spend` returns an unsigned transaction and the digest to sign.
**This server never sees a key.** Whoever holds the agent key signs the digest
wherever that key lives, splices the 65 bytes into the fixed-width slot, and
broadcasts. An MCP server that signed would be a custodian, and the point of
Warda is that nobody has to be.

A test asserts the signature slot in every built transaction is still 65 zero
bytes, and that no key material appears anywhere in the response.

## This does not enforce anything

An agent is free to ignore every answer this server gives, build the
transaction anyway, and broadcast it. **The covenant will refuse it.** Warda's
security has never depended on the agent asking permission first — that is the
entire premise, and a server that implied otherwise would contradict the
protocol it serves.

Every response says so, in a field called `enforcement`, and a test asserts it
is there.

## So what is it for

- **Headroom.** An agent planning a purchase needs the largest payment it may
  currently make. That is not any single field — it is the minimum of remaining
  budget, epoch headroom, and per-transaction cap. `warda_grant_authority`
  computes it.
- **Not wasting transactions.** A spend the covenant will refuse costs a fee and
  a round trip. Checking first is cheaper.
- **Rejections in words.** On-chain, every failed rule collapses into one opaque
  script error. Here a refusal names the rule and says what to do about it —
  *"larger than the per-transaction cap; split it or ask the principal to raise
  the cap"* rather than `VerifyError`.
- **Discovery.** A framework speaking MCP finds Warda without a custom
  integration, which is the point of §20 in the spec.

## The rules live in one place

Every verdict comes from `@warda_protocol/core` — the same code the covenant was
verified against, sharing the same 45 tests. This server carries **no copy of
the protocol rules.**

That constraint is deliberate. A second implementation of the rules would drift,
and the failure mode is bad in both directions: telling an agent it may spend
when the chain will refuse wastes money, and telling it that it may not when the
chain would allow it silently strands funds. One source, or none.

## Tools

| Tool | Answers |
|---|---|
| `warda_grant_authority` | What may this agent spend right now? |
| `warda_check_spend` | Would this payment be accepted, and if not, why? |
| `warda_check_delegation` | Is this child grant a legal narrowing? |
| `warda_build_spend` | Give me the bytes to sign for this payment. |

`warda_build_spend` builds the transaction **even when the advisory verdict says
no**, and reports the verdict alongside. That direction is deliberate: a local
rule that is too strict must not be able to block a payment the chain would
accept. Refusing costs a fee; blocking costs a capability.

It does refuse one thing outright — a payee that is not on the allowlist. No
proof places it in the tree, so no valid transaction exists; fabricating a
borrowed proof would make the covenant's rejection look like a bug in the tree
rather than a payee that is not on the list.

## Wiring it up

```json
{
  "mcpServers": {
    "warda": {
      "command": "node",
      "args": ["--experimental-strip-types", "/path/to/warda/mcp/src/server.ts"]
    }
  }
}
```

## Where the bytes come from

`warda_build_spend` assembles through `@warda_protocol/kaspa`, which is checked against
`golden-spend.json` — a reference transaction produced by the same Rust path
that put a spend on testnet-10. `mcp/test/build.test.ts` closes the last gap:
it describes that same grant the way an agent framework would, in decimal KAS
and named recipients, and requires the result to come out byte-identical.

That matters because three things sit between the two vocabularies — a decimal
parser, a Merkle tree built by different code than the SDK's, and a struct laid
out by field order. None of them is a rule, so none can wrongly permit a spend.
All of them can produce bytes the chain refuses, silently, and only when real
money is at stake.

## Not built yet

**No chain access.** The server cannot find the grant's current UTXO — you pass
it in. A grant's address moves after every spend, so a stale UTXO will simply
not be found.

**No broadcasting.** A built spend is an ordinary transaction; submit it with
whatever node client you already have.

**The template is not a parameter, on purpose.** It is loaded from disk
(`WARDA_TEMPLATE` overrides the path). A caller-supplied template is the
softest attack surface in the protocol: swap it and every address is wrong, so
the grant pays into a script nobody can ever spend.
