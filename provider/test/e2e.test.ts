/**
 * The loop, closed offline: a payer builds a relayed payment, and this package
 * reads the grant out of the header it actually sent.
 *
 * Every other test here constructs the proof. This one does not touch it — it
 * takes whatever `WardaPayer` emits and asks the verifier what it can conclude.
 * That is the only way to catch the failure this pair is most likely to have:
 * the two halves were written an hour apart by the same hand, and a proof the
 * payer encodes in one shape and the provider parses in another passes both
 * suites separately and nothing in production.
 *
 * It is the same class of mistake `interop.ts` already made this week — it
 * wrote a purchase record in a format nothing read, while a commit said it used
 * the one that existed. That was a status page. This is a provider's request
 * path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EMPTY_RESERVE,
  RecipientSet,
  agentPublicKey,
  decodeAddress,
  fromHex,
  fromWire,
  payToPubkeyScript,
  pubkeyToAddress,
  serializedScriptPublicKey,
  templateIdFor,
  toHex,
  type CovenantTemplate,
  type GrantState,
} from "@warda_protocol/kaspa";
import { WardaPayer, decodeGrantProof, type Grant } from "@warda_protocol/x402";

import { verifyProof } from "../src/verify.ts";

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8"),
);

/* Published on /attack on purpose: the covenant bounds this key, not secrecy. */
const AGENT = fromHex("9fccfb08645b4a5a49f0f461b9ae7209865c234f941e9d4679e8a18da77af2ad");
const agentKey = toHex(agentPublicKey(AGENT));
const vendorKey = "be".repeat(32);
const vendorAddress = pubkeyToAddress(fromHex(vendorKey), "kaspatest");
const vendorScript = serializedScriptPublicKey(payToPubkeyScript(fromHex(vendorKey)));

/* The agent's own key is on the allowlist, because a relayed payment pays it
   first and an allowlist is fixed at genesis. */
const recipients = new RecipientSet([vendorKey, agentKey]);
const authority = { principalKey: "03".repeat(32).slice(0, 64), revocationKey: "03".repeat(32).slice(0, 64) };

const state: GrantState = {
  agentKey,
  budgetTotal: 300_00000000n,
  maxPerSpend: 25_00000000n,
  epochLimit: 50_00000000n,
  epochLength: 1_000n,
  recipientsRoot: recipients.rootHex,
  notBefore: 1_000_000n,
  expiresAt: 9_000_000n,
  delegationDepth: 2n,
  templateId: templateIdFor(template, authority),
  spentTotal: 7_00000000n,
  reserved: 0n,
  epochIndex: 0n,
  epochSpent: 0n,
  reserveRoot: EMPTY_RESERVE,
};
const grant: Grant = { template, authority, state, recipients };

let relayedId: string | undefined;
const node = {
  getBlockDagInfo: async () => ({ virtualDaaScore: 1_005_000n }),
  grantUtxo: async () => ({
    outpoint: { transactionId: fromHex("7d".repeat(32)), index: 0 },
    entry: {
      value: 500_00000000n,
      blockDaaScore: 1_000_000n,
      isCoinbase: false,
      covenantId: fromHex("ee".repeat(32)),
    },
  }),
  submitTransaction: async () => "cafe".repeat(16),
  submitOrdinaryPayment: async (signed: { id: Uint8Array }) => {
    relayedId = toHex(signed.id);
    return relayedId;
  },
  getUtxosByAddresses: async () => [
    { outpoint: { transactionId: fromHex("dd".repeat(32)), index: 0 }, entry: { value: 1n } },
  ],
} as never;

const accepted = {
  scheme: "exact" as const,
  network: "kaspa:testnet-10" as const,
  amount: "20000000",
  asset: "KAS" as const,
  payTo: vendorAddress,
  maxTimeoutSeconds: 120,
  extra: {
    binding: "kaspa-exact-v2",
    profile: "standard-native",
    finality: "accepted",
    transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
    payToScriptPublicKey: vendorScript,
  },
} as never;

async function relayedPayment() {
  const payer = new WardaPayer({ grant, node, sign: AGENT });
  return await payer.buildPaymentV2({
    accepted,
    request: { method: "POST", url: "https://vendor.example/infer", body: { prompt: "hi" } },
    relay: true,
  });
}

test("a relayed payment carries a grant proof at all", async () => {
  const pending = await relayedPayment();
  assert.ok(pending.grantProof, "a relayed payment must carry one — the grant is invisible without it");
  assert.ok(pending.relay, "and it is relayed");
});

test("the provider reads the payer's own header, bound to the payer's own payment", async () => {
  const pending = await relayedPayment();
  const proof = decodeGrantProof(pending.grantProof!);
  assert.ok(proof);

  /* The outpoint the RELAYED payment spends, which is what a provider's x402
     verifier hands them. It is the funding transaction and the output the
     covenant paid the relay key at — the link the whole verdict rests on. */
  const paymentInput = {
    transactionId: pending.relay!.fundingTxid,
    index: 1,
  };

  const v = verifyProof(proof!, template, { paymentInput });
  assert.ok(v.warda && v.bounded, v.warda && !v.bounded ? v.reason : "not bounded");
  if (!(v.warda && v.bounded)) return;

  /* The terms the payer's own grant actually has, not terms this test chose. */
  assert.equal(v.maxPerPayment, state.maxPerSpend);
  assert.equal(v.budgetTotal, state.budgetTotal);
  assert.equal(v.budgetRemaining, state.budgetTotal - state.spentTotal);
  assert.equal(v.expiresAt, state.expiresAt);
  assert.equal(v.agentKey, agentKey);
  assert.equal(v.authorisedToPayMe, "unknown");
});

test("the proof describes the FUNDING transaction, not the one the vendor verifies", async () => {
  /* Two ids for one payment, and confusing them is how a recovery looks at the
     wrong transaction. The vendor verifies the relayed payment; the proof is
     about the covenant spend that funded it, and binding against the wrong one
     must fail rather than quietly pass. */
  const pending = await relayedPayment();
  const proof = decodeGrantProof(pending.grantProof!)!;
  assert.notEqual(pending.txid, pending.relay!.fundingTxid);

  const v = verifyProof(proof, template, {
    paymentInput: { transactionId: pending.txid, index: 1 },
  });
  assert.ok(v.warda && !v.bounded);
});

test("the funding transaction in the proof really pays the relay key", async () => {
  /* Not asserted by the verifier — it is asserted here, about the payer, so
     that a change to which output funds the relay is caught by a test rather
     than by a provider whose binding suddenly stops matching. */
  const pending = await relayedPayment();
  const proof = decodeGrantProof(pending.grantProof!)!;
  const funding = fromWire(proof.funding);
  const relayOut = funding.outputs[proof.relayOutputIndex]!;
  /* `payToPubkeyScript` returns a ScriptPublicKey, not bytes — compare the
     script, not the wrapper. */
  const expected = payToPubkeyScript(fromHex(agentKey)).script;
  assert.equal(toHex(relayOut.scriptPublicKey.script), toHex(expected));
  assert.equal(
    pubkeyToAddress(fromHex(agentKey), "kaspatest"),
    pending.relay!.relayAddress,
  );
  void decodeAddress;
});
