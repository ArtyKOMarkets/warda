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

test("kaspa-x402 is relayed, because THEIR exact scheme cannot take a covenant spend", () => {
  const kx = withPayment({ protocol: "kaspa-x402-v2" });
  assert.equal(settlementTier(kx), "relayed");
  assert.equal(authorisedToPayMe(kx), "unknown");
  assert.match(explainSettlement(kx), /budget, per-payment cap, epoch limit, window/);
});

test("plain x402 with warda:true is SETTLED — the family name decides nothing", () => {
  /* Agent #006 paid warda-demo-api.vercel.app/fact on 17 September with no
     relay: a covenant spend straight to an allowlisted payee, in
     c8e2b9f990351fb0863303c2089bf37bf11f447984872395a7a6c5be48f489ac. The
     first version of this file called that "relayed", which told a buyer the
     chain had not constrained the payee when it had. */
  assert.equal(settlementTier(base), "settled");
  assert.equal(authorisedToPayMe(base), "yes");
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

test("a missing protocol is unknown; warda:false is unknown whatever it says", () => {
  assert.equal(settlementTier(withPayment({ protocol: "" })), "unknown");
  assert.equal(settlementTier(withPayment({ warda: false, protocol: "warda" })), "unknown");
});

test("the tier is case-insensitive about the protocol string", () => {
  assert.equal(settlementTier(withPayment({ protocol: "KASPA-X402-V2" })), "relayed");
  assert.equal(settlementTier(withPayment({ protocol: "WARDA" })), "settled");
});

test("the tier is derived, so an operator cannot assert it", () => {
  /* A listing that tries to publish its own tier is ignored: the field is not
     in the signed manifest and settlementTier never reads one. */
  const liar = { ...withPayment({ protocol: "kaspa-x402-v2" }), settlement: "settled" } as
    ServiceManifest & { settlement: string };
  assert.equal(settlementTier(liar), "relayed");
});

test("search can require the full covenant proof", () => {
  const listings = [
    withPayment({ protocol: "kaspa-x402-v2" }),
    withPayment({ protocol: DIRECT_PROTOCOL }),
    withPayment({ warda: false }),
  ];

  assert.equal(search(listings, { settlement: "settled" }).length, 1);
  assert.equal(search(listings, { settlement: "relayed" }).length, 1);
  assert.equal(search(listings, { settlement: ["settled", "relayed"] }).length, 2);
  assert.equal(search(listings, {}).length, 3, "no filter still returns everything");
});

test("the settlement filter composes with the others rather than replacing them", () => {
  const listings = [withPayment({ protocol: "kaspa-x402-v2" }), withPayment({ protocol: DIRECT_PROTOCOL })];
  assert.equal(search(listings, { settlement: "settled", capability: "fact" }).length, 1);
  assert.equal(search(listings, { settlement: "settled", capability: "weather" }).length, 0);
});

test("today's real listings are settled, and there is a payment proving it", () => {
  /* All three live listings are the Warda demo vendor: protocol x402,
     warda: true, and it accepts a covenant spend — demonstrated by agent
     #006's purchase rather than assumed from the manifest. */
  assert.equal(settlementTier(base), "settled");
  assert.equal(authorisedToPayMe(base), "yes");
});
