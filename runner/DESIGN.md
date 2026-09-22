# Warda Runner — design

The runner is what makes Warda more than an authorization layer: it holds an
agent's key, watches its grant, and runs workflows for it — **inside** the
grant. The agent decides what it wants to do; the grant decides what it is
allowed to do; Kaspa decides whether the transaction is valid.

It exists for onboarding. Today a first payment needs KAS, three keys, a node,
a manifest on disk and a cron job. With the runner it needs: sign in, create
an agent, set limits, fund it from a phone wallet, paste an MCP URL.

## The key model — the whole security argument

| key | where it lives | what the runner can do with it |
|---|---|---|
| **agent** | the runner's vault, encrypted at rest | sign spends the covenant allows — nothing else |
| **deposit** (one per agent) | the runner's vault | sign ONE genesis: the whole deposit into a grant whose principal and revocation are the owner's. Holds nothing afterwards |
| principal / funder | the owner's wallet | nothing. Never sent to the runner |
| revocation | the owner's wallet | nothing. Never sent to the runner |

A breach of the runner loses **at most what the grants it holds could still
spend**, and the owner can revoke every one of them without the runner. That
bound is set by consensus, not by our ops. It is the sentence that goes on the
landing page and in the audit scope.

**Funding from any wallet.** No phone wallet can build a covenant genesis,
but every wallet and exchange can send KAS to an address. So the owner sends
the amount the runner quotes (budget + genesis fee + a buffer the grant's own
spend fees come out of) to a single-use deposit address, and the runner turns
that coin into the grant in one transaction (`src/funding.ts`). The honest
cost: between the deposit arriving and the genesis confirming — usually under
a minute — the runner controls the deposit outright. Every page offering this
says so. A retried genesis is rebuilt from the recorded inputs, so it is the
same transaction and never a second grant.

Anything that needs an owner key — top up, renew, revoke — is an
**approval**: the runner writes a request, notifies the owner, and the owner
signs it in their own wallet (WalletConnect on the phone). The runner proposes;
it never acts as the owner. `ops/check-runner.mjs` fails the build if anything
under `runner/src` can reach a principal or revocation key, or if any action
other than `approval` is declared owner-level.

### Vault: Turnkey (MPC), envelope as the fallback

`KeyVault` is an interface with one job: create an agent key, and hand back a
`Signer` for it. Every signature is verified against the agent key the grant
names before it leaves the vault.

- **`TurnkeyVault` (default).** Proven on 22 September 2026 by
  `spike/turnkey-schnorr.ts` against a real Turnkey organisation:
  `signRawPayload` with a Taproot (P2TR) account as `signWith` and
  `HASH_FUNCTION_NO_OP` returns a 64-byte **BIP340** signature over our raw
  32-byte sighash, valid under the address's **tweaked output key**. The grant
  names that output key as its agent key, so only Turnkey can spend it and the
  runner never sees a secret. A Spark account also passed, untweaked; P2TR is
  used because it is Turnkey's documented Schnorr path. The vault signs once at
  creation and refuses to store a key it has not seen verify.
- **`EnvelopeVault` (fallback, tests, local).** A 32-byte key sealed with
  AES-256-GCM under a `MasterKey`, which a cloud KMS can replace.

Before mainnet: a Turnkey **policy** restricting the runner's API key to
`SIGN_RAW_PAYLOAD` on agent wallets only, so a leaked runner credential cannot
create, export or delete anything.

## Workflows

```json
{
  "agent": "agent-009",
  "name": "Buy the digest every morning",
  "trigger": { "type": "schedule", "cron": "23 9 * * *" },
  "if":   [ { "field": "grant.availableKas", "op": ">=", "value": 0.5 } ],
  "then": [
    { "type": "pay-x402", "url": "https://warda-demo-api.vercel.app/digest", "maxKas": "0.2" },
    { "type": "notify", "channel": "telegram", "to": "@me", "text": "Bought it. {{grant.availableKas}} KAS left." }
  ]
}
```

**Triggers:** `schedule` (5-field cron, UTC), `webhook` (secret URL),
`grant` (`budget-below` %, `expiring-within` hours — edge-triggered, with the
three states from `ops/alerts.sh`: clear, firing, **undecided**), `manual`
(console or MCP).

**Actions and the authority each needs:**

| action | authority | checked before it runs |
|---|---|---|
| `pay-x402` | agent | invoice ≤ `maxKas` ≤ per-payment cap ≤ what is uncommitted after fees owed |
| `send` | agent | payee on the allowlist, same amount checks |
| `notify`, `http` | none | — |
| `approval` (`topup` / `renew` / `revoke`) | **owner** | becomes a request; never executed here |

The check before a payment is a preflight, not the guarantee — the covenant is
the guarantee. The preflight exists so a refusal is a sentence in the run log
instead of a failed transaction and a spent fee.

**The #005 rule, built in.** A payment action records its txid the moment it
is broadcast, before waiting for the vendor. A run with a recorded txid is
never paid again; delivery is a separate question the resume path answers.
Runs are keyed (`workflow + schedule slot` or the webhook's idempotency key),
so a retry or a restart cannot pay twice for one slot. A missed schedule runs
the **latest** missed slot once and logs the rest as missed — no catch-up storm.

## Fees: a flat fee per run, out of the agent's own grant

The runner is one allowlisted payee. Each run that executes at least one action
accrues `perRunSompi`. It is **not** paid per run: every covenant spend carries
its own network fee (~0.015 KAS today), which would cost more than the fee.
Accrued fees settle in one payment when they reach `settleAtSompi`, and before
a grant expires.

Accrued-but-unsettled fees are treated as committed: a workflow cannot spend
them. A grant whose allowlist lacks the runner can still be watched and
notified about, but cannot run paying workflows — the console says so when the
grant is created, which is the only moment the allowlist can change.

It is a fee per execution, never a percentage of what the agent spends.

## What is built, and what is next

Built (`runner/src`): workflow parsing and validation, cron, the engine
(triggers → conditions → actions, preflight, run log, fee accrual and
settlement), `EnvelopeVault`, an in-memory store, and `live.ts` wiring the
engine to `@warda_protocol/agent` (which gained `pay()` for invoice-less
sends). 22 runner tests, 2 new wallet e2e tests, `check-runner` in CI.

Next, in order:

1. **Store on Postgres** (Neon) behind the same `Store` interface; accounts.
2. **HTTP API + worker**: `POST /agents`, `POST /workflows`, `POST /hooks/:id`,
   a one-minute tick. Vercel for the API; the tick needs a real worker
   (Fly/Railway) or QStash.
3. **MCP auth**: per-agent token on `mcp.wardaprotocol.com`; tools
   `get_authority`, `pay`, `create_workflow`, `list_workflows`,
   `run_workflow`, `get_runs`.
4. **Console**: Create agent → template → limits (runner added to payees) →
   fund from phone wallet → MCP URL. Run log per agent. Approvals inbox.
5. **Plain English → workflow JSON**, confirmed as a card before it is saved.
