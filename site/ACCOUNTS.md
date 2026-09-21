# Console accounts — what a server would hold, and what it must never

21 September 2026. A design note for a decision, not a build. Today an account in `/app` is a connected
wallet plus what that browser stores; this is what changes when the console gets a server, which it needs
before it can be the paid product.

## What stays true

- **MCP, SDK and CLI stay free.** The console is the paid surface.
- **No percentage of payments, ever.** Warda is not in the payment path and has no position in it.
- **Warda never holds money or keys.** No private key, seed, agent key or payment float is ever sent to
  or stored by the server. Every value-moving step is signed in the person's own wallet.
- **Everything works without an account.** Local mode — wallet connect, tracked grants in the browser,
  every read — is what `/app` is today and stays free. An account adds sync, alerts and history.

## Signing in — now there is somebody to prove it to

Until now the console refused a wallet sign-in: a signature nobody checks is a ritual that trains people
to sign things. A server checks it, so the objection goes away.

- **EVM wallets:** Sign-In with Ethereum (EIP-4361). Plain text, domain-bound, single-use nonce.
- **Kaspa wallets:** the same message shape, signed with KasWare `signMessage` or Kaspire
  `kaspa_signPersonal`; the server verifies the Schnorr signature against the address's key.
- The message says, in words, that it cannot move funds. No signing method that can move funds is ever
  requested for sign-in.
- **One account, several wallets.** A MetaMask address and a Kaspa address link to one account by signing
  the same link challenge with both. That is also how an EVM-first user ends up with the Kaspa key a grant
  needs attached to the same account.
- Session: httpOnly, SameSite=Strict cookie; nonce valid 5 minutes and used once.

## What the server stores

| stored | why | sensitivity |
|---|---|---|
| account id, created date, plan | the account | low |
| linked wallet addresses | sign-in, "your grants" | **public on chain, private as a set** — it links addresses to one person |
| tracked grant manifests | sync across devices | public keys and limits, no secrets (the page already refuses a file with a secret-named field); still reveals which grants are yours |
| alert rules and channels (Telegram chat id, email) | alerts | personal |
| alert and reading history | the history a local page cannot keep | low |
| billing reference (processor customer id) | billing | processor holds card data, not Warda |

**Never stored:** private keys, seeds, agent keys, card numbers, anything a grant's spend needs.

Export and delete are one button each, and delete means deleted.

## What the server does

- **Alerts per account.** `ops/alerts.ts` already reads grants and sends Telegram; it becomes a job that
  runs each account's rules (balance, budget low, expiry near, grant moved, refusals), every 15 minutes as
  the cron does now.
- **Follows moved grants.** A tracked manifest goes stale on every payment; the server runs the same
  `follow-grant` read and updates the stored manifest, so "not at this state" stops being the user's job.
- **History.** Readings over time, so the Overview can chart a tracked grant, not only a published one.
- It reads through the verifier and a node like everything else. It enforces nothing: the covenant does.

## Billing — the options

1. **Card, via a processor (Stripe).** Monthly subscription. Least friction for companies; the processor
   holds card data.
2. **KAS, paid by a Warda grant.** The subscription *is* a grant: Warda's address in the allowlist, the
   monthly price as the epoch limit, twelve months as the term. The customer's own covenant caps what
   Warda can ever take, and revoking it cancels. Warda receives revenue; it never holds the customer's
   funds. It is also the best demonstration of the product there could be.
3. **Both.** Card for companies, a grant for crypto-native teams.

## Plans, as a starting point

| | Free | Pro | Team |
|---|---|---|---|
| wallet connect, reads, tracked grants in the browser | ✓ | ✓ | ✓ |
| synced tracked grants | — | ✓ | ✓ |
| alerts (Telegram, email) | — | ✓ | ✓ |
| history and charts for tracked grants | — | ✓ | ✓ |
| several people, one account; roles | — | — | ✓ |

## Infrastructure, smallest that works

Vercel functions next to the static site (it is already deployed there) and one Postgres database
(Neon or Supabase). The alerts job as a scheduled function. No new service in the payment path —
there is no payment path through Warda.

## Decisions for Arty

1. Billing: card, a KAS grant, or both.
2. Email: optional (alerts, receipts), or required at sign-up.
3. Where it runs: Vercel + Postgres as above, or next to the verifier on the node host.
4. Whether tracked manifests sync by default, or only when the person turns sync on (privacy: the set of
   grants reveals who funds what).
5. Price points for Pro and Team.
