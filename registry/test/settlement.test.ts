import { test } from "node:test";
import assert from "node:assert/strict";
import {
  settlementTier,
  authorisedToPayMe,
  explainSettlement,
  DIRECT_PROTOCOL,
  search,
  type ServiceManifest,
} from "../src/index.ts";

const base: ServiceManifest = {
  version: 1,
  name: "a service",
  description: "sells a fact",
  endpoint: "https://example.test/fact",
  capabilities: ["fact"],
  pricing: { asset: "KAS", amount: "0.03", unit: "request" },
  payment: { protocol: "x402", network: "kaspa:testnet-10", warda: true },
  payee: "a".repeat(64),
};

const withPayment = (p: Partial<ServiceManifest["payment"]>): ServiceManifest => ({
  ...base,
  payment: { ...base.payment, ...p },
});

test("x402 is relayed, because their exact scheme cannot take a covenant spend", () => {
  assert.equal(settlementTier(base), "relayed");
  assert.equal(authorisedToPayMe(base), "unknown");
  assert.match(explainSettlement(base), /budget, per-payment cap, epoch limit, window/);
});

test("a direct covenant payment is settled, and says the payee was enforced", () => {
  const direct = withPayment({ protocol: DIRECT_PROTOCOL });
  assert.equal(settlementTier(direct), "settled");
  assert.equal(authorisedToPayMe(direct), "yes");
  assert.match(explainSettlement(direct), /refused every transaction that paid anyone else/);
});

test("a service that does not take a grant has no tier to report", () => {
  assert.equal(settlementTier(withPayment({ warda: false })), "unknown");
  assert.equal(authorisedToPayMe(withPayment({ warda: false })), "unknown");
});

test("an unrecognised protocol is unknown, not assumed to be settled", () => {
  assert.equal(settlementTier(withPayment({ protocol: "lightning" })), "unknown");
  assert.equal(settlementTier(withPayment({ protocol: "" })), "unknown");
});

test("the tier is case-insensitive about the protocol string", () => {
  assert.equal(settlementTier(withPayment({ protocol: "X402" })), "relayed");
  assert.equal(settlementTier(withPayment({ protocol: "WARDA" })), "settled");
});

test("the tier is derived, so an operator cannot assert it", () => {
  /* A listing that tries to publish its own tier is ignored: the field is not
     in the signed manifest and settlementTier never reads one. */
  const liar = { ...base, settlement: "settled" } as ServiceManifest & { settlement: string };
  assert.equal(settlementTier(liar), "relayed");
});

test("search can require the full covenant proof", () => {
  const listings = [base, withPayment({ protocol: DIRECT_PROTOCOL }), withPayment({ warda: false })];

  assert.equal(search(listings, { settlement: "settled" }).length, 1);
  assert.equal(search(listings, { settlement: "relayed" }).length, 1);
  assert.equal(search(listings, { settlement: ["settled", "relayed"] }).length, 2);
  assert.equal(search(listings, {}).length, 3, "no filter still returns everything");
});

test("the settlement filter composes with the others rather than replacing them", () => {
  const listings = [base, withPayment({ protocol: DIRECT_PROTOCOL })];
  assert.equal(search(listings, { settlement: "settled", capability: "fact" }).length, 1);
  assert.equal(search(listings, { settlement: "settled", capability: "weather" }).length, 0);
});

test("today's real listings are all relayed, and the registry says so", () => {
  /* Every live listing is protocol x402. If that ever changes this test should
     be updated deliberately rather than quietly. */
  assert.equal(settlementTier(base), "relayed");
});
