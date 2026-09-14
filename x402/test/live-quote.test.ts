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
  pubkeyToAddress,
  serializedScriptPublicKey,
} from "@warda_protocol/kaspa";

import { schnorr } from "@noble/curves/secp256k1.js";

import { relayFeeFor } from "../src/relay.ts";
import { wardaFetch } from "../src/fetch.ts";
import { buildRelayPayment } from "../src/relay.ts";
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
  // The payer DOES broadcast in v2. The transaction travels in the payload for
  // the vendor to VERIFY, not to submit — their facilitator requires the
  // payment to have reached the finality the quote names, which nothing can
  // require of a transaction it is about to submit itself.
  submitTransaction: async () => "cafe".repeat(16),
  // Non-empty: acceptance is observed as a coin at the successor address.
  getUtxosByAddresses: async () => [{ entry: { value: 1n } }],
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

/**
 * Their real quote, without a relay: refused here rather than on chain.
 *
 * This test used to end in a 200. It was wrong, and it was wrong in the way
 * that cost the most: everything this client could check passed — their schema
 * validator accepted the payload, the payee script matched, the amount was
 * right — and the payment still settled on chain and came back
 * `invalid_transaction_state`, eight times.
 *
 * Their envelope check refuses a covenant spend on three counts before it
 * looks at the payment at all. Now that the rule is readable, building one is
 * not an attempt; it is a payment we know will be refused after it has been
 * made. So the refusal moved to before the signature.
 */
test("their real quote cannot be paid by a covenant spend, and says so before signing", async () => {
  const payer = new WardaPayer({ grant, node, sign: AGENT });
  let broadcast = false;

  await assert.rejects(
    () =>
      wardaFetchV2("https://demo.kaspa-x402.org/exact", { method: "GET" }, {
        payer,
        fetchImpl: (async () => {
          broadcast = true;
          return theirResponse();
        }) as never,
      }),
    (e: Error) => {
      assert.match(e.message, /cannot accept a covenant spend/);
      assert.match(e.message, /output 0 IS the successor grant/);
      assert.match(e.message, /warda pay <url> --relay/);
      return true;
    },
  );
  assert.equal(payer.state.spentTotal, 0n, "nothing was signed, so nothing was spent");
  assert.equal(payer.outstanding.status, "none", "and the payer is not holding anything");
  assert.ok(broadcast, "the quote was fetched — the refusal is about the payment, not the quote");
});

/**
 * The allowlist still refuses a stranger, at the layer that still enforces it.
 *
 * Moved down from the fetch flow to `buildPaymentV2`, because the fetch flow
 * now refuses a covenant spend first and this test would be measuring that
 * instead. The refusal it checks is the one that is this protocol's product,
 * and it is worth keeping pointed at the thing that produces it.
 */
test("a grant that never committed to their payee refuses the spend, in words", async () => {
  const stranger = new RecipientSet([fromHex("cc".repeat(32))]);
  const other: Grant = {
    ...grant,
    recipients: stranger,
    state: { ...grant.state, recipientsRoot: stranger.rootHex },
  };
  const payer = new WardaPayer({ grant: other, node, sign: AGENT });

  await assert.rejects(
    () =>
      payer.buildPaymentV2({
        accepted: selectRequirement(readPaymentRequired(HEADER, BODY)),
        request: { method: "GET", url: "https://demo.kaspa-x402.org/exact" },
      }),
    /not on this grant's allowlist/,
  );
});

// ---- the relay, against the same real quote -------------------------------

/**
 * The whole point of the relay, end to end, against the quote their server
 * actually served.
 *
 * Every earlier attempt at this vendor settled on chain and was refused off
 * it. The rule turned out to be three lines of their envelope check — version
 * 0, no compute budget, no covenant on any output — and a covenant spend fails
 * all three before anything about the payment is examined. So the payment is a
 * SECOND transaction, and this asserts that what leaves the client is the one
 * they will accept rather than the one they refused eight times.
 */
const relayRecipients = new RecipientSet([THEIR_PAYEE, fromHex(agentKey)]);
const relayGrant: Grant = {
  ...grant,
  recipients: relayRecipients,
  state: { ...grant.state, recipientsRoot: relayRecipients.rootHex },
};

function relayNode(over: Record<string, unknown> = {}) {
  const submitted: { funding: number; ordinary: number } = { funding: 0, ordinary: 0 };
  const n = {
    ...(node as object),
    submitTransaction: async () => {
      submitted.funding++;
      return "cafe".repeat(16);
    },
    submitOrdinaryPayment: async (signed: { id: Uint8Array }, allowOrphan?: boolean) => {
      submitted.ordinary++;
      assert.equal(allowOrphan, true, "the parent may not have propagated yet");
      return toHex(signed.id);
    },
    ...over,
  } as never;
  return { node: n, submitted };
}

test("a relayed payment sends the ordinary transaction, not the covenant spend", async () => {
  const { node: n, submitted } = relayNode();
  const payer = new WardaPayer({ grant: relayGrant, node: n, sign: AGENT });
  let sent: string | undefined;

  const res = await wardaFetchV2(
    "https://demo.kaspa-x402.org/exact",
    { method: "GET" },
    {
      payer,
      relay: true,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const header = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
        if (!header) return theirResponse();
        sent = header;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never,
    },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(submitted, { funding: 1, ordinary: 1 }, "both halves, once each");

  const payment = JSON.parse(Buffer.from(sent!, "base64").toString("utf8"));
  assert.ok(validatePaymentPayload(payment).ok, "their validator accepts what we would send");

  const tx = JSON.parse(payment.payload.transaction);
  /* The three checks that refused every earlier attempt. */
  assert.equal(tx.version, 0, "version must be 0");
  assert.equal(tx.inputs[0].computeBudget, undefined, "a v0 input carries no compute budget");
  assert.equal(tx.outputs[0].covenant, null, "no output may carry a covenant");

  assert.equal(payment.payload.paymentOutputIndex, 0);
  assert.equal(tx.outputs.length, 1, "no change output, or the storage mass is ruinous");
  assert.equal(tx.outputs[0].value, "20000000");
  assert.equal(
    tx.outputs[0].scriptPublicKey,
    serializedScriptPublicKey(payToPubkeyScript(THEIR_PAYEE)),
  );
});

test("the grant is charged the invoice AND the relayed transaction's fee", async () => {
  const { node: n } = relayNode();
  const payer = new WardaPayer({ grant: relayGrant, node: n, sign: AGENT });
  await wardaFetchV2("https://demo.kaspa-x402.org/exact", { method: "GET" }, {
    payer,
    relay: true,
    relayFeeSompi: 400_000n,
    fetchImpl: (async (_u: string, init: RequestInit) =>
      (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"]
        ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        : theirResponse()) as never,
  });
  /* Not 20,000,000. The fee is part of what buying the thing costs, and a
     budget that did not count it would mean less than it says. */
  assert.equal(payer.state.spentTotal, 20_400_000n);
});

test("a grant without --relay is refused with the command that would have worked", async () => {
  const { node: n } = relayNode();
  const payer = new WardaPayer({ grant, node: n, sign: AGENT });
  await assert.rejects(
    () =>
      wardaFetchV2("https://demo.kaspa-x402.org/exact", {}, {
        payer,
        relay: true,
        fetchImpl: (async () => theirResponse()) as never,
      }),
    (e: Error) => {
      assert.match(e.message, /allowlist does not contain the agent's own key/);
      assert.match(e.message, /warda grant --payees payees\.txt --relay/);
      /* An allowlist is fixed at genesis, so this is not retryable and must
         not read like a transient failure. */
      assert.match(e.message, /fixed at genesis/);
      return true;
    },
  );
});

test("a funding broadcast that lands before a refused relay says where the money is", async () => {
  const { node: n } = relayNode({
    submitOrdinaryPayment: async () => {
      throw new Error("orphan rejected");
    },
  });
  const payer = new WardaPayer({ grant: relayGrant, node: n, sign: AGENT });
  await assert.rejects(
    () =>
      wardaFetchV2("https://demo.kaspa-x402.org/exact", {}, {
        payer,
        relay: true,
        fetchImpl: (async () => theirResponse()) as never,
      }),
    (e: Error) => {
      assert.match(e.message, /covenant spend was broadcast/);
      /* The failure that must never read as "nothing happened": the grant has
         moved and the money is at the relay address. A caller told only
         "submit failed" would pay again. */
      assert.match(e.message, /is now at kaspatest:/);
      assert.match(e.message, /Nothing is lost and nothing is paid/);
      return true;
    },
  );
});

/**
 * The price of the relay, stated as tests rather than as a paragraph.
 *
 * A relayed payment does not pay the vendor from the grant. It pays the AGENT
 * from the grant, and the agent pays the vendor — so the allowlist, which
 * constrains who the GRANT may pay, says nothing on chain about who ultimately
 * receives the money.
 *
 * This client still refuses a payee outside the allowlist, and that refusal is
 * worth having: it catches a typo'd URL or a vendor swapped under a running
 * agent. But it is a GUARD, not a guarantee, and the difference is the whole
 * point of this protocol — "not blocked by a library you could edit" stops
 * being true for this one hop. The third test below is what that means, done
 * rather than described.
 */
test("COST: this client guards the payee, and the guard is a client-side one", async () => {
  const strangers = new RecipientSet([fromHex("cc".repeat(32)), fromHex(agentKey)]);
  const neverCommitted: Grant = {
    ...grant,
    recipients: strangers,
    state: { ...grant.state, recipientsRoot: strangers.rootHex },
  };
  const { node: n } = relayNode();
  const payer = new WardaPayer({ grant: neverCommitted, node: n, sign: AGENT });

  await assert.rejects(
    () =>
      wardaFetchV2("https://demo.kaspa-x402.org/exact", {}, {
        payer,
        relay: true,
        fetchImpl: (async () => theirResponse()) as never,
      }),
    (e: Error) => {
      assert.match(e.message, /this client will not relay to a payee that is not on it/);
      /* The sentence that has to be there. The direct-spend refusal says "there
         is no valid transaction that pays them — none at all", which is true of
         a covenant spend and FALSE here: the agent can pay anybody. Telling
         somebody the chain forbids what only this process forbids is the kind
         of claim that gets believed and then discovered. */
      assert.match(e.message, /THIS CLIENT's, not the covenant's/);
      assert.match(e.message, /the chain does not constrain who ultimately receives it/);
      /* And what IS still enforced, named in the same breath. */
      assert.match(e.message, /budget, the per-payment cap, the epoch limit and the window/);
      return true;
    },
  );
  assert.equal(payer.state.spentTotal, 0n);
});

test("COST: and a DIRECT spend still says the chain forbids it, because it does", async () => {
  /* The same refusal at the layer where the strong claim is true. Kept beside
     the relay one so the two readings cannot drift into each other. */
  const stranger = new RecipientSet([fromHex("cc".repeat(32))]);
  const other: Grant = {
    ...grant,
    recipients: stranger,
    state: { ...grant.state, recipientsRoot: stranger.rootHex },
  };
  const payer = new WardaPayer({ grant: other, node, sign: AGENT });
  await assert.rejects(
    () =>
      payer.buildPaymentV2({
        accepted: selectRequirement(readPaymentRequired(HEADER, BODY)),
        request: { method: "GET", url: "https://demo.kaspa-x402.org/exact" },
      }),
    /no valid transaction that pays them/,
  );
});

test("COST: the quantitative limits are untouched, and those ARE enforced", async () => {
  const committed = new RecipientSet([THEIR_PAYEE, fromHex(agentKey)]);
  const tight: Grant = {
    ...grant,
    recipients: committed,
    /* Under the invoice plus the relay fee. The covenant does not care who is
       being paid — it cares how much, and that it still decides. */
    state: { ...grant.state, recipientsRoot: committed.rootHex, maxPerSpend: 20_100_000n },
  };
  const { node: n } = relayNode();
  const payer = new WardaPayer({ grant: tight, node: n, sign: AGENT });

  await assert.rejects(
    () =>
      wardaFetchV2("https://demo.kaspa-x402.org/exact", {}, {
        payer,
        relay: true,
        fetchImpl: (async () => theirResponse()) as never,
      }),
    /per payment|max-per-spend|exceeds|cap/i,
  );
  assert.equal(payer.state.spentTotal, 0n);
});

/**
 * What an agent running different code can do, which is the actual cost.
 *
 * Once the covenant has paid the relay key, the coin is an ordinary one at an
 * ordinary address, and the second transaction is an ordinary payment. Nothing
 * on chain says where it goes. This builds one to a payee no grant ever
 * committed to, and it succeeds — not because of a bug, but because there is
 * nothing left to stop it.
 *
 * Kept as a test so the claim cannot quietly stop being true in either
 * direction: if a future design DID constrain this hop, this would fail and
 * somebody would come and read why.
 */
test("COST: nothing on chain constrains the second hop, and here it is", async () => {
  const nobodysPayee = schnorr.getPublicKey(fromHex("77".repeat(32)));
  const built = await buildRelayPayment(
    {
      source: {
        outpoint: { transactionId: fromHex("ab".repeat(32)), index: 1 },
        value: 20_365_000n,
        publicKey: fromHex(agentKey),
      },
      accepted: {
        ...selectRequirement(readPaymentRequired(HEADER, BODY)),
        payTo: pubkeyToAddress(nobodysPayee, "kaspatest"),
        payToScriptPublicKey: serializedScriptPublicKey(payToPubkeyScript(nobodysPayee)),
      } as never,
    },
    (d) => schnorr.sign(d, AGENT),
  );

  const tx = JSON.parse(built.safeJson);
  assert.equal(
    tx.outputs[0].scriptPublicKey,
    serializedScriptPublicKey(payToPubkeyScript(nobodysPayee)),
    "a valid, signed, broadcastable payment to someone no allowlist mentions",
  );
  assert.equal(tx.outputs[0].value, "20000000");
});

// ---- wardaFetch dispatches on what the server speaks ----------------------

/**
 * `buy.ts` calls `wardaFetch`, not `wardaFetchV2`, and that used to be a
 * silent trap: a v2 server's 402 BODY parses as a valid v1 quote, because the
 * real document travels in a header and the body is a stub. So the v1 path
 * would read a v2 server as v1, build a v1 payment against a stub, and fail
 * somewhere that pointed anywhere but here.
 *
 * Dispatching on `dialect()` is not a convenience. A v2 server cannot be paid
 * by v1 rules and never could.
 */
test("wardaFetch reads their real 402 as v2 and pays it through the v2 flow", async () => {
  const relayRecipients2 = new RecipientSet([THEIR_PAYEE, fromHex(agentKey)]);
  const g: Grant = {
    ...grant,
    recipients: relayRecipients2,
    state: { ...grant.state, recipientsRoot: relayRecipients2.rootHex },
  };
  const { node: n } = relayNode();
  const payer = new WardaPayer({ grant: g, node: n, sign: AGENT });
  const events: string[] = [];
  let paidHeader: string | undefined;

  const res = await wardaFetch("https://demo.kaspa-x402.org/exact", undefined, {
    payer,
    relay: true,
    fetchImpl: (async (_u: string, init: RequestInit) =>
      (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"]
        ? new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
        : theirResponse()) as never,
    onEvent: (e) => {
      events.push(e.type);
      if (e.type === "quote") {
        /* The network, which the v2 quote event had to start carrying: a
           payment built for the wrong chain broadcasts, confirms, and is never
           seen by the vendor. buy.ts refuses on this before anything is
           signed. */
        assert.equal(e.requirement.network, "kaspa:testnet-10");
        assert.equal(e.requirement.amountSompi, 20_000_000n);
      }
      if (e.type === "paid") paidHeader = e.header;
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(events, ["quote", "paid", "done"], "reported in v1's vocabulary");
  /* The header is the whole reason the translation exists: it is the only
     artefact that can redeem a purchase that settled and was never delivered,
     and a mapping that dropped it would reintroduce the most expensive bug
     this package has had. */
  assert.ok(paidHeader, "the paid event carries the header");
  assert.ok(validatePaymentPayload(JSON.parse(Buffer.from(paidHeader!, "base64").toString("utf8"))).ok);
});

test("a v2 proof cannot be resumed across calls, and is told so by name", async () => {
  /* Detected from the PROOF, not from the server: the resume branch never
     fetches first, and it does not need to. A v2 payload announces its version
     and carries the requirement it paid; a v1 proof has neither. They also go
     back in different headers, so presenting one down the v1 path sends
     X-PAYMENT to a server watching for PAYMENT-SIGNATURE — which reads as no
     payment at all for money that is plainly on chain. */
  const { node: n } = relayNode();
  const payer = new WardaPayer({ grant, node: n, sign: AGENT });
  const v2Header = Buffer.from(
    JSON.stringify({ x402Version: 2, accepted: { scheme: "exact" }, payload: {} }),
  ).toString("base64");

  await assert.rejects(
    () =>
      wardaFetch("https://demo.kaspa-x402.org/exact", undefined, {
        payer,
        resume: { header: v2Header, txid: "ab".repeat(32), amountSompi: "1", payTo: "k" },
        fetchImpl: (async () => theirResponse()) as never,
      }),
    (e: Error) => {
      assert.match(e.message, /no cross-call resume for v2 yet/);
      assert.match(e.message, new RegExp("ab".repeat(32)));
      return true;
    },
  );
});

test("a v1 proof still resumes, and an unreadable one is left to the v1 path", async () => {
  const { node: n } = relayNode();
  const payer = new WardaPayer({ grant, node: n, sign: AGENT });
  const events: string[] = [];

  const res = await wardaFetch("https://vendor.example/thing", undefined, {
    payer,
    resume: { header: "not-base64-json", txid: "cd".repeat(32), amountSompi: "1", payTo: "k" },
    fetchImpl: (async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as never,
    onEvent: (e) => events.push(e.type),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(events, ["resuming", "done"], "unreadable is treated as v1, not guessed at");
});
