/**
 * Send KAS from an ordinary key to an address, with change back to the key.
 *
 *   WARDA_SK=$(cat covenant/deploy/warda-testnet.key) \
 *     node --experimental-strip-types sdk/tools/send.ts <address> <kas> [--submit]
 *
 * The one ordinary payment this repository did not have: `consolidate` pays
 * the key itself, and a v0 `ordinaryPayment` has no change output, so paying a
 * runner deposit from a funder's single large coin would have burned the rest
 * as fee. This spends ONE coin (the largest that covers it) and returns the
 * remainder to the same key. Without --submit it only prints what it would do.
 *
 * Nothing bounds this. It is a plain key spending a plain coin; if you want
 * the money bounded, this is how it gets to the thing that bounds it.
 */
import { decodeAddress, pubkeyToAddress } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { ScriptBuilder } from "../src/script.ts";
import { agentPublicKey, signDigest, verifyDigest } from "../src/sign.ts";
import { payToPubkeyScript, sighash, SUBNETWORK_ID_NATIVE, type Transaction, type UtxoEntry } from "../src/tx.ts";
import { toWire } from "../src/wire.ts";
import { openChain } from "./chain.ts";
import { resolveNetwork, rpcFrom } from "./network.ts";

const FEE = 1_000_000n;
const flag = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const [to, amountText] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const secretHex = process.env.WARDA_SK?.trim();
if (!to || !amountText || !secretHex) {
  console.error("usage: WARDA_SK=… send.ts <address> <kas> [--submit]");
  process.exit(2);
}
if (!/^\d+(\.\d{1,8})?$/.test(amountText)) {
  console.error(`${amountText} is not a KAS amount`);
  process.exit(2);
}
const [w, f = ""] = amountText.split(".");
const amount = BigInt(w!) * 100_000_000n + BigInt(f.padEnd(8, "0"));
const payee = decodeAddress(to);
if (payee.version !== 0 || payee.payload.length !== 32) {
  console.error(`${to} is not a pay-to-public-key address`);
  process.exit(2);
}
const secret = fromHex(secretHex);
const me = agentPublicKey(secret);
const { prefix, network } = resolveNetwork({ prefix: flag("prefix"), network: flag("network"), secret: secretHex, action: "send" });
const from = pubkeyToAddress(me, prefix);

const { client } = await openChain({ url: rpcFrom(flag("rpc")), networkId: network });
try {
  const coin = (await client.getUtxosByAddresses([from]))
    .filter((u) => !u.entry.covenantId && u.entry.value >= amount + FEE)
    .sort((a, b) => (a.entry.value > b.entry.value ? 1 : -1))[0];
  if (!coin) {
    console.error(`no single coin at ${from} covers ${amountText} KAS plus the fee`);
    process.exit(1);
  }
  const change = coin.entry.value - amount - FEE;
  const tx: Transaction = {
    // v1 and a compute budget of 12: the exact shape genesis has broadcast
    // many times with an ordinary change output, so nothing here is new to a node.
    version: 1,
    inputs: [{ previousOutpoint: coin.outpoint, signatureScript: new Uint8Array(0), sequence: 0n, computeBudget: 12 }],
    outputs: [
      { value: amount, scriptPublicKey: payToPubkeyScript(payee.payload) },
      ...(change > 0n ? [{ value: change, scriptPublicKey: payToPubkeyScript(me) }] : []),
    ],
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };
  const entry: UtxoEntry = {
    value: coin.entry.value,
    scriptPublicKey: coin.entry.scriptPublicKey,
    blockDaaScore: coin.entry.blockDaaScore,
    isCoinbase: coin.entry.isCoinbase,
  };
  const digest = sighash(tx, 0, entry);
  const sig = signDigest(digest, secret);
  if (!verifyDigest(sig, digest, me)) throw new Error("the signature does not verify");
  tx.inputs[0]!.signatureScript = new ScriptBuilder().addData(sig).drain();
  const txid = toWire(tx, entry, "@warda_protocol/kaspa (send)").txid;
  console.error(`from    : ${from}`);
  console.error(`to      : ${to}`);
  console.error(`amount  : ${amountText} KAS`);
  console.error(`change  : ${Number(change) / 1e8} KAS back to ${from}`);
  console.error(`txid    : ${txid}`);
  if (process.argv.includes("--submit")) {
    const got = await client.submitTransaction(tx);
    console.error(`SUBMITTED: ${got}`);
  } else {
    console.error("(not broadcast — add --submit)");
  }
} finally {
  client.close();
}
