/**
 * The README's example compiles and the claims in it are the ones the code
 * makes. A README is the first thing a provider reads and the last thing
 * anybody updates.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { wardaProvider } from "../src/handler.ts";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("the example's entry point exists and takes what the README says", () => {
  const warda = wardaProvider();
  assert.equal(typeof warda.verify, "function");
  /* req, paymentInput — the second is the binding and the README says it is
     required. A signature that quietly made it optional would make every
     example in the file wrong in the one way that matters. */
  assert.equal(warda.verify.length, 2);
});

test("a request with no header is the ordinary case, exactly as documented", () => {
  const warda = wardaProvider();
  const v = warda.verify({ headers: {} }, { transactionId: "aa".repeat(32), index: 1 });
  assert.deepEqual(v, { warda: false, reason: "no proof" });
  assert.match(readme, /\{ warda: false, reason: "no proof" \}/);
});

test("the README does not claim authorisation", () => {
  /* The one sentence this package must never grow. If it appears, someone has
     written the stronger verb and every integration will repeat it. */
  assert.doesNotMatch(readme, /verif(ies|ied) (that )?(the )?payer was authoris/i);
  assert.match(readme, /does not prove/i);
  assert.match(readme, /"unknown"/);
});
