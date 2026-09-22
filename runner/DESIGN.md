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
| principal / funder | the owner's wallet | nothing. Never sent to the runner |
| revocation | the owner's wallet | nothing. Never sent to the runner |

A breach of the runner loses **at most what the grants it holds could still
spend**, and the owner can revoke every one of them without the runner. That
bound is set by consensus, not by our ops. It is the sentence that goes on the
landing page and in the audit scope.

Anything that needs an owner key — top up, renew, revoke — is an
**approval**: the runner writes a request, notifies the owner, and the owner
signs it in their own wallet (WalletConnect on the phone). The runner proposes;
it never acts as the owner. `ops/check-runner.mjs` fails the build if anything
under `runner/src` can reach a principal or revocation key, or if any action
other than `approval` is declared owner-level.

### Vault: envelope now, MPC when it can sign for Kaspa

`KeyVault` is an interface with one job: create an agent key, and hand back a
`Signer` for it. Every signature is verified against the agent key the grant
names before it leaves the vault.

- **`EnvelopeVault` (now).** A fresh 32-byte agent key per agent, sealed with
  AES-256-GCM under a master key. The master key is a `MasterKey`, so a cloud
  KMS (AWS `Encrypt`/`Decrypt`, GCP KMS) replaces the local one without
  touching the vault. Testnet can run on the local master key.
- **MPC (Turnkey) — spike first.** MPC is easier to *explain* ("no single
  machine ever holds the key") and gives export/recovery for free. It is not
  easier to *build*, and the blocker is specific: Kaspa signs a raw 32-byte
  sighash with **BIP340 Schnorr**. Turnkey's raw-payload signing is ECDSA; its
  Schnorr is reached through Taproot addresses, where the key is **tweaked**
  automatically. That is workable — the covenant can bake in the tweaked
  output key, which is what the signature verifies against — but it has to be
  proven on a real digest before anything depends on it.
  `spike/turnkey-schnorr.ts` is that proof: it asks Turnkey to sign a digest
  with a P2TR account and checks the result with the same `verifyDigest` the
  payer uses. If it passes, `TurnkeyVault` is ~60 lines behind the same
  interface. If it fails, envelope + KMS ships to mainnet.

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
