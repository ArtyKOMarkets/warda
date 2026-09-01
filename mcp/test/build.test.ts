/**
 * Does the MCP bridge corrupt anything on the way through?
 *
 * An agent hands this server KAS strings and a list of named recipients. The
 * covenant reads sompi, little-endian state slices and a Merkle proof. Between
 * those two vocabularies sit a decimal parser, a tree built by different code
 * than the SDK's, and a struct laid out by field order.
 *
 * None of that is a rule, so none of it can wrongly permit a spend. All of it
 * can produce bytes the chain refuses — silently, and only when a real payment
 * is attempted. So the test is the sharpest one available: feed the bridge the
 * same grant the golden vector describes, and require the transaction it
 * builds to be byte-identical to the one testnet-10 accepted.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildSpend, loadTemplate } from "../src/build.ts";
import { materialise, type GrantDescriptor } from "../src/grant.ts";
import { formatKas } from "../../src/amounts.ts";

const golden = JSON.parse(
  readFileSync(new URL("../../sdk/golden-spend.json", import.meta.url), "utf8"),
);

/** The golden grant, described the way an agent framework would describe it. */
function descriptor(): GrantDescriptor {
  const p = golden.params;
  return {
    agentKey: p.agentKey,
    principalKey: p.principalKey,
    revocationKey: p.revocationKey,
    budgetKas: formatKas(BigInt(p.budgetTotal)),
    maxPerSpendKas: formatKas(BigInt(p.maxPerSpend)),
    epochLimitKas: formatKas(BigInt(p.epochLimit)),
    epochLength: String(p.epochLength),
    recipients: golden.recipients.members,
    notBefore: String(p.notBefore),
    expiresAt: String(p.expiresAt),
    delegationDepth: p.delegationDepth,
    nonce: "00".repeat(32),
    state: {
      spentTotalKas: formatKas(BigInt(p.prevState.spentTotal)),
      reservedKas: formatKas(BigInt(p.prevState.reserved)),
      epochIndex: String(p.prevState.epochIndex),
      epochSpentKas: formatKas(BigInt(p.prevState.epochSpent)),
    },
  };
}

const BACKOFF = 100n;
// The tool subtracts a backoff from the tip, so hand it a tip that lands on
// the vector's claimed DAA. Anything else changes the lock time, which changes
// the digest, which changes everything downstream.
const TIP = BigInt(golden.spend.claimedDaa) + BACKOFF;

function build() {
  const m = materialise(descriptor());
  return buildSpend(m, m.set, {
    amount: BigInt(golden.spend.amount),
    recipient: golden.recipients.target,
    daaScore: TIP,
    utxo: {
      transactionId: golden.utxo.outpointTransactionId,
      index: golden.utxo.outpointIndex,
      valueSompi: String(golden.utxo.value),
      blockDaaScore: String(golden.utxo.blockDaaScore),
      isCoinbase: golden.utxo.isCoinbase,
      covenantId: golden.utxo.covenantId,
    },
    feeSompi: BigInt(golden.spend.fee),
    computeBudget: golden.spend.computeBudget,
    daaBackoff: BACKOFF,
  });
}

test("the tree built from named recipients has the root the covenant expects", () => {
  // Two independent Merkle implementations meet here: @warda_protocol/core builds the
  // set, and the compiled covenant carries the root. A mismatch means every
  // proof this server produces is for a different tree.
  const m = materialise(descriptor());
  assert.equal(m.grant.recipientsRoot, golden.params.recipientsRoot);
});

test("KAS strings survive the round trip into sompi", () => {
  // The descriptor speaks decimal KAS. A rounding error here would be
  // invisible in the JSON and fatal in the state slice.
  const m = materialise(descriptor());
  assert.equal(m.grant.budgetTotal, BigInt(golden.params.budgetTotal));
  assert.equal(m.grant.maxPerSpend, BigInt(golden.params.maxPerSpend));
  assert.equal(m.grant.epochLimit, BigInt(golden.params.epochLimit));
});

test("the built transaction is the one the network accepted", () => {
  const built = build();
  assert.equal(
    built.transaction.inputs[0]!.signatureScriptHex,
    golden.unsignedSignatureScriptHex,
    "the MCP bridge produced different bytes than the reference",
  );
  assert.equal(built.sighashHex, golden.sighashHex);
  assert.equal(built.transaction.txid, golden.transaction.txid);
});

test("the successor address is reported, and is not the current one", () => {
  const built = build();
  const current = golden.grant.scriptPublicKeyHex as string;
  // The spk wraps the script hash: OP_BLAKE2B, push-32, hash, OP_EQUAL.
  assert.equal(built.successorScriptHash, (golden.successor.scriptPublicKeyHex as string).slice(4, -2));
  assert.notEqual(built.successorScriptHash, current.slice(4, -2));
});

test("an unlisted payee is refused rather than given a borrowed proof", () => {
  // Fabricating a proof would make the covenant's rejection look like a bug in
  // the tree instead of a payee that is not on the list.
  const m = materialise(descriptor());
  assert.throws(
    () =>
      buildSpend(m, m.set, {
        amount: BigInt(golden.spend.amount),
        recipient: "ee".repeat(32),
        daaScore: TIP,
        utxo: {
          transactionId: golden.utxo.outpointTransactionId,
          index: golden.utxo.outpointIndex,
          valueSompi: String(golden.utxo.value),
          blockDaaScore: String(golden.utxo.blockDaaScore),
          isCoinbase: golden.utxo.isCoinbase,
          covenantId: golden.utxo.covenantId,
        },
        feeSompi: BigInt(golden.spend.fee),
        computeBudget: golden.spend.computeBudget,
        daaBackoff: BACKOFF,
      }),
    /not on this grant's allowlist/,
  );
});

test("the template is loaded from disk, not taken from the caller", () => {
  // A caller-supplied template is the softest attack surface in the protocol:
  // swap it and every address is wrong, so the grant pays into a script nobody
  // can spend. There must be no parameter for it.
  const tpl = loadTemplate();
  assert.equal(typeof tpl.baselineHex, "string");
  assert.ok(tpl.fields.some((f) => f.name === "principalKey"));
});
