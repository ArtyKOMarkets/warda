/**
 * The refusals, which are the only part worth testing.
 *
 * A verifier that returns "paid" for everything passes any test that only
 * checks the happy path — and that verifier is exactly the bug this package
 * exists to not have. So every test below is a payment that must NOT be
 * accepted, and the one acceptance is there to prove the others are not
 * passing by refusing indiscriminately.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkPayment } from "../src/verify.ts";

const TXID = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const PAY_TO = "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4";
const PRICE = 4_000_000n;

/** A node that reports exactly the coins it is given. */
const nodeWith = (coins: { txid: string; value: bigint }[]) => ({
  getUtxosByAddresses: async () =>
    coins.map((c) => ({
      outpoint: { transactionId: Uint8Array.from(Buffer.from(c.txid, "hex")), index: 0 },
      entry: { value: c.value },
    })) as never,
});

test("a coin from that transaction, for that amount, is paid", async () => {
  const r = await checkPayment(nodeWith([{ txid: TXID, value: PRICE }]), {
    txid: TXID, payTo: PAY_TO, sompi: PRICE,
  });
  assert.equal(r.paid, true);
});

test("nothing at the address is not paid, and IS worth retrying", async () => {
  const r = await checkPayment(nodeWith([]), { txid: TXID, payTo: PAY_TO, sompi: PRICE });
  assert.equal(r.paid, false);
  assert.equal(r.paid === false && r.retry, true, "a payment in flight must be retryable");
});

test("somebody else's coin at the same address is not this purchase", async () => {
  // The address is right and the money is right. Only the transaction differs,
  // which is the whole difference between a payment and a coincidence.
  const r = await checkPayment(nodeWith([{ txid: OTHER, value: PRICE }]), {
    txid: TXID, payTo: PAY_TO, sompi: PRICE,
  });
  assert.equal(r.paid, false);
});

test("the right transaction for the wrong amount is refused and NOT retryable", async () => {
  // Retrying cannot change what a confirmed transaction paid. Telling a buyer
  // to wait here is how it ends up paying twice for one refusal.
  const r = await checkPayment(nodeWith([{ txid: TXID, value: PRICE - 1n }]), {
    txid: TXID, payTo: PAY_TO, sompi: PRICE,
  });
  assert.equal(r.paid, false);
  assert.equal(r.paid === false && r.retry, false);
});

test("overpayment is refused too — `exact` is not a minimum", async () => {
  const r = await checkPayment(nodeWith([{ txid: TXID, value: PRICE * 2n }]), {
    txid: TXID, payTo: PAY_TO, sompi: PRICE,
  });
  assert.equal(r.paid, false);
});

test("a fabricated txid buys nothing, which is the point of reading the chain", async () => {
  const r = await checkPayment(nodeWith([{ txid: OTHER, value: PRICE }]), {
    txid: "ff".repeat(32), payTo: PAY_TO, sompi: PRICE,
  });
  assert.equal(r.paid, false);
});

test("txid comparison ignores case, because hex encoders disagree about it", async () => {
  const r = await checkPayment(nodeWith([{ txid: TXID, value: PRICE }]), {
    txid: TXID.toUpperCase(), payTo: PAY_TO, sompi: PRICE,
  });
  assert.equal(r.paid, true);
});
