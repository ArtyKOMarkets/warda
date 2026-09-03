/**
 * u64s that a double cannot hold, which a Kaspa node sends as raw JSON numbers.
 *
 * Found by pointing `agent/tools/read.ts` at a real testnet-10 node for the
 * first time. `getCoinSupply` answered with every field spelled exactly as
 * expected and a circulating supply of 2,690,917,752,273,334,000 sompi — about
 * 299 times what a double holds exactly. The value was already rounded before
 * any code here saw it, so `toBigInt` refused it, correctly and uselessly.
 *
 * No schema, vector or reference implementation could have surfaced this. It
 * took one connection to a live node, and it is the reason the read tool
 * records what a node replied with rather than only that it failed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseJsonPreservingIntegers, toBigInt } from "../src/rpc.ts";

/** The reply that found this, verbatim. */
const REAL = `{"circulatingSompi":2690917752273334000,"maxSompi":2870000000000000000}`;

test("a u64 beyond a double survives as its exact digits", () => {
  const r = parseJsonPreservingIntegers(REAL);

  assert.equal(r.circulatingSompi, "2690917752273334000");
  assert.equal(toBigInt(r.circulatingSompi, "circulatingSompi"), 2_690_917_752_273_334_000n);
  assert.equal(toBigInt(r.maxSompi, "maxSompi"), 2_870_000_000_000_000_000n);
});

test("the digits are the NODE's, not a double's idea of them", () => {
  // The case that makes this worth doing: a value whose nearest double is a
  // different integer. Plain JSON.parse loses the last digits here; the
  // literal text does not.
  const text = `{"amount":9007199254740993}`; // 2^53 + 1
  assert.equal(JSON.parse(text).amount, 9_007_199_254_740_992, "plain parse rounds it");
  assert.equal(parseJsonPreservingIntegers(text).amount, "9007199254740993");
  assert.equal(
    toBigInt(parseJsonPreservingIntegers(text).amount, "amount"),
    9_007_199_254_740_993n,
  );
});

test("everything a double CAN hold keeps the shape it always had", () => {
  const r = parseJsonPreservingIntegers(
    `{"daa":560647497,"index":0,"neg":-42,"zero":0,"max":9007199254740991}`,
  );
  for (const [k, v] of Object.entries(r)) {
    assert.equal(typeof v, "number", `${k} should still be a number`);
  }
  assert.equal(r.max, Number.MAX_SAFE_INTEGER);
  assert.equal(r.neg, -42);
});

test("floats, strings, booleans and nulls are untouched", () => {
  const r = parseJsonPreservingIntegers(
    `{"f":1.5,"big":1e300,"s":"2690917752273334000","b":true,"n":null,"a":[1,2]}`,
  );
  assert.equal(r.f, 1.5);
  assert.equal(r.big, 1e300, "not an integer literal, so not touched");
  assert.equal(r.s, "2690917752273334000");
  assert.equal(r.b, true);
  assert.equal(r.n, null);
  assert.deepEqual(r.a, [1, 2]);
});

test("a negative u64 beyond a double keeps its sign", () => {
  const r = parseJsonPreservingIntegers(`{"v":-2690917752273334000}`);
  assert.equal(r.v, "-2690917752273334000");
  assert.equal(toBigInt(r.v, "v"), -2_690_917_752_273_334_000n);
});

test("nested and array values are covered too", () => {
  const r = parseJsonPreservingIntegers(
    `{"entries":[{"utxoEntry":{"amount":2690917752273334000}}]}`,
  );
  assert.equal(r.entries[0].utxoEntry.amount, "2690917752273334000");
});
