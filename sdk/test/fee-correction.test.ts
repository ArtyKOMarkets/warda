/**
 * The fee corrector, tested against a stub node.
 *
 * No network, because what needs asserting is not that kaspad rejects a cheap
 * transaction — it does, and we have watched it — but the DECISION this makes
 * about the rejection. Three of those decisions can lose money or confuse an
 * operator, and none of them is exercised by a happy path:
 *
 *   - retrying something that was not a fee problem
 *   - retrying a submit that may already have succeeded
 *   - "correcting" downward, to a figure smaller than the one just refused
 *
 * The real message here is the one kaspad actually sent on 8 September, kept
 * verbatim. A parser tested only against a message someone wrote for the test
 * is a parser tested against its own author.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Transaction } from "@warda_protocol/kaspa";
import { isFeeRejection, requiredFeeFrom, submitCorrectingFee } from "../tools/fee.ts";

const REAL = // kaspad 2.0.1, testnet-10, 7-input consolidation
  "submitTransaction: Rejected transaction b8baa0a2bba9378fc4624668be9466a4c5ed0f0fe8cb95fb76deae02db7d862e: " +
  "transaction b8baa0a2bba9378fc4624668be9466a4c5ed0f0fe8cb95fb76deae02db7d862e is not standard: " +
  "transaction has 822000 fees which is under the required amount of 974600 for compute mass 9746";

const tx = (tag: string) => ({ payload: new TextEncoder().encode(tag) }) as unknown as Transaction;
const tagOf = (t: Transaction) => new TextDecoder().decode(t.payload);

test("it reads the figure kaspad actually named", () => {
  assert.equal(requiredFeeFrom(REAL), 974_600n);
  assert.equal(isFeeRejection(REAL), true);
});

test("a message with numbers but no fee in it is not a fee rejection", () => {
  // An amount, a DAA score and a txid fragment are all numbers. A looser
  // parser rebuilds a transaction to satisfy a rule nobody stated.
  const other = "Rejected transaction abc123: orphan transaction, missing outpoint 4 of 900000000";
  assert.equal(requiredFeeFrom(other), null);
  assert.equal(isFeeRejection(other), false);
});

test("it pays what the node asked and reports the correction", async () => {
  let seen = 0;
  const r = await submitCorrectingFee({
    client: {
      async submitTransaction(t: Transaction) {
        seen++;
        if (tagOf(t) === "cheap") throw new Error(REAL);
        return "accepted-txid";
      },
    },
    tx: tx("cheap"),
    fee: 822_000n,
    rebuild: (f) => tx(`rebuilt@${f}`),
  });
  assert.equal(r.txid, "accepted-txid");
  assert.equal(r.fee, 974_600n);
  assert.equal(r.corrected, true);
  assert.equal(tagOf(r.tx), "rebuilt@974600", "the accepted tx is the rebuilt one, not the original");
  assert.equal(seen, 2, "exactly one retry");
});

test("a good fee submits once and rebuilds nothing", async () => {
  let rebuilt = false;
  const r = await submitCorrectingFee({
    client: { async submitTransaction() { return "ok"; } },
    tx: tx("fine"),
    fee: 1_000_000n,
    rebuild: () => { rebuilt = true; return tx("never"); },
  });
  assert.equal(r.corrected, false);
  assert.equal(rebuilt, false, "an expensive rebuild must not run when the estimate was right");
});

/**
 * The one that protects money rather than tidiness.
 *
 * A submit that TIMED OUT may already have been accepted. Retrying it is a
 * second spend of the same UTXO — the node refuses it as already-spent, so
 * nothing is lost, but a network hiccup becomes two confusing failures instead
 * of one clear one. Only a rejection that names a figure is retried.
 */
test("it does not retry an error that is not about the fee", async () => {
  let calls = 0;
  await assert.rejects(
    submitCorrectingFee({
      client: {
        async submitTransaction() { calls++; throw new Error("socket hang up"); },
      },
      tx: tx("x"),
      fee: 1n,
      rebuild: () => tx("never"),
    }),
    /socket hang up/,
    "the original error survives, in its own words",
  );
  assert.equal(calls, 1, "no second submit");
});

test("it refuses to 'correct' downward", async () => {
  // A node naming a figure BELOW what was already paid means the rejection was
  // about something else that happens to mention a fee. Rebuilding cheaper
  // would guarantee a second refusal.
  const backwards = "rejected: has 900000 fees which is under the required amount of 500 for mass 5";
  await assert.rejects(
    submitCorrectingFee({
      client: { async submitTransaction() { throw new Error(backwards); } },
      tx: tx("x"),
      fee: 900_000n,
      rebuild: () => tx("never"),
    }),
    /required amount of 500/,
  );
});
