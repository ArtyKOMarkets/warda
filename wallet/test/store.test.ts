/**
 * The record, which is this package's actual product.
 *
 * Everything else here is assembly over WardaPayer and wardaFetch. What has no
 * other home is keeping the grant findable, so these tests are about the two
 * ways to get that wrong and the arithmetic that silently drifts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { advanced, memoryStore, type Manifest } from "../src/store.ts";
import { toGrant, toRecipientSet } from "../src/grant.ts";
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };
import type { CovenantTemplate, GrantState } from "@warda_protocol/kaspa";

const TEMPLATE = covenantTemplate as unknown as CovenantTemplate;
const PAYEE = "16e6af2030f7e4510d1a417391a7ff7ccad21864f17eef7ee035f0453e21a033";

const MANIFEST: Manifest = {
  covenant: "b3e5eeefacf2021f",
  covenant_id: "cfb69da048e363e9907e926cd48332f134fea854900fd75d88db89faa12976e6",
  agent: "b7c837bbf1d6e2d974594a8c0b91bcd193226176e57cbbee663f8538b16f914e",
  principal: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  revocation: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  recipients_root: "ba9e576ed159db9347d3f137e449cb31fbb802dcb77784dae6bea270e7ca92b2",
  not_before: 559742731,
  expires_at: 585662731,
  budget: 5_000_000_000,
  max_per_spend: 10_000_000,
  epoch_limit: 50_000_000,
  epoch_length: 1000,
  delegation_depth: 2,
  grant_value: 4_957_000_000,
  spent_total: 33_000_000,
  reserved: 0,
  epoch_index: 212,
  epoch_spent: 3_000_000,
  reserve_root: "803b111f3c3952f7b7c9cb2bd240759e755a85ab2c6223614d08f216dd6a3bd1",
  /* Not modelled by the Manifest interface, and that is the point of the
     index signature: a wallet that drops fields it does not understand is a
     wallet that edits your records. */
  agent_key_derived: null,
};

test("the allowlist is checked against the root, not trusted", () => {
  const ok = toGrant(MANIFEST, [PAYEE], TEMPLATE);
  assert.equal(ok.state.recipientsRoot, MANIFEST.recipients_root);

  /* node:assert's throws() returns undefined, so the error is captured rather
     than taken from it — the message is the thing under test here. */
  let e: Error | undefined;
  try {
    toGrant(MANIFEST, ["aa".repeat(32)], TEMPLATE);
  } catch (err) {
    e = err as Error;
  }
  assert.ok(e, "a wrong allowlist must not be accepted");
  /* The refusal has to say what the consequence would have been, or the next
     person "fixes" it by passing the root through and derives an address
     nobody funded. */
  assert.match(e.message, /wrong list for this grant/);
  assert.match(e.message, /address nobody funded/);
});

test("an address and its bare hex payload are the same member", () => {
  const hex = toRecipientSet([PAYEE]).rootHex;
  const addr = toRecipientSet([
    "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4",
  ]).rootHex;
  assert.equal(addr, hex);
});

test("comments and blank lines in a recipients file are not members", () => {
  const plain = toRecipientSet([PAYEE]).rootHex;
  const messy = toRecipientSet(["", `${PAYEE}  # the demo vendor`, "   ", "# a note"]).rootHex;
  assert.equal(messy, plain);
});

test("grant_value loses the payment AND the fee", () => {
  const state: GrantState = {
    ...toGrant(MANIFEST, [PAYEE], TEMPLATE).state,
    spentTotal: 36_000_000n,
    epochSpent: 6_000_000n,
  };
  const next = advanced(MANIFEST, state, 3_000_000n, 100_000n);

  assert.equal(next.spent_total, 36_000_000);
  assert.equal(next.epoch_spent, 6_000_000);
  /* The budget is charged the payment; the COIN loses payment plus fee.
     Advance by the payment alone and the record drifts by one fee per
     purchase until something reconciling against the chain refuses it. */
  assert.equal(next.grant_value, 4_957_000_000 - 3_000_000 - 100_000);
});

test("advancing preserves fields this package does not model", () => {
  const state = toGrant(MANIFEST, [PAYEE], TEMPLATE).state;
  const next = advanced(MANIFEST, state, 0n, 0n);
  assert.ok("agent_key_derived" in next);
  assert.equal(next.covenant_id, MANIFEST.covenant_id);
});

test("a store hands back copies, so a caller cannot mutate the record in place", async () => {
  const store = memoryStore(MANIFEST);
  const first = await store.load();
  first.spent_total = 999;
  const second = await store.load();
  assert.equal(second.spent_total, MANIFEST.spent_total);
});
