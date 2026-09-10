/**
 * The seven answers, and the two that stop a buyer paying twice.
 *
 * A buyer that has already broadcast money reads the status code to decide
 * whether to wait, give up, or re-present the same proof. Getting that wrong
 * does not produce a test failure in anyone's suite — it produces a second
 * payment. So the retry semantics are asserted here as behaviour, not as
 * documentation.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { settle, type SaleTerms } from "../src/settle.ts";
import { issueQuote } from "../src/quote.ts";
import { inMemorySpent, replayAllowed } from "../src/spent.ts";

const TXID = "aa".repeat(32);
const SECRET = "test-secret";
const TERMS: SaleTerms = {
  resource: "/thing",
  payTo: "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4",
  sompi: 4_000_000n,
  network: "testnet-10",
  seller: "test",
};

const nodeWith = (coins: { txid: string; value: bigint }[]) => async () => ({
  client: {
    getUtxosByAddresses: async () =>
      coins.map((c) => ({
        outpoint: { transactionId: Uint8Array.from(Buffer.from(c.txid, "hex")), index: 0 },
        entry: { value: c.value },
      })) as never,
    close: () => {},
  },
  readFrom: "a test",
});

const header = (txid: string, nonce: string) =>
  Buffer.from(JSON.stringify({ txid, nonce })).toString("base64");

const goodNonce = () =>
  issueQuote({ resource: TERMS.resource, sompi: TERMS.sompi, expiresAt: Date.now() + 60_000 },
             { secret: SECRET });

const run = (over: Partial<Parameters<typeof settle>[0]> = {}) =>
  settle({
    terms: TERMS,
    paymentHeader: null,
    quote: { secret: SECRET },
    spent: replayAllowed(),
    openNode: nodeWith([{ txid: TXID, value: TERMS.sompi }]),
    deliver: () => ({ ok: true }),
    ...over,
  });

test("no header quotes a price and reveals nothing", async () => {
  const r = await run();
  assert.equal(r.status, 402);
  const accept = (r.body.accepts as Record<string, unknown>[])[0]!;
  assert.equal(accept.payTo, TERMS.payTo);
  assert.equal(accept.amountSompi, "4000000");
  assert.equal(accept.scheme, "exact");
  assert.ok(accept.nonce, "a quote with no nonce cannot be checked when it comes back");
});

test("a quote this seller never issued is refused", async () => {
  const r = await run({ paymentHeader: header(TXID, "9999999999999.deadbeefdeadbeefdeadbeefdeadbeef") });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /not issued here/);
});

test("an expired quote is refused, and says to ask again", async () => {
  const stale = issueQuote(
    { resource: TERMS.resource, sompi: TERMS.sompi, expiresAt: Date.now() - 1 },
    { secret: SECRET },
  );
  const r = await run({ paymentHeader: header(TXID, stale) });
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /expired/);
});

test("a payment not on chain yet answers 402 with retry — the same proof, not a new payment", async () => {
  const r = await run({ paymentHeader: header(TXID, goodNonce()), openNode: nodeWith([]) });
  assert.equal(r.status, 402);
  assert.equal(r.body.retry, true);
});

test("the right transaction for the wrong amount is 400, NOT a retryable 402", async () => {
  const r = await run({
    paymentHeader: header(TXID, goodNonce()),
    openNode: nodeWith([{ txid: TXID, value: 1n }]),
  });
  assert.equal(r.status, 400, "a 402 here would invite a second payment for a settled refusal");
});

test("a confirmed payment is served, with a receipt naming what was checked", async () => {
  const r = await run({ paymentHeader: header(TXID, goodNonce()) });
  assert.equal(r.status, 200);
  assert.equal(r.body.settledBy, TXID);
  assert.equal(r.body.paidTo, TERMS.payTo);
  assert.match(String(r.body.verified), /UTXO/);
});

test("the same payment twice is 409 — one payment, one delivery", async () => {
  const spent = inMemorySpent({ quiet: true });
  const h = header(TXID, goodNonce());
  const first = await run({ paymentHeader: h, spent });
  assert.equal(first.status, 200);
  const second = await run({ paymentHeader: h, spent });
  assert.equal(second.status, 409);
  assert.equal(second.body.settledBy, TXID);
});

test("a replay is refused WITHOUT asking a node", async () => {
  // The coin is still in the UTXO set and always will be, so the chain would
  // happily confirm it again. Only the seller's own record can refuse this.
  const spent = inMemorySpent({ quiet: true });
  await spent.add(TXID);
  let asked = false;
  const r = await run({
    paymentHeader: header(TXID, goodNonce()),
    spent,
    openNode: async () => { asked = true; return nodeWith([])(); },
  });
  assert.equal(r.status, 409);
  assert.equal(asked, false);
});

test("delivery is never called before the money is confirmed", async () => {
  let delivered = false;
  await run({
    paymentHeader: header(TXID, goodNonce()),
    openNode: nodeWith([]),
    deliver: () => { delivered = true; return {}; },
  });
  assert.equal(delivered, false);
});

test("paid but undeliverable is 502 and still names the txid", async () => {
  // The buyer's money is gone. Its records need to say what it bought and from
  // whom, and a 500 with no txid in it makes that impossible.
  const r = await run({
    paymentHeader: header(TXID, goodNonce()),
    deliver: () => { throw new Error("upstream is down"); },
  });
  assert.equal(r.status, 502);
  assert.equal(r.body.settledBy, TXID);
  assert.match(String(r.body.error), /upstream is down/);
});

test("a blind seller answers 503 and tells the buyer not to pay again", async () => {
  const r = await run({
    paymentHeader: header(TXID, goodNonce()),
    openNode: async () => { throw new Error("no node"); },
  });
  assert.equal(r.status, 503);
  assert.match(String(r.body.detail), /NOT been paid twice/);
});
