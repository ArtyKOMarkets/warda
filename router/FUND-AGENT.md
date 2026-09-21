# Fund an agent — the v1 stack, leg by leg

21 September 2026. Written from Arty's product brief ("fund an agent with whatever you already hold")
and checked against what exists today. It extends `router/DESIGN.md` and changes none of its decisions:
conversions sit at the edges of a relationship, authority is KAS, Warda holds nothing and takes nothing.

## The product sentence

> Fund an agent with the stablecoin you already hold. Warda turns it into bounded spending authority on Kaspa.

A developer with USDC on Base should not have to buy KAS, find a bridge, find a Kaspa exchange, move KAS
between wallets and then create a grant. They connect, type $100, and press **Fund agent**. The route —
bridge, swap, exit — is the router's to choose and is shown folded, under *Route details*.

What the page says instead of "router": **You pay 100 USDC on Base → agent spending authority ≈ X KAS**,
with the agent's terms (per payment, expiry) beside it. This is live in `/app` as of this commit.

## The route engine

    input asset + chain ─▶ routes that start there ─▶ each leg's status ─▶ quote ─▶ plan ─▶ you sign each step

- **A route is a list of legs; a leg is replaceable.** Bridge, swap, exit and genesis are separate legs
  with their own venue, status, minimum and zone (enforced / attested / assumed). Swapping Hyperlane for
  Dymension, or Zealous for another pool, is a data change, not a rewrite.
- **A route is only as available as its worst leg**, and the page lists every reason it is not available,
  not the first.
- **Status is dated.** `site/src/routes.json` carries `checkedAt`; older than 14 days and `/app` shows
  every leg as *unchecked* rather than repeating a stale "live". Next: move the table into
  `router/src/routes.ts` so the planner, the CLI and the page read one copy, and have an ops check probe
  each leg (Hyperlane's pausable ISM is readable on-chain).
- **The expiry condition still holds.** When a covenant-native stablecoin exists (KCC-20), a grant holds it
  directly and the bridge and swap legs disappear. The route engine is the part designed to be deleted.

## The legs, verified today

| leg | venue | status (21 Sep 2026) | what limits it |
|---|---|---|---|
| wallet | EIP-6963 extensions, WalletConnect `eip155` | **built** in `/app` | read-only today |
| bridge in | Hyperlane warp routes → Igra: USDC from Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche; USDT from Ethereum | **paused since 20 Sep** — Igra's pausable ISM and hook paused on-chain; Hyperlane pulled Igra from its UI and router allowlist ([registry #1713](https://github.com/hyperlane-xyz/hyperlane-registry/pull/1713)) | minutes per crossing; cause of the pause not published |
| swap | Zealous Swap, USDC/iKAS on Igra mainnet | **live** — thin: the USDC pair is under 5% of the venue's volume ([CoinGecko](https://www.coingecko.com/en/exchanges/zealous-swap-igra)) | slippage; a large order moves it |
| exit | Igra `KasExitBridge.requestExit` | **live** (mainnet proxy `0x4bb8…d0` in DESIGN.md) | **1,000 KAS minimum per exit** |
| genesis | a v1 covenant transaction signed by the principal's **Kaspa** key | **works** from the CLI and from the Warda Console extension (issued a real grant on testnet 13 Sep) | needs a Kaspa key — see below |

Testnet has **no route at all**: Galleon has no USDC venue and no published exit bridge. `/app` says so and
points at the faucet.

**BSC is not in v1.** Igra's Hyperlane routes do not include it. The BNB path that exists is Chainge's wKAS,
which is custodial (DCRM) and delivers wKAS, not a KAS UTXO.

**Dymension's bridge SDK is the second route to watch, not the first.** Hub ↔ Kaspa is manually tested;
every EVM route is marked experimental, and the SDK builds transactions without signing or sending them
([bridge-sdk](https://github.com/dymensionxyz/bridge-sdk)). It fits the leg model as an alternative bridge
once an EVM route leaves experimental.

## Three things the brief runs into

**1. The 1,000 KAS exit floor sets a minimum funding.** A $100 funding clears it only while KAS is above
$0.10. Below the floor the page says so and shows the dollar figure the route starts at. Batching several
people's fundings into one exit would clear it, and would make Warda the custodian of the batch — the one
thing DESIGN.md rules out. So: the floor is shown, not hidden.

**2. The grant needs a Kaspa key, and a MetaMask user has none.** The KAS lands at a Kaspa address and the
genesis is signed by the principal's Schnorr key. The options, best first:

- **Warda Console extension holds it.** Already proven to build, sign and submit a genesis. Self-custody,
  one install. This is the recommendation.
- KasWare or Kaspire, if either can sign a v1 covenant transaction — unverified; one testnet attempt each
  answers it.
- A key derived from a MetaMask signature — rejected. Any site that asks for the same message gets the key.
- Warda holds the key — rejected. That is custody.

**3. The reverse direction is not a route inside a payment.** DESIGN.md settled this: routing the seller's
output puts a counterparty into the only hop that has none, and costs `authorisedToPayMe`. What can be
offered is a **cash-out tool the seller runs afterwards** with their own key — the same legs reversed
(L1 → Igra, swap, Hyperlane out). A convenience after the payment, never part of it.

## What executing it means (next build)

Every step is a transaction the person signs in their own wallet. Warda signs nothing and holds nothing.

1. **Source chain:** approve + `transferRemote` on the Hyperlane warp route, to the same address on Igra.
2. **Wait** for delivery on Igra (the page watches the balance).
3. **Igra:** the wallet switches chain (the console already adds Igra if the wallet does not know it), then
   approve + swap on Zealous with `minOut` from the quote's slippage bound.
4. **Igra:** `requestExit` on KasExitBridge, payout to the principal's Kaspa address, checked in full here
   because the bridge checks only prefix and charset.
5. **Wait** for the KAS on L1.
6. **Kaspa:** genesis, signed by the principal key (extension or CLI), with the terms from step one.

Before any of it ships: every contract address comes from a verified registry entry (the router's
no-baked-addresses guard already refuses literals), and a dry run against a fork of each chain.

## What unblocks what

- Hyperlane un-pausing Igra reopens every chain but Igra itself. Until then, only USDC **already on Igra** has a route.
- Execution adapters (steps 1–5) are the build; the page and the plan model exist.
- A Kaspa signer in the browser for EVM-first users: the extension, wired to `/app`.

## Around the Hyperlane pause (added 21 September, same day)

Nobody has published why Igra's Hyperlane was paused or when it reopens, so the product cannot wait on it.
Three changes, all in `/app` and `site/src/routes.json`:

1. **More than one route per chain, chosen per funding.** Each source chain now offers every route it has:
   *Through Igra* (no custodian), *Instant swap* via ChangeNOW (custodial for the minutes of the swap, native
   KAS to your L1 address, no 1,000 KAS floor), and *Dymension* (5-of-9 validator escrow, EVM legs
   experimental). The page preselects the best open route with no custodian, falls back to the best open one,
   and a custodial route needs a tick in a box that names the custodian.
2. **The pause is read, not remembered.** `ops/check-routes.mjs` calls `paused()` on Igra's pausable ISM
   (`0x238b…98e2`) and hook (`0x74B2…37da`) over Igra's RPC and writes the leg's status into `routes.json`. A
   failed read changes nothing and exits non-zero — "could not reach the RPC" never looks like "open".
3. **USDC already on Igra keeps a route** (*Already on Igra*): swap and exit, no bridge in.

Next: run `check-routes` from the refresh cron, and move the route table into `router/src/routes.ts`.
