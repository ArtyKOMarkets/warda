/**
 * What we are about to tell another project, checked against their own code.
 *
 * kaspai.win announces `x402Version: 2`. Before saying that is wrong, three
 * things had to be true, and each is pinned below because each could stop
 * being true and would silently make the claim false.
 *
 *   1. We judge them by the CURRENT schema. @kaspa-x402/core@0.1.0-alpha.10 is
 *      the latest published version (2026-08-10). Judging a live server by a
 *      stale copy of someone's spec is how you send a confident wrong report.
 *
 *   2. The failure is not about mainnet. The schema's oneOf pins
 *      `network: "kaspa:testnet-10"` in one branch, which looks damning until
 *      you check the other one — so this asserts a real v2 quote validates on
 *      BOTH networks, and that moving their body to testnet fixes nothing.
 *
 *   3. The shape difference is the whole difference. A genuine v2 quote from
 *      the reference server sits beside theirs in fixtures/, and the only
 *      material distinction is what `extra` carries.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { validatePaymentRequired } from "@kaspa-x402/core";

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));

const referenceQuote = () => {
  const raw = load("demo-kaspa-x402-402.json");
  const header = raw.headers["payment-required"] ?? raw.headers["PAYMENT-REQUIRED"];
  return header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : raw.body;
};

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));

test("the reference server's v2 quote validates — so the validator is not simply broken", () => {
  const result = validatePaymentRequired(referenceQuote());
  assert.equal(result.ok, true);
});

test("v2 is not testnet-only: the same quote validates on mainnet", () => {
  const quote = clone(referenceQuote());
  quote.accepts[0].network = "kaspa:mainnet";
  const result = validatePaymentRequired(quote);
  assert.equal(
    result.ok,
    true,
    "if this fails, the schema really is testnet-only and the report must say so instead",
  );
});

test("kaspai.win's body does not validate as the v2 it announces", () => {
  const result = validatePaymentRequired(load("kaspai-win-402.json").body);
  assert.equal(result.ok, false);
});

test("and it is the shape of `extra`, not the network", () => {
  const theirs = clone(load("kaspai-win-402.json").body);
  theirs.accepts[0].network = "kaspa:testnet-10";
  const result = validatePaymentRequired(theirs);
  assert.equal(result.ok, false, "moving them to testnet does not make the body valid");

  const missing = new Set<string>(
    (result as { error: { details: { params?: { missingProperty?: string } }[] } }).error.details
      .map((d) => d.params?.missingProperty)
      .filter((v): v is string => Boolean(v)),
  );
  // The five a standard-native v2 quote carries, none of which they send.
  for (const field of ["profile", "binding", "finality", "transactionEncoding"]) {
    assert.ok(missing.has(field), `expected the validator to miss ${field}`);
  }
});

test("what each side actually puts in `extra` — the claim in one assertion", () => {
  const ref = Object.keys(referenceQuote().accepts[0].extra).sort();
  const theirs = Object.keys(load("kaspai-win-402.json").body.accepts[0].extra).sort();
  assert.deepEqual(theirs, ["facilitator", "nonce"]);
  assert.ok(ref.includes("profile") && ref.includes("binding"));
  assert.equal(ref.some((k) => theirs.includes(k)), false, "the two shapes share nothing");
});
