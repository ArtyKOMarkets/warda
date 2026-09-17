import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, assertClaimSupported, zoneOf, type Hop, type Route } from "../src/index.ts";

const covenant: Hop = {
  kind: "covenant",
  from: "grant",
  to: "KAS",
  layer: "kaspa-l1",
  counterparty: null,
};
const relay: Hop = {
  kind: "relay",
  from: "KAS",
  to: "KAS",
  layer: "kaspa-l1",
  counterparty: "the agent's own key",
};
const bridge: Hop = {
  kind: "bridge",
  from: "KAS",
  to: "iKAS",
  layer: "igra",
  counterparty: "Igra bridge",
};
const swap: Hop = {
  kind: "swap",
  from: "iKAS",
  to: "USDC.e",
  layer: "igra",
  counterparty: "Zealous Swap",
};

const route = (...hops: Hop[]): Route => ({ hops });

test("a direct covenant payment enforces its recipient", () => {
  const v = verdict(route(covenant));
  assert.equal(v.recipientEnforced, true);
  assert.equal(v.authorisedToPayMe, "yes");
  assert.equal(v.zone, "enforced");
  assert.deepEqual(v.counterparties, [], "nobody can make it go wrong");
});

test("one relay hop is enough to unbind the recipient", () => {
  const v = verdict(route(covenant, relay));
  assert.equal(v.recipientEnforced, false);
  assert.equal(v.authorisedToPayMe, "unknown", "this is the existing x402 answer, computed");
  assert.equal(v.zone, "attested");
});

test("a swap route is assumed, and names everyone on it", () => {
  const v = verdict(route(covenant, relay, bridge, swap));
  assert.equal(v.zone, "assumed", "no stronger than its least certain hop");
  assert.equal(v.recipientEnforced, false);
  assert.deepEqual(v.counterparties, ["the agent's own key", "Igra bridge", "Zealous Swap"]);
  assert.deepEqual(v.layers, ["kaspa-l1", "igra"], "two layers means a bridge, whatever it is called");
});

test("what the covenant still enforces does not shrink when hops are added", () => {
  const bare = verdict(route(covenant));
  const long = verdict(route(covenant, relay, bridge, swap));
  assert.deepEqual(long.stillEnforced, bare.stillEnforced);
  assert.ok(long.stillEnforced.includes("maxPerSpend"));
  assert.ok(long.stillEnforced.includes("budgetTotal"));
});

test("hop zones follow what the hop actually is", () => {
  assert.equal(zoneOf(covenant), "enforced");
  assert.equal(zoneOf(relay), "attested");
  assert.equal(zoneOf(bridge), "assumed");
  assert.equal(zoneOf(swap), "assumed");
});

test("a route with no covenant hop has no Warda claim to make", () => {
  assert.throws(() => verdict(route(bridge, swap)), /no covenant hop/);
});

test("two covenant hops are two payments, and are refused as one", () => {
  assert.throws(() => verdict(route(covenant, relay, covenant)), /2 covenant hops/);
});

test("a covenant hop with a counterparty is mislabelled", () => {
  assert.throws(
    () => verdict(route({ ...covenant, counterparty: "somebody" })),
    /consensus refuses every alternative or this is mislabelled/,
  );
});

test("a non-covenant hop must name who is on the other side", () => {
  assert.throws(
    () => verdict(route(covenant, { ...swap, counterparty: null })),
    /cannot name them cannot be checked/,
  );
});

test("claiming an enforced recipient over a relay is refused, and says what followed", () => {
  assert.throws(
    () => assertClaimSupported(route(covenant, relay, swap), { recipientEnforced: true }),
    /relay -> swap/,
  );
});

test("claiming enforced over a direct payment is allowed", () => {
  assert.doesNotThrow(() => assertClaimSupported(route(covenant), { recipientEnforced: true }));
});

test("claiming a stronger zone than the weakest hop is refused", () => {
  assert.throws(
    () => assertClaimSupported(route(covenant, swap), { zone: "attested" }),
    /no stronger than the least certain thing/,
  );
  assert.doesNotThrow(() => assertClaimSupported(route(covenant, swap), { zone: "assumed" }));
});

test("the funding-side shape enforces its recipient, because the covenant is last", () => {
  /* USDC.e -> bridge -> KAS -> genesis. Nothing happens after the covenant,
     so this is the clean path the design document argues for. */
  const funding = route(
    { kind: "swap", from: "USDC.e", to: "iKAS", layer: "igra", counterparty: "Zealous Swap" },
    { kind: "bridge", from: "iKAS", to: "KAS", layer: "kaspa-l1", counterparty: "Igra bridge" },
    covenant,
  );
  const v = verdict(funding);
  assert.equal(v.recipientEnforced, true, "the grant is the last thing that happens");
  assert.equal(v.authorisedToPayMe, "yes");
  assert.equal(v.zone, "assumed", "getting there was still assumed, and the receipt says so");
});
