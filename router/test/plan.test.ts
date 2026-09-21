import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, planFunding, missingFrom, type VenueConfig } from "../src/index.ts";
import { scriptHashToAddress } from "@warda_protocol/kaspa";

/* Derived, not typed: a literal address in a test is a checksum nobody verified. */
const payoutAddress = scriptHashToAddress(new Uint8Array(32).fill(7), "kaspatest");

/* $60 at $0.05/KAS is 1,200 KAS — over the bridge's 1,000 KAS minimum exit.
   A five-dollar crossing is blocked by the bridge, which bridge.test.ts covers. */
const q = quote({
  price: { asset: "USD", amount: "60.00" },
  rate: { perKas: "0.05", asset: "USD", source: "test-oracle", observedAt: 1 },
  slippageBps: 100,
  expiresAt: Date.now() + 30_000,
});

const venue: VenueConfig = {
  name: "Zealous Swap",
  chainId: 38836,
  addresses: { router: "0xrouter", token: "0xusdc" },
};
const bridge: VenueConfig = {
  name: "Igra bridge",
  chainId: 38836,
  addresses: { withdraw: "0xbridge" },
};

test("the router never holds a key, and the plan says so as a field", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge, payoutAddress });
  assert.equal(p.custody, "none");
  assert.ok(p.steps.every((s) => s.action !== "sign-and-submit" || s.describe.length > 0));
});

test("genesis is last, so the funding side enforces its recipient", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge, payoutAddress });
  assert.equal(p.route.hops[p.route.hops.length - 1]?.kind, "covenant");
  assert.equal(p.verdict.recipientEnforced, true);
  assert.equal(p.verdict.authorisedToPayMe, "yes");
});

test("getting there is still assumed, and the verdict does not hide it", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge, payoutAddress });
  assert.equal(p.verdict.zone, "assumed", "a swap and a bridge are on this route");
  assert.deepEqual(p.verdict.counterparties, ["Zealous Swap", "Igra bridge"]);
  assert.deepEqual(p.verdict.layers, ["igra", "kaspa-l1"]);
});

test("what the covenant enforces is unchanged by the hops in front of it", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge, payoutAddress });
  assert.ok(p.verdict.stillEnforced.includes("maxPerSpend"));
  assert.ok(p.verdict.stillEnforced.includes("budgetTotal"));
});

test("an unconfigured venue names what it wanted instead of looking executable", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" } });
  assert.equal(p.executable, false);
  assert.deepEqual(missingFrom(p), ["venue config", "bridge config", "payoutAddress"]);
  assert.equal(p.steps[0]?.ready, false);
  assert.equal(p.steps[3]?.ready, true, "genesis needs nothing from a venue");
});

test("a half-configured venue names the exact address it is short of", () => {
  const partial: VenueConfig = { name: "Zealous Swap", chainId: 38836, addresses: { router: "0xrouter" } };
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue: partial, bridge, payoutAddress });
  assert.deepEqual(missingFrom(p), ["venue.addresses.token"]);
  assert.equal(p.executable, false);
});

test("a fully configured plan is executable, and still holds no key", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge, payoutAddress });
  assert.equal(p.executable, true);
  assert.equal(p.custody, "none");
});

test("the irreversible step is called out to whoever is signing", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge, payoutAddress });
  const wait = p.steps.find((s) => s.action === "await-confirmation");
  assert.match(wait?.describe ?? "", /not reversible by retrying/);
});

test("no sompi in an instruction to a human — the same rule the exchange rail holds", () => {
  /* Caught by rendering the plan in the console, where step 1 read "worth at
     most 200000000000 sompi". rail.test.ts had this assertion for the other
     rail and nothing had it for this one. */
  const q = quote({
    price: { asset: "USD", amount: "100" },
    rate: { perKas: "0.05", asset: "USD", source: "test", observedAt: 0 },
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  const p = planFunding({ quote: q, from: { asset: "USDC", layer: "igra" } });
  for (const st of p.steps) {
    assert.ok(!/sompi/.test(st.describe), `step ${st.index} says sompi: ${st.describe}`);
  }
  assert.match(p.steps[0]!.describe, /2000 KAS/);
});

/* The direction bug. A funding crossing RECEIVES KAS, so slippage means less
   arrives — and the bridge's floor has to hold at the bottom of that range.
   planFunding checked it against the expected amount and quoted the payer's
   `maxSompi` as its bound; both were the right numbers for the other trade. */
const at = (usd: string, perKas: string, slippageBps: number) =>
  planFunding({
    quote: quote({
      price: { asset: "USD", amount: usd },
      rate: { perKas, asset: "USD", source: "test", observedAt: 0 },
      slippageBps,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }),
    from: { asset: "USDC", layer: "igra" },
  });

test("a crossing that clears the floor only before slippage is blocked, and says why", () => {
  // $50.20 at $0.05 is 1,004 KAS expected; at 1% slippage as little as 993.96 arrives.
  const p = at("50.20", "0.05", 100);
  assert.equal(p.blockers.length, 1, "the worst outcome in the range you allowed is a revert");
  assert.match(p.blockers[0]!, /slippage/);
  assert.match(p.blockers[0]!, /accept less slippage/);
});

test("the same crossing at no slippage clears", () => {
  assert.equal(at("50.20", "0.05", 0).blockers.length, 0);
});

test("below the floor even at the quoted rate is the other message", () => {
  const p = at("10", "0.05", 50);
  assert.match(p.blockers[0]!, /Crossing is a treasury operation/);
  assert.doesNotMatch(p.blockers[0]!, /accept less slippage/);
});

test("the swap step names what arrives, including the least of it", () => {
  const d = at("100", "0.05", 50).steps[0]!.describe;
  assert.match(d, /receiving 2000 KAS/);
  assert.match(d, /no less than 1990 KAS/);
});
