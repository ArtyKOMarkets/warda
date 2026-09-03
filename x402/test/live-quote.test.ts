/**
 * This client against a real 402 from the reference implementation's server.
 *
 * Every other test here is built from their schemas, their validators and their
 * published code. This one is built from a response their server actually sent,
 * and it is the only test in the suite that could have caught what it caught:
 * the quote travels in a HEADER, and the body is a stub. Nothing in the schema
 * says where the document lives, so nothing schema-driven could have known.
 *
 * Captured by hand because both this repository's environments sit behind an
 * egress allowlist that does not include their host. One curl, ten seconds, and
 * it found a bug that all 54 of the other tests agreed was not there.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  decodeAddress,
  payToPubkeyScript,
  serializedScriptPublicKey,
} from "@warda_protocol/kaspa";

import { dialect, readPaymentRequired, selectRequirement } from "../src/v2.ts";
import { amountOf, assertPayeeScriptMatches } from "../src/pay-v2.ts";

const captured = JSON.parse(
  readFileSync(new URL("./fixtures/demo-kaspa-x402-402.json", import.meta.url), "utf8"),
);
const HEADER: string = captured.headers["PAYMENT-REQUIRED"];
const BODY = JSON.parse(captured.body);

/** Their payout address, as served. */
const BODY_PAY_TO = "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";

test("the body alone would have this client call a v2 server v1", () => {
  // Kept as a test rather than a comment: this is the actual failure, and it
  // is only wrong because the header exists. The body is not malformed.
  assert.equal(dialect(BODY), "v1");
  assert.equal(dialect(readPaymentRequired(HEADER, BODY)), "v2");
});

test("their real quote is one this client can pay", () => {
  const accepted = selectRequirement(readPaymentRequired(HEADER, BODY));

  assert.equal(accepted.scheme, "exact");
  assert.equal((accepted.extra as { profile: string }).profile, "standard-native");
  assert.equal(accepted.network, "kaspa:testnet-10", "the network this repo already lives on");
  assert.equal(amountOf(accepted), 20_000_000n);

  // 0.2 KAS, comfortably above the storage-mass floor that makes payments
  // under about 0.02 KAS impossible on Kaspa whatever the budget allows.
  assert.ok(amountOf(accepted) > 2_000_000n);
});

test("their payee is P2PK, so a grant can pay it at all", () => {
  const accepted = selectRequirement(readPaymentRequired(HEADER, BODY));
  const decoded = decodeAddress(accepted.payTo);

  // The structural question. A covenant builds the payee output as
  // P2PK(recipient) and nothing else, so a P2SH vendor is not "rejected" —
  // there is no transaction shape that pays them from a grant.
  assert.equal(decoded.version, 0, "pay-to-pubkey");
  assert.equal(decoded.payload.length, 32);
});

test("the script we would build is byte-for-byte the script they asked for", () => {
  const accepted = selectRequirement(readPaymentRequired(HEADER, BODY));
  const ours = serializedScriptPublicKey(payToPubkeyScript(decodeAddress(accepted.payTo).payload));

  assert.equal(ours, (accepted.extra as { payToScriptPublicKey: string }).payToScriptPublicKey);
  assertPayeeScriptMatches(accepted, ours); // does not throw
});

test("a missing header falls back to the body, and a broken one says so", () => {
  assert.equal(readPaymentRequired(null, BODY), BODY);
  assert.throws(() => readPaymentRequired("!!!not base64!!!", BODY), /not JSON/);
});

// ---- the whole loop, against their real quote ---------------------------

import {
  EMPTY_RESERVE,
  RecipientSet,
  agentPublicKey,
  fromHex,
  templateIdFor,
  toHex,
  type CovenantTemplate,
  type GrantState,
} from "@warda_protocol/kaspa";
import { validatePaymentPayload } from "@kaspa-x402/core";

import { WardaPayer, wardaFetchV2, type Grant } from "../src/index.ts";

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8"),
);

const AGENT = fromHex("11".repeat(32));
const agentKey = toHex(agentPublicKey(AGENT));
const authority = { principalKey: agentKey, revocationKey: agentKey };

/** THEIR payee key, read out of the quote they actually served. */
const THEIR_PAYEE = decodeAddress(
  selectRequirement(readPaymentRequired(HEADER, BODY)).payTo,
).payload;
const recipients = new RecipientSet([THEIR_PAYEE]);

const grant: Grant = {
  template,
  authority,
  recipients,
  state: {
    agentKey,
    budgetTotal: 50_00000000n,
    maxPerSpend: 1_00000000n,
    epochLimit: 5_00000000n,
    epochLength: 1000n,
    recipientsRoot: recipients.rootHex,
    notBefore: 1_000_000n,
    expiresAt: 2_000_000n,
    delegationDepth: 2n,
    templateId: templateIdFor(template, authority),
    spentTotal: 0n,
    reserved: 0n,
    epochIndex: 0n,
    epochSpent: 0n,
    reserveRoot: EMPTY_RESERVE,
  } satisfies GrantState,
};

const node = {
  getBlockDagInfo: async () => ({ virtualDaaScore: 1_005_000n }),
  grantUtxo: async () => ({
    outpoint: { transactionId: fromHex("7d".repeat(32)), index: 0 },
    entry: {
      value: 50_00000000n,
      blockDaaScore: 1_000_000n,
      isCoinbase: false,
      covenantId: fromHex("ee".repeat(32)),
    },
  }),
  submitTransaction: async () => {
    throw new Error("a v2 payer must not broadcast — their server does that");
  },
} as never;

/** Their response, reproduced exactly: the stub body, the header, the type. */
function theirResponse() {
  return new Response(captured.body, {
    status: captured.status,
    headers: {
      "content-type": captured.headers["content-type"],
      "PAYMENT-REQUIRED": HEADER,
    },
  });
}

test("a grant that commits to their payee pays their real quote, start to finish", async () => {
  const payer = new WardaPayer({ grant, node, sign: AGENT });
  const events: string[] = [];
  let sent: string | undefined;

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const header = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
    if (!header) return theirResponse();
    sent = header;
    return new Response(JSON.stringify({ ok: true, data: "…" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as never;

  const res = await wardaFetchV2(
    "https://demo.kaspa-x402.org/exact",
    { method: "GET" },
    { payer, fetchImpl, onEvent: (e) => events.push(e.type) },
  );

  assert.equal(res.status, 200);
  assert.deepEqual(events, ["quote", "signed", "settled", "done"]);
  assert.equal(payer.state.spentTotal, 20_000_000n, "0.2 KAS charged against the budget");

  const payment = JSON.parse(Buffer.from(sent!, "base64").toString("utf8"));
  assert.ok(validatePaymentPayload(payment).ok, "their validator accepts what we would send");
  assert.equal(payment.accepted.payTo, BODY_PAY_TO);

  // the transaction pays THEM, in their encoding, at the index we declared
  const tx = JSON.parse(payment.payload.transaction);
  assert.equal(tx.outputs[payment.payload.paymentOutputIndex].value, "20000000");
  assert.equal(
    tx.outputs[payment.payload.paymentOutputIndex].scriptPublicKey,
    serializedScriptPublicKey(payToPubkeyScript(THEIR_PAYEE)),
  );
});

test("the same quote against a grant that never committed to them is refused, in words", async () => {
  const stranger = new RecipientSet([fromHex("cc".repeat(32))]);
  const other: Grant = {
    ...grant,
    recipients: stranger,
    state: { ...grant.state, recipientsRoot: stranger.rootHex },
  };
  const payer = new WardaPayer({ grant: other, node, sign: AGENT });

  await assert.rejects(
    () =>
      wardaFetchV2("https://demo.kaspa-x402.org/exact", {}, {
        payer,
        fetchImpl: (async () => theirResponse()) as never,
      }),
    /not on this grant's allowlist/,
  );
  assert.equal(payer.outstanding.status, "none", "and nothing was signed");
});
