import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, planFunding, missingFrom, type VenueConfig } from "../src/index.ts";

const q = quote({
  price: { asset: "USD", amount: "5.00" },
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
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge });
  assert.equal(p.custody, "none");
  assert.ok(p.steps.every((s) => s.action !== "sign-and-submit" || s.describe.length > 0));
});

test("genesis is last, so the funding side enforces its recipient", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge });
  assert.equal(p.route.hops[p.route.hops.length - 1]?.kind, "covenant");
  assert.equal(p.verdict.recipientEnforced, true);
  assert.equal(p.verdict.authorisedToPayMe, "yes");
});

test("getting there is still assumed, and the verdict does not hide it", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge });
  assert.equal(p.verdict.zone, "assumed", "a swap and a bridge are on this route");
  assert.deepEqual(p.verdict.counterparties, ["Zealous Swap", "Igra bridge"]);
  assert.deepEqual(p.verdict.layers, ["igra", "kaspa-l1"]);
});

test("what the covenant enforces is unchanged by the hops in front of it", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge });
  assert.ok(p.verdict.stillEnforced.includes("maxPerSpend"));
  assert.ok(p.verdict.stillEnforced.includes("budgetTotal"));
});

test("an unconfigured venue names what it wanted instead of looking executable", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" } });
  assert.equal(p.executable, false);
  assert.deepEqual(missingFrom(p), ["venue config", "bridge config"]);
  assert.equal(p.steps[0]?.ready, false);
  assert.equal(p.steps[3]?.ready, true, "genesis needs nothing from a venue");
});

test("a half-configured venue names the exact address it is short of", () => {
  const partial: VenueConfig = { name: "Zealous Swap", chainId: 38836, addresses: { router: "0xrouter" } };
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue: partial, bridge });
  assert.deepEqual(missingFrom(p), ["venue.addresses.token"]);
  assert.equal(p.executable, false);
});

test("a fully configured plan is executable, and still holds no key", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge });
  assert.equal(p.executable, true);
  assert.equal(p.custody, "none");
});

test("the irreversible step is called out to whoever is signing", () => {
  const p = planFunding({ quote: q, from: { asset: "USDC.e", layer: "igra" }, venue, bridge });
  const wait = p.steps.find((s) => s.action === "await-confirmation");
  assert.match(wait?.describe ?? "", /not reversible by retrying/);
});
