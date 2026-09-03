/**
 * The v2 dialect, checked against the reference implementation rather than
 * against our reading of it.
 *
 * Two kinds of assertion live here and they are not equally strong:
 *
 *   - anything routed through @kaspa-x402/core is checked by THEIR code. The
 *     payload we assemble is validated by their schema validator, and the
 *     authorization digest is computed by their preimage function. If we build
 *     a payload wrongly these fail, and they fail for the same reason their
 *     facilitator would.
 *
 *   - the two hash rules reproduced in `v2.ts` are not exported by their
 *     package, so they are pinned as golden vectors AND guarded by a drift
 *     check that reads the installed reference server. A version bump that
 *     changes either rule breaks this file loudly instead of breaking a
 *     payment quietly, in production, after the money has moved.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { X402_VERSION, sha256Hex, stableStringify } from "@kaspa-x402/core";

import {
  authorize,
  buildPayment,
  dialect,
  paymentRequirementsHash,
  paymentSignatureHeader,
  requestHash,
  selectRequirement,
} from "../src/v2.ts";

const NETWORK = "kaspa:testnet-10";

/** A requirement shaped exactly as their server emits one. */
function exact(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "5000000",
    asset: "KAS",
    payTo: "kaspatest:qq0d6h0prjm5mpdld5pncst3adu0yam6xch4tr69k2",
    maxTimeoutSeconds: 120,
    extra: {
      binding: "kaspa-exact-v2",
      profile: "standard-native",
      // required by their SCHEMA even though their .d.ts marks all three
      // optional. The schema is the authority: it is what their facilitator
      // runs, and a fixture their types accept is not necessarily one their
      // server does.
      finality: "accepted",
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      // the SERIALIZED script public key: a little-endian u16 version, then the
      // script. Not the bare script — their schema pins the "0000" prefix, and
      // the authorization digest commits to whichever form the server sent.
      payToScriptPublicKey: "0000" + "20" + "ef".repeat(32) + "ac",
      ...extra,
    },
    ...over,
  };
}

function required(accepts: unknown[]) {
  return {
    x402Version: X402_VERSION,
    resource: { url: "https://vendor.example/inference" },
    accepts,
  };
}

const REQUEST = { method: "POST", url: "https://vendor.example/inference", body: { prompt: "hi" } };

// a deterministic stand-in for the agent key: the signature's VALUE is not what
// these tests check, only that the digest handed to it is the one their
// preimage produces and that it lands in the payload unchanged
const sign = (digest: Uint8Array) => new Uint8Array(64).fill(digest[0]!);

// ---- which dialect is this ----------------------------------------------

test("the dialect is read from the response, not from configuration", () => {
  assert.equal(dialect(required([exact()])), "v2");
  assert.equal(dialect({ accepts: [{ scheme: "exact", amountSompi: "5000000" }] }), "v1");
  assert.equal(dialect(null), "v1");
  assert.deepEqual(dialect({ x402Version: 3, accepts: [] }), { unsupported: 3 });
});

// ---- selection -----------------------------------------------------------

test("the exact/standard-native requirement is the one a grant can pay", () => {
  const picked = selectRequirement(required([exact()]));
  assert.equal(picked.scheme, "exact");
  assert.equal(picked.amount, "5000000");
});

test("a batch-settlement server is refused with what paying it would actually take", () => {
  const batch = {
    scheme: "batch-settlement",
    network: NETWORK,
    amount: "5000000",
    asset: "KAS",
    payTo: "kaspatest:qq0d6h0prjm5mpdld5pncst3adu0yam6xch4tr69k2",
    maxTimeoutSeconds: 120,
    extra: {
      binding: "kaspa-escrow-v2",
      templateId: "kaspa-x402-escrow-v2",
      serverPublicKey: "ab".repeat(32),
      minDepositSompi: "100000000",
      claimReserveSompi: "10000000",
      refundTimeoutDaa: "86400",
    },
  };
  assert.throws(() => selectRequirement(required([batch])), /channel opened from the grant/);
});

test("the additive profile is refused, and says why a covenant spend cannot satisfy it", () => {
  // A VALID additive quote, not a malformed one — otherwise this would test
  // their validator rejecting nonsense rather than our refusal to pay a shape
  // we do not produce. Every field below is one their schema demands once the
  // profile stops being "standard-native", and together they describe the
  // thing we cannot do: continue a reserved head UTXO under a KIP-10
  // additive-threshold template.
  const additive = exact(
    {},
    {
      profile: "additive",
      templateId: "kaspa-x402-kip10-additive-v1",
      headId: "1a".repeat(32),
      headVersion: "1",
      expectedHeadOutpoint: { txid: "2b".repeat(32), index: 0 },
      headAmount: "100000000",
      headScriptPublicKey: "0000" + "20" + "3c".repeat(32) + "ac",
      headRedeemScript: "4d".repeat(40),
      additiveThresholdSompi: "5000000",
      challengeId: "5e".repeat(32),
      challengeExpiresAt: "2026-09-03T06:05:00.000Z",
      paymentOutputIndex: 0,
    },
  );
  assert.throws(() => selectRequirement(required([additive])), /KIP-10 threshold template/);
});

test("a body their validator rejects fails in their vocabulary, before anything is signed", () => {
  assert.throws(() => selectRequirement({ x402Version: X402_VERSION }), /not valid kaspa-x402 v2/);
  assert.throws(() => selectRequirement(required([{ scheme: "exact" }])), /not valid kaspa-x402 v2/);
});

// ---- the two reproduced hash rules --------------------------------------

test("paymentRequirementsHash hashes the requirement as it arrived", () => {
  const accepted = exact();
  assert.equal(paymentRequirementsHash(accepted as never), sha256Hex(stableStringify(accepted)));

  // and it is not the hash of a rebuilt object that dropped a key it ignored
  const { maxTimeoutSeconds, ...trimmed } = accepted;
  assert.notEqual(paymentRequirementsHash(accepted as never), sha256Hex(stableStringify(trimmed)));
});

test("requestHash binds method, url and body — change any one and it moves", () => {
  const accepted = exact() as never;
  const base = requestHash(REQUEST, accepted);

  assert.notEqual(requestHash({ ...REQUEST, method: "GET" }, accepted), base);
  assert.notEqual(requestHash({ ...REQUEST, url: REQUEST.url + "?x=1" }, accepted), base);
  assert.notEqual(requestHash({ ...REQUEST, body: { prompt: "bye" } }, accepted), base);

  // an absent method is GET and an absent body is null, per their rule
  assert.equal(
    requestHash({ url: REQUEST.url }, accepted),
    requestHash({ method: "GET", url: REQUEST.url, body: null }, accepted),
  );

  // and it is bound to the QUOTE too: the same request against a different
  // price is a different payment
  assert.notEqual(requestHash(REQUEST, exact({ amount: "9000000" }) as never), base);
});

test("GOLDEN: the reproduced rules still produce these exact values", () => {
  // Pinned so that a change to either rule — ours or, via the drift check
  // below, theirs — cannot pass silently.
  assert.equal(
    paymentRequirementsHash(exact() as never),
    "668b7cfeb4a1b6f5cf18717c7c7e9f94239d2dc80a3196011a2d6a13973bb8fc",
  );
  assert.equal(
    requestHash(REQUEST, exact() as never),
    "c1ac9ce78fea36f06c9ed9134a4d7a6ce3c3ba18318ef2b2a0c276233ff1d99e",
  );
});

test("DRIFT: the reference server still computes these the way v2.ts says it does", () => {
  const source = readFileSync(
    new URL("../../node_modules/@kaspa-x402/server/dist/index.js", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /paymentRequirementsHash: sha256Hex\(stableStringify\(accepted\)\)/,
    "the reference server no longer hashes the accepted requirement this way — re-read " +
      "`paymentRequirementsHash` in src/v2.ts before trusting any payment this client builds",
  );
  assert.match(
    source,
    /function fingerprintRequest\(request, accepted\) \{\s*return sha256Hex\(\s*stableStringify\(\{\s*method: request\.method \?\? "GET",\s*url: request\.url,\s*body: request\.body \?\? null,\s*paymentRequirementsHash: sha256Hex\(stableStringify\(accepted\)\)/,
    "the reference server's request fingerprint has changed — re-read `requestHash` in src/v2.ts",
  );
});

// ---- the authorization and the payload ----------------------------------

const AUTH = {
  accepted: exact() as never,
  request: REQUEST,
  transactionId: "cd".repeat(32),
  paymentOutputIndex: 0,
  inputIndex: 0,
  nowMs: Date.parse("2026-09-03T06:00:00.000Z"),
};

test("the authorization expires no later than the quote allows", async () => {
  const auth = await authorize(AUTH, sign);
  assert.equal(auth.expiresAt, "2026-09-03T06:02:00.000Z");
  assert.equal(auth.version, "kaspa-x402-exact-request-authorization-v1");
  assert.equal(auth.inputIndex, 0);
  assert.match(auth.digest, /^[0-9a-f]{64}$/);
  assert.equal(auth.signature.length, 128);
});

test("a server challenge shortens the window rather than extending it", async () => {
  const soon = new Date(AUTH.nowMs + 30_000).toISOString();
  const auth = await authorize(
    { ...AUTH, accepted: exact({}, { challengeExpiresAt: soon }) as never },
    sign,
  );
  assert.equal(auth.expiresAt, soon);
});

test("every field of the payment changes the digest the agent signs", async () => {
  const base = (await authorize(AUTH, sign)).digest;
  for (const change of [
    { transactionId: "ab".repeat(32) },
    { paymentOutputIndex: 1 },
    { inputIndex: 1 },
    { accepted: exact({}, { payToScriptPublicKey: "0000" + "20" + "11".repeat(32) + "ac" }) as never },
    { request: { ...REQUEST, url: "https://vendor.example/other" } },
    { accepted: exact({ amount: "9000000" }) as never },
  ]) {
    assert.notEqual((await authorize({ ...AUTH, ...change }, sign)).digest, base, JSON.stringify(change));
  }
});

test("the assembled payment passes their schema validator", async () => {
  const payment = await buildPayment(
    { ...AUTH, transaction: "{}", payerAddress: "kaspatest:qqgrant" },
    sign,
  );

  assert.equal(payment.x402Version, X402_VERSION);
  assert.equal(payment.payload.type, "exact-transaction");

  // encodePaymentSignatureHeader validates before encoding, so this returning
  // at all is their validator accepting what we built
  const header = paymentSignatureHeader(payment);
  const round = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(round.payload.requestHash, requestHash(REQUEST, exact() as never));
  assert.equal(round.payload.transactionEncoding, "kaspa-sdk-safe-json-v2.0.0");
  assert.equal(round.accepted.amount, "5000000");
});

test("a payment this client assembles wrongly fails here, not after broadcast", async () => {
  const payment = await buildPayment({ ...AUTH, transaction: "{}" }, sign);
  // a payment output index their schema will not accept
  const broken = { ...payment, payload: { ...payment.payload, paymentOutputIndex: -1 } };
  assert.throws(() => paymentSignatureHeader(broken as never));
});
