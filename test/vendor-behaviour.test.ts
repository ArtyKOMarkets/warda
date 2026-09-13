/**
 * The buyer against a vendor that misbehaves on purpose.
 *
 * This drives the real `wardaFetch` — the adapter that decides when to pay,
 * when to re-present and when to give up — against a vendor that can be made
 * to fail in each of the ways that actually happened this week. No chain, no
 * keys, no deploy: the payer is faked, the vendor is real HTTP.
 *
 * Every assertion here corresponds to a bug that reached production and cost
 * a payment to find. They are cheap now. They were not.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { wardaFetch, X402Error, PAYMENT_HEADER, decodeProof } from "../x402/src/index.ts";
import { startFakeVendor } from "./harness/fake-vendor.ts";

/** A payer that signs nothing and remembers everything it was asked to pay. */
function countingPayer() {
  const paid: bigint[] = [];
  return {
    paid,
    refusalFor: () => null,
    pay: async (req: { amountSompi: bigint }) => {
      paid.push(req.amountSompi);
      return {
        txid: "de".repeat(32),
        payer: "kaspatest:qqpayer",
        amountSompi: req.amountSompi,
        state: {},
        address: "kaspatest:qqnext",
      };
    },
  } as never;
}

test("a healthy vendor is paid exactly once", async () => {
  const v = await startFakeVendor();
  try {
    const payer = countingPayer();
    const res = await wardaFetch(v.url, {}, { payer });
    assert.equal(res.status, 200);
    assert.equal((payer as never as { paid: bigint[] }).paid.length, 1);
    assert.equal(v.served.length, 1);
  } finally { await v.close(); }
});

/**
 * How a debt is created. The vendor takes the payment and never delivers —
 * which is what a vendor with a dead node does — and the buyer must come away
 * with the proof rather than with nothing.
 */
test("a vendor that never delivers leaves a redeemable proof, not a second payment", async () => {
  const v = await startFakeVendor();
  try {
    const payer = countingPayer();
    let captured: string | undefined;
    v.mode = "late";
    await assert.rejects(
      () => wardaFetch(v.url, {}, {
        payer, maxSettleAttempts: 3,
        onEvent: (e) => { if (e.type === "paid") captured = e.header; },
      }),
      (e: Error) => e instanceof X402Error,
    );
    assert.equal((payer as never as { paid: bigint[] }).paid.length, 1, "paid once, not once per attempt");
    assert.ok(captured, "and the header is in the caller's hands");
    assert.equal(decodeProof(captured!).txid, "de".repeat(32));
    assert.equal(v.seen.length, 3, "the SAME proof, three times");
    assert.equal(new Set(v.seen).size, 1);
  } finally { await v.close(); }
});

/** The debt, collected once the vendor comes back. */
test("the proof redeems when the vendor recovers, and pays nothing", async () => {
  const v = await startFakeVendor();
  try {
    const payer = countingPayer();
    let header: string | undefined;
    v.mode = "late";
    await assert.rejects(() => wardaFetch(v.url, {}, {
      payer, maxSettleAttempts: 2,
      onEvent: (e) => { if (e.type === "paid") header = e.header; },
    }), () => true);

    v.mode = "serve";
    const res = await wardaFetch(v.url, {}, {
      payer,
      resume: { header: header!, txid: "de".repeat(32), amountSompi: "3000000" },
    });
    assert.equal(res.status, 200);
    assert.equal((payer as never as { paid: bigint[] }).paid.length, 1, "still one payment, total");
  } finally { await v.close(); }
});

/** A vendor with no node must not provoke a second payment. */
test("a 503 does not become a retry that pays again", async () => {
  const v = await startFakeVendor();
  try {
    const payer = countingPayer();
    v.mode = "down";
    const res = await wardaFetch(v.url, {}, { payer });
    assert.equal(res.status, 503);
    assert.equal((payer as never as { paid: bigint[] }).paid.length, 0, "it never got as far as paying");
  } finally { await v.close(); }
});

/** A resume cannot reach the payer, whatever the vendor says. */
test("a resume against a broken vendor exits without buying", async () => {
  const v = await startFakeVendor();
  try {
    const payer = countingPayer();
    v.mode = "late";
    await assert.rejects(
      () => wardaFetch(v.url, {}, {
        payer, maxSettleAttempts: 2,
        resume: { header: Buffer.from(JSON.stringify({ txid: "ab".repeat(32), nonce: "n" })).toString("base64"), txid: "ab".repeat(32), amountSompi: "3000000" },
      }),
      /did NOT pay again/,
    );
    assert.equal((payer as never as { paid: bigint[] }).paid.length, 0);
  } finally { await v.close(); }
});

/** A vendor that answers with a stack trace still owes a record. */
test("a non-JSON body does not lose the response", async () => {
  const v = await startFakeVendor();
  try {
    v.mode = "garbage";
    const res = await wardaFetch(v.url, {}, { payer: countingPayer() });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /not json/, "the caller can still see what it was sent");
  } finally { await v.close(); }
});
