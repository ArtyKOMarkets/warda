/**
 * The v2 payment path, and above all the state machine around it.
 *
 * The interesting cases here are not cryptographic. They are what happens to a
 * grant's bookkeeping when a signed spend leaves the process and the process
 * does not find out what became of it — which is the ordinary case in v2,
 * because the vendor broadcasts.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EMPTY_RESERVE,
  RecipientSet,
  agentPublicKey,
  fromHex,
  payToPubkeyScript,
  pubkeyToAddress,
  serializedScriptPublicKey,
  signDigest,
  templateIdFor,
  toHex,
  verifyDigest,
  type CovenantTemplate,
  type GrantState,
} from "@warda_protocol/kaspa";
import { validatePaymentPayload, X402_VERSION } from "@kaspa-x402/core";

import { WardaPayer, X402Error, type Grant } from "../src/index.ts";
import { amountOf, assertPayeeScriptMatches } from "../src/pay-v2.ts";

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8"),
);

const AGENT = fromHex("11".repeat(32));
const agentKey = toHex(agentPublicKey(AGENT));
const authority = { principalKey: agentKey, revocationKey: agentKey };

const VENDOR = fromHex("a2".repeat(32));
const recipients = new RecipientSet([VENDOR]);
const vendorAddress = pubkeyToAddress(VENDOR, "kaspatest");
const vendorScript = serializedScriptPublicKey(payToPubkeyScript(VENDOR));

const state: GrantState = {
  agentKey,
  budgetTotal: 1_000_00000000n,
  maxPerSpend: 20_00000000n,
  epochLimit: 50_00000000n,
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
};
const grant: Grant = { template, authority, state, recipients };

/** A node that answers the two reads a v2 build makes, and nothing else — a
 *  v2 payer must never reach `submitTransaction`, and this proves it cannot. */
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
  // The payer DOES broadcast in v2. The transaction travels in the payload for
  // the vendor to VERIFY, not to submit — their facilitator requires the
  // payment to have reached the finality the quote names, which nothing can
  // require of a transaction it is about to submit itself.
  submitTransaction: async () => "cafe".repeat(16),
  // Non-empty: acceptance is observed as a coin at the successor address.
  getUtxosByAddresses: async () => [{ entry: { value: 1n } }],
} as never;

function quote(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
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
      ...extra,
    },
    ...over,
  } as never;
}

const REQUEST = { method: "POST", url: "https://vendor.example/infer", body: { prompt: "hi" } };
const payer = () => new WardaPayer({ grant, node, sign: AGENT });

// ---- the amount ----------------------------------------------------------

test("a v1 quote on the v2 path is named as such rather than crashing", () => {
  assert.throws(() => amountOf({ amountSompi: "20000000" } as never), /belongs on the v1 path/);
  assert.throws(() => amountOf(quote({ amount: "0" })), /must be positive/);
  assert.throws(() => amountOf(quote({ amount: "20.5" })), /decimal string of sompi/);
  assert.equal(amountOf(quote()), 20_000_000n);
});

// ---- the payee script ----------------------------------------------------

test("a vendor expecting a script a grant cannot build is refused before signing", () => {
  assert.throws(
    () => assertPayeeScriptMatches(quote({}, { payToScriptPublicKey: "0000aa20" }), vendorScript),
    /the covenant builds P2PK for the payee/,
  );
  // and the matching case passes silently, case-insensitively
  assertPayeeScriptMatches(quote(), vendorScript.toUpperCase());
});

// ---- building ------------------------------------------------------------

test("a built payment is complete and valid by their schema", async () => {
  const p = payer();
  const pending = await p.buildPaymentV2({ accepted: quote(), request: REQUEST });

  assert.equal(pending.amountSompi, 20_000_000n);
  assert.equal(pending.payer, p.address, "the grant has not moved yet");
  assert.notEqual(pending.successorAddress, pending.payer);
  assert.match(pending.txid, /^[0-9a-f]{64}$/);

  const decoded = JSON.parse(Buffer.from(pending.header, "base64").toString("utf8"));
  assert.equal(decoded.x402Version, X402_VERSION);
  assert.ok(validatePaymentPayload(decoded).ok, "their validator accepts it");

  // the transaction travels whole, in their encoding, with the payee at output 1
  const tx = JSON.parse(decoded.payload.transaction);
  assert.equal(tx.id, pending.txid);
  assert.equal(tx.outputs[1].value, "20000000");
  assert.equal(tx.outputs[1].scriptPublicKey, vendorScript);
});

test("the authorization is signed by the grant's agent key", async () => {
  const pending = await payer().buildPaymentV2({ accepted: quote(), request: REQUEST });
  const { digest, signature } = pending.payment.payload.authorization;

  assert.equal(signature.length, 128, "64 bytes: their schema takes no sighash-type byte");

  // Putting Kaspa's sighash-type byte back is what makes this checkable with
  // the SDK's own verifier, and proves the trimmed 64 bytes are the signature
  // rather than a prefix of something else.
  const restored = new Uint8Array(65);
  restored.set(fromHex(signature));
  restored[64] = signDigest(fromHex(digest), AGENT)[64]!;
  assert.ok(verifyDigest(restored, fromHex(digest), fromHex(agentKey)));
});

test("the grant's own limits still bind, and report themselves the same way", async () => {
  await assert.rejects(
    () => payer().buildPaymentV2({ accepted: quote({ amount: "2100000000" }), request: REQUEST }),
    /per-payment cap/,
  );
  const stranger = pubkeyToAddress(fromHex("cc".repeat(32)), "kaspatest");
  await assert.rejects(
    () =>
      payer().buildPaymentV2({
        accepted: quote({ payTo: stranger }, {
          payToScriptPublicKey: serializedScriptPublicKey(payToPubkeyScript(fromHex("cc".repeat(32)))),
        }),
        request: REQUEST,
      }),
    /not on this grant's allowlist/,
  );
});

// ---- the state machine ---------------------------------------------------

test("a second payment is refused while the first is in a vendor's hands", async () => {
  const p = payer();
  await p.buildPaymentV2({ accepted: quote(), request: REQUEST });

  assert.equal(p.outstanding.status, "pending");
  await assert.rejects(
    () => p.buildPaymentV2({ accepted: quote(), request: REQUEST }),
    /at most one of them can land/,
  );
});

test("the v1 path is blocked too — it is the same coin", async () => {
  const p = payer();
  await p.buildPaymentV2({ accepted: quote(), request: REQUEST });
  await assert.rejects(() => p.pay({ payTo: vendorAddress } as never), /already has a signed payment/);
});

test("settling advances the grant to exactly where the spend put it", async () => {
  const p = payer();
  const pending = await p.buildPaymentV2({ accepted: quote(), request: REQUEST });
  const before = p.address;

  const result = p.settledV2();
  assert.equal(result.txid, pending.txid);
  assert.equal(result.state.spentTotal, 20_000_000n);
  assert.equal(result.address, pending.successorAddress);
  assert.equal(p.address, pending.successorAddress);
  assert.notEqual(p.address, before);
  assert.equal(p.outstanding.status, "none", "and the payer is free again");
});

test("abandoning does NOT roll back — it stops, and names both candidates", async () => {
  const p = payer();
  const pending = await p.buildPaymentV2({ accepted: quote(), request: REQUEST });

  const out = p.abandonedV2("the vendor never answered.");
  assert.equal(out.status, "unresolved");
  assert.deepEqual(
    out.status === "unresolved" ? out.candidates : null,
    [pending.payer, pending.successorAddress],
  );
  assert.match(out.status === "unresolved" ? out.why : "", /not knowable from here/);

  // the grant did NOT quietly return to its old state
  await assert.rejects(
    () => p.buildPaymentV2({ accepted: quote(), request: REQUEST }),
    /no longer knows where its grant is/,
  );
  await assert.rejects(() => p.pay({ payTo: vendorAddress } as never), /follow-grant/);
});

test("settling or abandoning nothing is an error, not a silent no-op", async () => {
  const p = payer();
  assert.throws(() => p.settledV2(), /no payment outstanding to settle/);
  assert.throws(() => p.abandonedV2(), /no payment outstanding to abandon/);

  await p.buildPaymentV2({ accepted: quote(), request: REQUEST });
  p.settledV2();
  assert.throws(() => p.settledV2(), /no payment outstanding/);
});

// ---- the fetch loop ------------------------------------------------------

import { bodyForBinding, wardaFetchV2 } from "../src/index.ts";
import { requestHash } from "../src/v2.ts";

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const quoted = () => ({ x402Version: X402_VERSION, resource: { url: "https://vendor.example/infer" }, accepts: [quote()] });

test("bodyForBinding hashes what the vendor will hash, not the string we sent", () => {
  assert.deepEqual(bodyForBinding({ body: '{"prompt":"hi"}' }), { prompt: "hi" });
  assert.equal(bodyForBinding({}), null);
  assert.equal(bodyForBinding({ body: "" }), null);
  assert.equal(bodyForBinding({ body: "not json" }), null);
  // an explicit override wins, including an explicit null
  assert.equal(bodyForBinding({ body: '{"a":1}' }, null), null);
  assert.deepEqual(bodyForBinding(undefined, { a: 1 }), { a: 1 });
});

test("the happy path pays once, settles, and moves the grant", async () => {
  const p = payer();
  const events: string[] = [];
  let sentHeader: string | undefined;

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const header = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
    if (!header) return res(402, quoted());
    sentHeader = header;
    return res(200, { answer: "42" });
  }) as never;

  const out = await wardaFetchV2(
    "https://vendor.example/infer",
    { method: "POST", body: JSON.stringify({ prompt: "hi" }) },
    { payer: p, fetchImpl, onEvent: (e) => events.push(e.type) },
  );

  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { answer: "42" });
  assert.deepEqual(events, ["quote", "signed", "broadcast", "settled", "done"]);
  assert.equal(p.outstanding.status, "none");
  assert.equal(p.state.spentTotal, 20_000_000n);

  // the binding covers the request that was actually sent
  const decoded = JSON.parse(Buffer.from(sentHeader!, "base64").toString("utf8"));
  assert.equal(
    decoded.payload.requestHash,
    requestHash(
      { method: "POST", url: "https://vendor.example/infer", body: { prompt: "hi" } },
      quote(),
    ),
  );
});

test("a spend the chain accepted is banked even when the vendor refuses to serve", async () => {
  // Two different facts: whether the COIN moved, and whether the SERVICE was
  // delivered. The chain settles the first and the vendor the second, and
  // conflating them left the manifest pointing at an address holding nothing.
  const p = payer();
  const events: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) =>
    (init?.headers as Record<string, string>)?.["PAYMENT-SIGNATURE"]
      ? res(402, { error: "invalid_transaction_state" })
      : res(402, quoted())) as never;

  await assert.rejects(
    () =>
      wardaFetchV2("https://vendor.example/infer", { method: "POST" }, {
        payer: p,
        fetchImpl,
        onEvent: (e) => events.push(e.type),
      }),
    /IS on chain and accepted.*not served/s,
  );

  assert.deepEqual(events, ["quote", "signed", "broadcast", "settled", "unresolved"]);
  assert.equal(p.outstanding.status, "none", "not stuck: we watched it land");
  assert.equal(p.state.spentTotal, 20_000_000n, "and the grant moved, because it did");
});

test("a spend that never reached the chain still stops the payer", async () => {
  const p = payer();
  const fetchImpl = (async (_url: string, init: RequestInit) =>
    (init?.headers as Record<string, string>)?.["PAYMENT-SIGNATURE"]
      ? res(500, { error: "boom" })
      : res(402, quoted())) as never;

  await assert.rejects(
    () =>
      wardaFetchV2("https://vendor.example/infer", {}, {
        payer: p,
        fetchImpl,
        broadcast: false,
      }),
    /stopped rather than assume/,
  );
  assert.equal(p.outstanding.status, "unresolved");
  assert.equal(p.state.spentTotal, 0n);
});

test("a v1 server on the v2 path is told which function to use", async () => {
  const fetchImpl = (async () =>
    res(402, { accepts: [{ scheme: "exact", amountSompi: "20000000" }] })) as never;
  await assert.rejects(
    () => wardaFetchV2("https://v/x", {}, { payer: payer(), fetchImpl }),
    /speaks x402 v1, not v2. Use wardaFetch/,
  );
});

test("a per-call ceiling refuses before anything is signed", async () => {
  const p = payer();
  const fetchImpl = (async () => res(402, quoted())) as never;
  await assert.rejects(
    () =>
      wardaFetchV2("https://vendor.example/infer", {}, {
        payer: p,
        fetchImpl,
        maxAmountSompi: 1_000_000n,
      }),
    /Nothing was signed/,
  );
  assert.equal(p.outstanding.status, "none");
});

test("a free endpoint is not paid for", async () => {
  const p = payer();
  const fetchImpl = (async () => res(200, { free: true })) as never;
  const out = await wardaFetchV2("https://vendor.example/free", {}, { payer: p, fetchImpl });
  assert.equal(out.status, 200);
  assert.equal(p.state.spentTotal, 0n);
});
