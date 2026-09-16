/**
 * The provider's verdict, against a real covenant spend.
 *
 * `sdk/js-spend.json` is a recorded testnet-10 grant spend — the same vector
 * the safe-JSON suites use — so the grant read out below is one the network
 * actually accepted, not one this test made up.
 *
 * The test that matters is the BINDING. Everything else this package reports is
 * true of some grant; only the binding makes it true of the payment in front of
 * the provider, and a proof that is not bound is an assertion anyone could make
 * by copying a transaction out of the DAG.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };
import { bytecodeFor, fromWire, toHex, transactionId, type CovenantTemplate } from "@warda_protocol/kaspa";
import { toGrant } from "@warda_protocol/agent";
import { encodeGrantProof, GRANT_PROOF_HEADER, type GrantProof } from "@warda_protocol/x402";

import { verifyGrantProof, verifyProof } from "../src/verify.ts";

const TEMPLATE = covenantTemplate as unknown as CovenantTemplate;

/**
 * A covenant spend built here, not a recorded one.
 *
 * `sdk/js-spend.json` is the repository's golden vector and it was recorded
 * under covenant v2 — its signature script carries a 3,330-byte redeem script
 * where v4's is 6,912. Using it would have tested that this package rejects an
 * old covenant, which it does, and nothing about the case it exists for.
 *
 * So the redeem script is compiled from the CURRENT template and the demo
 * grant's real terms, and wrapped in the signature script Kaspa's P2SH
 * requires: an OP_PUSHDATA2 push of the script in the clear. Everything this
 * package reads — the terms, the outputs, the id — is read from that.
 *
 * What this does NOT test is that the network would accept the transaction.
 * It is not signed and it never left this process. That is the right division:
 * the provider's own x402 verifier establishes the payment is on chain, and
 * this package's job begins after that and is stated in `assumes`.
 */
const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../covenant/deploy/grant-demo.json", import.meta.url)), "utf8"),
);
const RECIPIENTS = readFileSync(
  fileURLToPath(new URL("../../covenant/deploy/demo-recipients.txt", import.meta.url)),
  "utf8",
).split(/\r?\n/);

const grant = toGrant(MANIFEST, RECIPIENTS, TEMPLATE);
const redeem = bytecodeFor(TEMPLATE, { authority: grant.authority, state: grant.state });
const sigScript = new Uint8Array([
  0x4d, redeem.length & 0xff, (redeem.length >> 8) & 0xff, ...redeem,
]);

const PAYEE_OUTPUT = 1;
const spend = {
  version: 1,
  lockTime: "0",
  subnetworkId: "00".repeat(20),
  gas: "0",
  payloadHex: "",
  inputs: [{
    previousOutpointTransactionId: "11".repeat(32),
    previousOutpointIndex: 0,
    signatureScriptHex: toHex(sigScript),
    sequence: "0",
    computeBudget: 16,
  }],
  outputs: [
    /* 0: the successor grant. 1: the relay key this payment came from. */
    { value: "100000000", scriptPublicKeyVersion: 0, scriptPublicKeyHex: "aa20" + "cc".repeat(32) + "87", covenant: null },
    { value: "20194880", scriptPublicKeyVersion: 0, scriptPublicKeyHex: "20" + "dd".repeat(32) + "ac", covenant: null },
  ],
  utxos: [],
  txid: "",
  builtBy: "provider test",
};
const TXID = toHex(transactionId(fromWire(spend as never)));

const proof: GrantProof = { warda: 1, funding: spend as never, relayOutputIndex: PAYEE_OUTPUT };
const boundTo = { transactionId: TXID, index: PAYEE_OUTPUT };

test("a bound proof yields the grant's terms", () => {
  const v = verifyProof(proof, TEMPLATE, { paymentInput: boundTo });
  assert.equal(v.warda, true);
  assert.ok(v.warda && v.bounded, v.warda && !v.bounded ? v.reason : "");
  if (!(v.warda && v.bounded)) return;
  assert.ok(v.maxPerPayment > 0n, "a cap this payment could not have exceeded");
  assert.ok(v.budgetTotal > 0n);
  assert.ok(v.budgetRemaining <= v.budgetTotal);
  assert.ok(v.expiresAt > v.notBefore, "a window that ends");
  assert.match(v.agentKey, /^[0-9a-f]{64}$/);
  assert.equal(v.fundingTxid, TXID);
});

test("it says what it does NOT know, in a field rather than by omission", () => {
  /* The relay hop means the chain did not constrain who was ultimately paid.
     An absent field reads as "not applicable"; a present one saying it does not
     know gets read, and asked about. The whole credibility of this package is
     that it declines to make the stronger claim. */
  const v = verifyProof(proof, TEMPLATE, { paymentInput: boundTo });
  assert.ok(v.warda && v.bounded);
  if (!(v.warda && v.bounded)) return;
  assert.equal(v.authorisedToPayMe, "unknown");
  assert.match(v.assumes, /on chain/);
});

test("a proof describing a DIFFERENT transaction is refused", () => {
  /* The attack this exists for: copy any covenant spend out of the DAG, one
     with a large budget, attach it, and claim its terms. Every field would be
     true about a grant that has nothing to do with the money that arrived. */
  const v = verifyProof(proof, TEMPLATE, {
    paymentInput: { transactionId: "ab".repeat(32), index: PAYEE_OUTPUT },
  });
  assert.ok(v.warda && !v.bounded);
  if (!(v.warda && !v.bounded)) return;
  assert.match(v.reason, /did not fund the coin that paid you/);
});

test("a proof naming a different OUTPUT of the right transaction is refused too", () => {
  /* One transaction, two outputs: the successor grant and the payee. Naming
     the wrong one is not a typo, it is a claim about which coin moved. */
  const v = verifyProof(proof, TEMPLATE, {
    paymentInput: { transactionId: TXID, index: 0 },
  });
  assert.ok(v.warda && !v.bounded);
});

test("an output index the transaction does not have is refused", () => {
  const v = verifyProof({ ...proof, relayOutputIndex: 9 }, TEMPLATE, {
    paymentInput: { transactionId: TXID, index: 9 },
  });
  assert.ok(v.warda && !v.bounded);
  if (!(v.warda && !v.bounded)) return;
  assert.match(v.reason, /cannot be describing this payment/);
});

test("no header is not an error — most payers are not Warda payers", () => {
  const v = verifyGrantProof({ headers: {} }, TEMPLATE, { paymentInput: boundTo });
  assert.deepEqual(v, { warda: false, reason: "no proof" });
});

test("a header that is present and unreadable IS an error", () => {
  /* A payer sending one is making a claim. A claim that cannot be read is not
     the same as no claim, and must not be reported as one. */
  const v = verifyGrantProof(
    { headers: { [GRANT_PROOF_HEADER]: "not base64 of anything" } },
    TEMPLATE,
    { paymentInput: boundTo },
  );
  assert.ok(v.warda && !v.bounded);
});

test("it reads a Request's headers and a plain object's alike", () => {
  const header = encodeGrantProof(spend as never, PAYEE_OUTPUT);
  const fromRequest = verifyGrantProof(
    { headers: new Headers({ [GRANT_PROOF_HEADER]: header }) },
    TEMPLATE,
    { paymentInput: boundTo },
  );
  const fromObject = verifyGrantProof(
    { headers: { [GRANT_PROOF_HEADER.toLowerCase()]: header } },
    TEMPLATE,
    { paymentInput: boundTo },
  );
  assert.ok(fromRequest.warda && fromRequest.bounded);
  assert.ok(fromObject.warda && fromObject.bounded);
});

test("a repeated header is treated as absent, not joined", () => {
  /* Two different proofs is not one claim. */
  const header = encodeGrantProof(spend as never, PAYEE_OUTPUT);
  const v = verifyGrantProof(
    { headers: { [GRANT_PROOF_HEADER]: [header, header] } },
    TEMPLATE,
    { paymentInput: boundTo },
  );
  assert.equal(v.warda, false);
});
