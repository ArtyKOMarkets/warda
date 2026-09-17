import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quote,
  planExchangeFunding,
  fundingReceipt,
  formatReceipt,
  assertRecipientEnforced,
  type GrantTerms,
} from "../src/index.ts";
import { scriptHashToAddress } from "@warda_protocol/kaspa";

const fundingAddress = scriptHashToAddress(new Uint8Array(32).fill(3), "kaspatest");

const q = quote({
  price: { asset: "USD", amount: "25.00" },
  rate: { perKas: "0.05", asset: "USD", source: "test-oracle", observedAt: 1 },
  expiresAt: Date.now() + 30_000,
});

const rail = (over: Record<string, unknown> = {}) =>
  planExchangeFunding({
    from: { asset: "USDC", venue: "an exchange" },
    grant: { budgetSompi: 50_000_000_000n, feeSompi: 3_000_000n },
    quote: q,
    fundingAddress,
    expectPrefix: "kaspatest",
    ...over,
  } as never);

const terms: GrantTerms = {
  address: scriptHashToAddress(new Uint8Array(32).fill(9), "kaspatest"),
  budgetSompi: 50_000_000_000n,
  maxPerSpendSompi: 5_000_000n,
  epochLimitSompi: 25_000_000_000n,
  expiresAtDaa: 123_456_789n,
  delegationDepth: 2,
};

test("the rail needs no venue address and crosses no bridge", () => {
  const p = rail();
  assert.equal(p.custody, "none");
  assert.deepEqual(p.route.hops.map((h) => h.kind), ["swap", "transfer", "covenant"]);
  assert.ok(!p.route.hops.some((h) => h.kind === "bridge"), "nothing crosses a bridge here");
});

test("genesis is last, so the grant's recipient is enforced", () => {
  const p = rail();
  assert.equal(p.verdict.recipientEnforced, true);
  assert.equal(p.verdict.authorisedToPayMe, "yes");
  assert.doesNotThrow(() => assertRecipientEnforced(p.route));
});

test("the two steps Warda cannot see are marked as such, not dressed up", () => {
  const p = rail();
  const offProtocol = p.steps.filter((s) => s.action === "off-protocol");
  assert.equal(offProtocol.length, 2, "the sale and the withdrawal");
  assert.match(offProtocol[0]!.describe, /Warda cannot see this step/);
});

test("the single-input constraint is stated where somebody would trip on it", () => {
  const p = rail();
  assert.equal(p.singleInput, true);
  const withdraw = p.steps.find((s) => s.describe.includes("withdraw"));
  assert.match(withdraw!.describe, /ONE withdrawal/);
  assert.match(withdraw!.describe, /biggest coin, not its balance/);
});

test("the amount to withdraw covers the fee, not just the budget", () => {
  const p = rail();
  assert.equal(p.requiredSompi, 50_003_000_000n);
});

test("a funding address with a bad checksum is refused before any plan exists", () => {
  assert.throws(() => rail({ fundingAddress: "kaspatest:nope" }), /does not verify/);
});

test("a mainnet funding address in a testnet plan is refused", () => {
  const mainnet = scriptHashToAddress(new Uint8Array(32).fill(3), "kaspa");
  assert.throws(() => rail({ fundingAddress: mainnet }), /does not check which network/);
});

test("a grant with no budget authorises nothing and is refused", () => {
  assert.throws(() => rail({ grant: { budgetSompi: 0n, feeSompi: 0n } }), /authorises nothing/);
});

test("the receipt separates what consensus refused from what somebody promised", () => {
  const r = fundingReceipt(rail().route, q, terms);
  const enforced = r.claims.filter((c) => c.zone === "enforced");
  const attested = r.claims.filter((c) => c.zone === "attested");
  const assumed = r.claims.filter((c) => c.zone === "assumed");

  assert.equal(enforced.length, 6, "budget, cap, epoch, expiry, depth, allowlist");
  assert.ok(enforced.every((c) => c.by === null), "nobody can be wrong about an enforced claim");
  assert.equal(attested[0]?.by, "test-oracle", "the rate is somebody's word, and it is named");
  assert.equal(assumed[0]?.by, "an exchange", "the exchange is the counterparty and is named");
});

test("the receipt reads strongest first", () => {
  const lines = formatReceipt(fundingReceipt(rail().route, q, terms));
  assert.equal(lines[0], "enforced:");
  assert.ok(lines.indexOf("attested:") < lines.indexOf("assumed:"));
});

test("a receipt cannot be built over a route that does not support its claims", () => {
  /* A relay after the covenant: the grant's recipient is no longer enforced,
     so the receipt must refuse rather than print six enforced lines. */
  const broken = {
    hops: [
      ...rail().route.hops,
      { kind: "relay" as const, from: "KAS", to: "KAS", layer: "kaspa-l1" as const, counterparty: "the agent" },
    ],
  };
  assert.throws(() => fundingReceipt(broken, q, terms), /hop\(s\) follow the covenant spend/);
});
