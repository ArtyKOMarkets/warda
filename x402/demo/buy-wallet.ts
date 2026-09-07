/**
 * The control experiment: the same x402 v2 client, paying from an ORDINARY
 * WALLET instead of a covenant.
 *
 *   WARDA_SK=$(cat funder.key) node --experimental-strip-types demo/buy-wallet.ts \
 *     https://demo.kaspa-x402.org/exact --rpc ws://127.0.0.1:18210
 *
 * ## Why this exists
 *
 * Seven attempts to two vendors were refused with `invalid_transaction_state`,
 * and every one of them paid from a covenant. So nothing so far distinguishes
 * "the vendor rejects covenant-shaped payments" from "our client builds a
 * payment wrong" — the two hypotheses predict identical observations, and we
 * kept varying fields inside the first one.
 *
 * This changes the payer and nothing else. Same `readPaymentRequired`, same
 * `selectRequirement`, same `buildPayment`, same authorization digest, same
 * header. The transaction is a plain P2PK spend: one input the funder's key
 * unlocks, the payee at output 0 and change back to the payer at output 1 —
 * which is exactly what a wallet produces and what `exact` was presumably
 * written against.
 *
 *   it succeeds  → the client is fine and the covenant shape is the difference,
 *                  which is worth saying to them with evidence rather than as
 *                  a guess.
 *   it fails too → the bug is ours, it has nothing to do with covenants, and
 *                  we can find it without anybody's help.
 *
 * Either answer is worth more than another covenant attempt.
 *
 * ## The ladder
 *
 * If the plain shape works, `--payment-index 1` and `--decoy` walk it towards
 * the covenant one a variable at a time: first the payee somewhere other than
 * output 0, then a non-change output owned by a script rather than a key. The
 * first of those to fail is the constraint.
 */
import { readFileSync } from "node:fs";

import {
  NodeClient,
  ScriptBuilder,
  agentPublicKey,
  fromHex,
  payToPubkeyScript,
  payToScriptHashScript,
  pubkeyToAddress,
  decodeAddress,
  sighash,
  signDigest,
  toHex,
  toSafeJson,
  transactionId,
  SUBNETWORK_ID_NATIVE,
  type Transaction,
  type TransactionOutput,
  type UtxoEntry,
} from "@warda_protocol/kaspa";
import {
  buildPayment,
  paymentSignatureHeader,
  readPaymentRequired,
  selectRequirement,
} from "../src/v2.ts";
import { amountOf } from "../src/pay-v2.ts";

const FEE = 2_000_000n;

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const url = process.argv[2];
if (!url || url.startsWith("--")) {
  console.error("usage: buy-wallet.ts <url> [--rpc url] [--payment-index 0|1] [--decoy]");
  process.exit(2);
}

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK must be the key that owns the funding coin.");
  process.exit(2);
}
const secret = fromHex(secretHex.trim());
const pub = agentPublicKey(secret);
const prefix = "kaspatest";
const payer = pubkeyToAddress(pub, prefix);

const paymentIndex = Number(flag("payment-index", "0"));
const decoy = process.argv.includes("--decoy");

console.error(`payer    : ${payer}`);
console.error(`shape    : payee at output ${paymentIndex}${decoy ? ", other output P2SH (not the payer)" : ""}`);

// ---- the quote -----------------------------------------------------------

const first = await fetch(url, { method: "GET" });
if (first.status !== 402) {
  console.error(`expected 402, got ${first.status}. Nothing to pay.`);
  process.exit(1);
}
const accepted = selectRequirement(
  readPaymentRequired(first.headers.get("payment-required"), await first.text()),
);
const amount = amountOf(accepted);
console.error(`quoted   : ${amount} sompi to ${accepted.payTo}`);

// ---- the coin ------------------------------------------------------------

const node = await NodeClient.connect({ url: flag("rpc") ?? process.env.WARDA_RPC_JSON });
const utxos = await node.getUtxosByAddresses([payer]);
const funding = utxos.sort((a, b) => (a.entry.value > b.entry.value ? -1 : 1))[0];
if (!funding || funding.entry.value < amount + FEE) {
  console.error(`no coin at ${payer} large enough for ${amount} plus ${FEE} fee.`);
  process.exit(1);
}

// ---- the transaction, wallet-shaped --------------------------------------

const payeeKey = accepted.payTo.includes(":")
  ? decodeAddress(accepted.payTo).payload
  : fromHex(accepted.payTo);

// The script we are about to build, against the one they advertised. A
// mismatch here is a decode error and belongs at this line, not at the vendor.
const built = "0000" + toHex(payToPubkeyScript(payeeKey).script);
const advertised = String(accepted.extra?.payToScriptPublicKey ?? "");
if (advertised && built.toLowerCase() !== advertised.toLowerCase()) {
  console.error(`the script for ${accepted.payTo} is ${built}, and they advertise ${advertised}`);
  process.exit(1);
}

const change = funding.entry.value - amount - FEE;
const payeeOutput: TransactionOutput = {
  value: amount,
  scriptPublicKey: payToPubkeyScript(payeeKey),
};
const otherOutput: TransactionOutput = {
  value: change,
  scriptPublicKey: decoy
    ? payToScriptHashScript(fromHex("11".repeat(32)))
    : payToPubkeyScript(pub),
};

const outputs = paymentIndex === 0 ? [payeeOutput, otherOutput] : [otherOutput, payeeOutput];

const entry: UtxoEntry = funding.entry;
const unsigned: Transaction = {
  version: 1,
  inputs: [
    {
      previousOutpoint: funding.outpoint,
      signatureScript: new Uint8Array(0),
      sequence: 0n,
      computeBudget: 12,
    },
  ],
  outputs,
  lockTime: 0n,
  subnetworkId: SUBNETWORK_ID_NATIVE,
  gas: 0n,
  payload: new Uint8Array(0),
};

const digest = sighash(unsigned, 0, entry);
const b = new ScriptBuilder();
b.addData(signDigest(digest, secret));
const tx: Transaction = {
  ...unsigned,
  inputs: [{ ...unsigned.inputs[0]!, signatureScript: b.drain() }],
};

const safe = toSafeJson(tx, [entry]);
console.error(`built    : ${safe.id}`);
if (toHex(transactionId(tx)) !== safe.id) throw new Error("id disagrees with itself");

// ---- broadcast and wait --------------------------------------------------

const txid = await node.submitTransaction(tx);
console.error(`onchain  : ${txid} — submitted`);

const payeeAddress = pubkeyToAddress(payeeKey, prefix);
let accepted_ = false;
for (let i = 0; i < 30 && !accepted_; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const at = await node.getUtxosByAddresses([payeeAddress]);
  accepted_ = at.some((u) => toHex(u.outpoint.transactionId) === txid);
}
console.error(`         : ${accepted_ ? "accepted" : "NOT SEEN — presenting anyway"}`);

// ---- present it ----------------------------------------------------------

const payment = await buildPayment(
  {
    accepted,
    request: { method: "GET", url },
    transaction: JSON.stringify(safe),
    transactionId: safe.id,
    paymentOutputIndex: paymentIndex,
    inputIndex: 0,
    payerAddress: payer,
  },
  (d: Uint8Array) => signDigest(d, secret),
);

const res = await fetch(url, {
  method: "GET",
  headers: { "PAYMENT-SIGNATURE": paymentSignatureHeader(payment) },
});
const body = await res.text();
console.error(`\nvendor   : ${res.status}`);
console.error(body.slice(0, 800));
node.close();
process.exitCode = res.ok ? 0 : 1;
