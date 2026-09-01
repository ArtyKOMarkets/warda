import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EMPTY_RESERVE,
  RecipientSet,
  agentPublicKey,
  pubkeyToAddress,
  scriptHashFor,
  scriptHashToAddress,
  templateIdFor,
  toHex,
  fromHex,
  type CovenantTemplate,
  type GrantState,
} from "@warda_protocol/kaspa";

import {
  WardaPayer,
  wardaFetch,
  parsePaymentRequired,
  encodeProof,
  decodeProof,
  settleDelayMs,
  payeeKey,
  explainRefusal,
  X402Error,
  PAYMENT_HEADER,
  type Grant,
} from "../src/index.ts";

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8"),
);

const AGENT = fromHex("11".repeat(32));
const agentKey = toHex(agentPublicKey(AGENT));
const authority = { principalKey: agentKey, revocationKey: agentKey };

const VENDOR = fromHex("a2".repeat(32));
const OTHER_VENDOR = fromHex("a3".repeat(32));
const STRANGER = fromHex("cc".repeat(32));
const recipients = new RecipientSet([VENDOR, OTHER_VENDOR]);

const vendorAddress = pubkeyToAddress(VENDOR, "kaspatest");
const strangerAddress = pubkeyToAddress(STRANGER, "kaspatest");

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

function requirement(over: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    error: "payment required",
    accepts: [
      {
        scheme: "exact",
        network: "testnet-10",
        asset: "KAS",
        payTo: vendorAddress,
        amountSompi: "20000000",
        nonce: "b1c2d3",
        maxTimeoutSeconds: 60,
        ...over,
      },
    ],
  };
}

// ---- the protocol, with no chain in sight --------------------------------

test("a 402 body parses into the one requirement this client can satisfy", () => {
  const r = parsePaymentRequired(requirement());
  assert.equal(r.payTo, vendorAddress);
  assert.equal(r.nonce, "b1c2d3");
  // Amounts are bigint, not number: an `exact` scheme rejects a payment that is
  // off by one sompi, so the value must not pass through a lossy type.
  assert.equal(typeof r.amountSompi, "bigint");
  assert.equal(r.amountSompi, 20_000_000n);
});

test("a server offering only schemes we do not implement is refused by name", () => {
  const body = requirement({ scheme: "upto" });
  assert.throws(() => parsePaymentRequired(body), /only the scheme\(s\) \[upto\]/);
});

test("a body with no accepts array says so, and relays the server's own error", () => {
  assert.throws(
    () => parsePaymentRequired({ error: "come back later" }),
    /carries no `accepts` array.*come back later/s,
  );
});

test("the proof round-trips through the header encoding", () => {
  const proof = {
    scheme: "exact", network: "testnet-10", payer: "kaspatest:qq",
    txid: "ab".repeat(32), amountSompi: "20000000", nonce: "b1c2d3",
  };
  assert.deepEqual(decodeProof(encodeProof(proof)), proof);
});

test("settle backoff climbs, caps at 8s, and is jittered", () => {
  // Lockstep retries from many clients arrive together; jitter is what stops
  // the settle window turning into a thundering herd.
  const noJitter = (v: number) => settleDelayMs(v, () => 0.5);
  assert.equal(noJitter(0), 1000);
  assert.equal(noJitter(1), 2000);
  assert.equal(noJitter(2), 4000);
  assert.equal(noJitter(3), 8000);
  assert.equal(noJitter(9), 8000, "capped");
  assert.notEqual(settleDelayMs(2, () => 0), settleDelayMs(2, () => 1));
});

// ---- where Warda's rules meet the invoice ---------------------------------

test("a P2SH payee is refused as unrepresentable, not merely rejected", () => {
  // The covenant builds the payee output as P2PK(recipient) and nothing else.
  // No budget and no different grant makes a script-hash payee payable, so the
  // message must not imply otherwise.
  const p2sh = scriptHashToAddress(fromHex("dd".repeat(32)), "kaspatest");
  assert.throws(() => payeeKey(p2sh), /pay-to-script-hash.*not something a larger budget/s);
});

test("a payee that is not on the allowlist has no transaction at all", () => {
  const req = parsePaymentRequired(requirement({ payTo: strangerAddress }));
  const why = explainRefusal(req, grant, { fee: 1_000_000n });
  assert.match(why!, /not on this grant's allowlist/);
  // The distinction the whole protocol rests on: this is not a payment the
  // network would decline, it is one that cannot be constructed.
  assert.match(why!, /not one the network would reject, none at all/);
});

test("the per-spend cap binds before the budget does", () => {
  // Both would refuse a large invoice; the covenant checks maxPerSpend first,
  // so the reported limit must be the one the chain would report.
  const req = parsePaymentRequired(requirement({ amountSompi: "5000000000" }));
  const why = explainRefusal(req, grant, { fee: 1_000_000n });
  assert.match(why!, /per-payment cap/);
});

test("a budget with nothing left refuses, naming what is committed", () => {
  const spent: Grant = {
    ...grant,
    state: { ...state, spentTotal: 995_00000000n, reserved: 5_00000000n },
  };
  const req = parsePaymentRequired(requirement());
  const why = explainRefusal(req, spent, { fee: 1_000_000n });
  assert.match(why!, /lifetime budget is uncommitted/);
  assert.match(why!, /reserved for delegated children/);
});

test("a coin too thin for the invoice plus the fee is caught before signing", () => {
  const req = parsePaymentRequired(requirement());
  const why = explainRefusal(req, grant, { fee: 1_000_000n, coin: 20_000_000n });
  assert.match(why!, /will not cover/);
  // The fee/budget divergence is a real property of a grant's life, and the
  // message explains it rather than just reporting a shortfall.
  assert.match(why!, /fees leave the coin without being charged/);
});

test("a payable invoice returns no refusal", () => {
  const req = parsePaymentRequired(requirement());
  assert.equal(explainRefusal(req, grant, { fee: 1_000_000n, coin: 500_00000000n }), null);
});

// ---- the fetch flow -------------------------------------------------------

/** A payer that records what it was asked to pay and never touches a network. */
function fakePayer(over: Partial<WardaPayer> = {}) {
  const paid: { amount: bigint; nonce: string }[] = [];
  const payer = {
    paid,
    refusalFor: () => null,
    pay: async (req: { amountSompi: bigint; nonce: string }) => {
      paid.push({ amount: req.amountSompi, nonce: req.nonce });
      return {
        txid: "cafe".repeat(16),
        payer: "kaspatest:qqpayer",
        amountSompi: req.amountSompi,
        state,
        address: "kaspatest:qqnext",
      };
    },
    ...over,
  };
  return payer as unknown as WardaPayer & { paid: typeof paid };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a non-402 response is returned untouched and nothing is paid", async () => {
  const payer = fakePayer();
  const res = await wardaFetch("https://vendor/compute", { method: "POST" }, {
    payer,
    fetchImpl: async () => jsonResponse(200, { ok: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(payer.paid.length, 0);
});

test("a 402 is paid once and the proof goes back in the X-PAYMENT header", async () => {
  const payer = fakePayer();
  const seen: (string | undefined)[] = [];
  let call = 0;
  const res = await wardaFetch("https://vendor/compute", { method: "POST" }, {
    payer,
    fetchImpl: async (_u, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push(h[PAYMENT_HEADER]);
      return ++call === 1 ? jsonResponse(402, requirement()) : jsonResponse(200, { result: "hi" });
    },
  });

  assert.equal(res.status, 200);
  assert.equal(payer.paid.length, 1, "exactly one payment");
  assert.equal(seen[0], undefined, "the first request carries no proof");

  const proof = decodeProof(seen[1]!);
  assert.equal(proof.nonce, "b1c2d3");
  assert.equal(proof.amountSompi, "20000000");
  assert.equal(proof.txid, "cafe".repeat(16));
});

test("a settling server is re-presented the SAME proof, and is never paid twice", async () => {
  // The one bug in this design capable of draining a budget through nobody's
  // fault is re-paying on an ambiguous 402. This is the test that pins it.
  const payer = fakePayer();
  const headers: string[] = [];
  let call = 0;
  const res = await wardaFetch("https://vendor/compute", { method: "POST" }, {
    payer,
    maxSettleAttempts: 4,
    fetchImpl: async (_u, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (h[PAYMENT_HEADER]) headers.push(h[PAYMENT_HEADER]);
      call++;
      if (call === 1) return jsonResponse(402, requirement());
      if (call < 4) return jsonResponse(402, { error: "settling" });
      return jsonResponse(200, { result: "ok" });
    },
    onEvent: () => {},
  });

  assert.equal(res.status, 200);
  assert.equal(payer.paid.length, 1, "paid exactly once across all the retries");
  assert.ok(headers.length >= 2, "the proof was re-presented");
  assert.equal(new Set(headers).size, 1, "and it was the identical proof each time");
});

test("a server that never settles reports the spend rather than paying again", async () => {
  const payer = fakePayer();
  await assert.rejects(
    wardaFetch("https://vendor/compute", { method: "POST" }, {
      payer,
      maxSettleAttempts: 2,
      fetchImpl: async (_u, init) => {
        const h = (init?.headers ?? {}) as Record<string, string>;
        return h[PAYMENT_HEADER] ? jsonResponse(402, { error: "settling" }) : jsonResponse(402, requirement());
      },
    }),
    (e: Error) => {
      assert.match(e.message, /The money is spent; this did NOT pay again/);
      return true;
    },
  );
  assert.equal(payer.paid.length, 1);
});

test("a refusal happens before any payment is attempted", async () => {
  const payer = fakePayer({ refusalFor: () => "not on this grant's allowlist" } as never);
  await assert.rejects(
    wardaFetch("https://vendor/compute", {}, {
      payer,
      fetchImpl: async () => jsonResponse(402, requirement({ payTo: strangerAddress })),
    }),
    /not on this grant's allowlist/,
  );
  assert.equal(payer.paid.length, 0, "nothing was paid");
});

test("a caller's own per-call ceiling refuses before the grant is consulted", async () => {
  const payer = fakePayer();
  await assert.rejects(
    wardaFetch("https://vendor/compute", {}, {
      payer,
      maxAmountSompi: 1_000_000n,
      fetchImpl: async () => jsonResponse(402, requirement()),
    }),
    /Nothing was paid/,
  );
  assert.equal(payer.paid.length, 0);
});

// ---- the payer's own bookkeeping -----------------------------------------

test("the payer derives the grant's address and reports its headroom", () => {
  const payer = new WardaPayer({
    grant,
    node: {} as never,
    sign: AGENT,
    prefix: "kaspatest",
  });
  const expected = scriptHashToAddress(scriptHashFor(template, { authority, state }), "kaspatest");
  assert.equal(payer.address, expected);
  // maxPerSpend is 20 KAS and the budget is 1000, so the per-spend cap binds.
  assert.equal(payer.headroom, 20_00000000n);
});

test("headroom follows whichever limit is smaller", () => {
  const nearlySpent: Grant = { ...grant, state: { ...state, spentTotal: 995_00000000n } };
  const payer = new WardaPayer({ grant: nearlySpent, node: {} as never, sign: AGENT });
  assert.equal(payer.headroom, 5_00000000n, "the budget now binds, not the per-spend cap");
});

test("a signer returning the wrong length is caught with the reason", async () => {
  // A signer that omits the sighash-type byte produces a transaction the engine
  // rejects without explaining, which is a miserable thing to debug on chain.
  const payer = new WardaPayer({
    grant,
    node: {
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
    } as never,
    sign: () => new Uint8Array(64),
  });
  const req = parsePaymentRequired(requirement());
  await assert.rejects(payer.pay(req), /returned 64 bytes.*sighash-type byte/s);
});
