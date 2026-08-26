# @warda/mcp

An MCP server that lets an agent framework reason about its own economic
authority.

```bash
node --experimental-strip-types src/server.ts    # stdio
npm test                                          # 8 tests, real transport
```

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

Every verdict comes from `@warda/core` — the same code the covenant was
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

## Not built yet

Read-only. There is no `warda_request_payment` that builds and submits a spend,
because that needs chain access and a signing key — and handing an MCP server a
signing key deserves more thought than it has had. The reasoning half is useful
on its own and carries none of that risk.
