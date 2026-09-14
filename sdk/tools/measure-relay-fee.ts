/**
 * What does the network really charge for a relayed payment?
 *
 *   WARDA_SK=$(cat wallet.key) node --experimental-strip-types \
 *     tools/measure-relay-fee.ts --borsh
 *
 * ## Why this cannot be a corrector like every other fee in this repo
 *
 * `fee.ts` handles a wrong fee by offering too little, reading the figure out
 * of the node's rejection, and rebuilding at that number. Nothing is lost,
 * because the first transaction was never accepted.
 *
 * A relayed payment cannot do that. Its fee is whatever the FUNDING
 * transaction put in above the invoice, and by the time the node can price it
 * the funding transaction is already broadcast — the two go out back to back
 * on purpose, so there is no window in which the invoice is funded and unpaid.
 * There is no rebuild: a different fee means a different funding transaction,
 * which means a second covenant spend against the grant's budget.
 *
 * So the one fee in this protocol that has to be RIGHT IN ADVANCE is this one.
 * Hence a tool that measures it on its own, from an ordinary coin, with no
 * grant involved and nothing at stake — the same method `ops/exercise-fees.sh`
 * uses for the other four, run once instead of on every purchase.
 *
 * ## What it does
 *
 * Builds exactly the shape a relayed payment has — one version-0 P2PK input,
 * one P2PK output, no change — offers a deliberately low fee, and reads what
 * the node says it wanted. The transaction pays the wallet's own address, so a
 * run that is accepted rather than refused has moved a coin to where it
 * already was, minus the fee.
 */

import { pubkeyToAddress } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { agentPublicKey } from "../src/sign.ts";
import { signOrdinaryPayment, type OrdinaryPayment } from "../src/v0.ts";
import { storageMass } from "../src/mass.ts";
import { payToPubkeyScript } from "../src/tx.ts";
import { signDigest } from "../src/sign.ts";
import { isFeeRejection, requiredFeeFrom } from "./fee.ts";
import { borshRequested, openChain } from "./chain.ts";
import { assertKeyNotPublished, resolveNetwork } from "./network.ts";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const say = (s = "") => console.error(s);

const { prefix, network, isMainnet } = resolveNetwork({
  prefix: flag("prefix"),
  network: flag("network", "testnet-10"),
  action: "measure a fee",
});

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  say("WARDA_SK is not set. This needs an ordinary wallet key with a coin at its address.");
  say("  node --experimental-strip-types tools/new-key.ts > wallet.key");
  process.exit(2);
}
assertKeyNotPublished(secretHex, isMainnet);

const secret = fromHex(secretHex.trim());
const pub = agentPublicKey(secret);
const address = pubkeyToAddress(pub, prefix);

/* Deliberately too low. 1,000 sompi is below anything the network charges for
   a transaction of any shape, so a node that accepts it is telling us
   something more surprising than a node that refuses. */
const OFFER = BigInt(flag("fee", "1000")!);

const { client, transport } = await openChain({
  networkId: network,
  borsh: borshRequested(),
  tolerate: true,
});

try {
  say();
  say(`measuring the relayed-payment fee on ${network}, over ${transport}`);
  say(`  wallet   ${address}`);

  const coins = await client.getUtxosByAddresses([address]);
  if (coins.length === 0) {
    say(`\nnothing at ${address}. Fund it from a faucet and run this again.`);
    process.exit(1);
  }
  /* The smallest coin that can cover the offer, so a measurement costs as
     little as possible if it is accepted rather than refused. */
  const usable = coins
    .filter((c) => c.entry.value > OFFER + 1_000_000n)
    .sort((a, b) => (a.entry.value < b.entry.value ? -1 : 1));
  const coin = usable[0] ?? coins[0]!;
  say(`  coin     ${coin.entry.value} sompi`);

  const payment: OrdinaryPayment = {
    source: { outpoint: coin.outpoint, value: coin.entry.value, publicKey: pub },
    payee: pub,
    amount: coin.entry.value - OFFER,
  };
  const mass = storageMass(
    [{ value: coin.entry.value, scriptPublicKey: payToPubkeyScript(pub) }],
    [{ value: payment.amount, scriptPublicKey: payToPubkeyScript(pub) }],
  );
  const signed = signOrdinaryPayment(payment, (d) => signDigest(d, secret));

  say(`  shape    1 input -> 1 output, no change`);
  say(`  storage  ${mass} mass`);
  say(`  offering ${OFFER} sompi`);
  say(`  txid     ${toHex(signed.id)}`);
  say();

  try {
    const txid = await client.submitOrdinaryPayment(signed);
    say(`ACCEPTED at ${OFFER} sompi: ${txid}`);
    say();
    say(`The offer was enough, which means the true minimum is at or below it.`);
    say(`Lower --fee and run again to find the floor.`);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if (!isFeeRejection(message)) {
      say(`refused, and not about the fee:\n\n${message}`);
      process.exit(1);
    }
    const wanted = requiredFeeFrom(message)!;
    /* The repo's convention for a default: measured, then ~20% over, because
       mass varies with shape and a default pinned exactly to one measurement
       fires the corrector on every slightly larger transaction. There is no
       corrector here, which makes the margin matter more rather than less. */
    const suggested = (wanted * 120n) / 100n;
    say(`REFUSED, and the node named ${wanted} sompi.`);
    say();
    say(`  measured        ${wanted}`);
    say(`  +20% margin     ${suggested}`);
    say(`  storage mass    ${mass}`);
    /* Storage mass on this shape is usually ZERO — the output is barely
       smaller than the input, and KIP-9 prices the gap — so the fee is
       compute-driven and dividing by storage mass says Infinity. The useful
       figure is the compute mass the node implied, at the 100 sompi per unit
       this repository has now measured seven times without variation. */
    say(`  implied compute mass  ${wanted / 100n}  (at 100 sompi per unit)`);
    if (mass === 0n) {
      say(`  storage mass is 0 here: the output is barely smaller than the input, and`);
      say(`  KIP-9 prices the GAP between them. It only bites on small payments.`);
    }
    say();
    say(`Set RELAY_COMPUTE_MASS in x402/src/relay.ts to ${wanted / 100n} if this differs from`);
    say(`what is there. The fee itself is computed per payment — it depends on the amount —`);
    say(`so there is no constant to update. Nothing was spent: this was never accepted.`);
  }
} finally {
  client.close();
}
