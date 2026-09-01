/**
 * Checks a demo receipt against the chain.
 *
 *   node --experimental-strip-types x402/demo/verify-receipt.ts
 *
 * The receipt is written by the process that made the payment, which is exactly
 * the party you would not take it from. This re-derives every claim in it from
 * the UTXO set, using nothing but the receipt's own numbers and a node:
 *
 *   - the vendor really was paid, by that transaction, for that exact amount
 *   - the grant really did move to the successor address the receipt names
 *   - the address it came from is empty, because a grant is a single coin and
 *     spending it moves the whole thing
 *   - the successor holds what the arithmetic says it should
 *
 * Anyone with a testnet-10 node can run this against the published receipt and
 * get the same answer, which is the only reason the numbers on the landing page
 * are worth anything.
 */

import { readFileSync } from "node:fs";
import { NodeClient, toHex, type NetworkPrefix } from "@warda_protocol/kaspa";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

const receipt = JSON.parse(readFileSync(flag("receipt", "x402/demo/receipt.json")!, "utf8"));
const client = await NodeClient.connect({ url: flag("rpc", process.env.WARDA_RPC_JSON ?? "ws://127.0.0.1:18210")! });

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? " ok " : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  console.log(`receipt from ${receipt.generatedAt}, covenant ${receipt.covenant}\n`);

  // 1. The vendor holds a coin from exactly this transaction, for exactly the
  //    quoted price. This is the claim the whole demo rests on.
  const vendorUtxos = await client.getUtxosByAddresses([receipt.vendor.address]);
  const paid = vendorUtxos.find(
    (u) =>
      toHex(u.outpoint.transactionId) === receipt.payment.txid &&
      u.entry.value === BigInt(receipt.payment.amountSompi),
  );
  check(
    !!paid,
    `the vendor was paid ${receipt.payment.amountSompi} sompi by ${receipt.payment.txid.slice(0, 16)}…`,
    paid ? `at ${receipt.vendor.address.slice(0, 30)}…` : "no such UTXO at the vendor's address",
  );

  // 2. The grant moved. Its address IS its state, so a spend necessarily
  //    relocates it — the old address must be empty and the new one funded.
  const before = await client.getUtxosByAddresses([receipt.grant.addressBefore]);
  check(before.length === 0, "the address the grant spent FROM is now empty",
    before.length ? `${before.length} UTXO(s) still there` : "a grant is one coin, and it moved");

  const after = await client.getUtxosByAddresses([receipt.grant.addressAfter]);
  check(after.length === 1, "the successor address holds exactly one coin",
    `${after.length} UTXO(s) at ${receipt.grant.addressAfter.slice(0, 30)}…`);

  // 3. The arithmetic. What the successor holds should be what went in, less
  //    what was paid out, less the fee — and the fee is the only part the
  //    receipt does not state, so it is derived and reported rather than
  //    assumed.
  if (after.length === 1 && paid) {
    const held = after[0]!.entry.value;
    const budget = BigInt(receipt.grant.budgetTotal);
    const price = BigInt(receipt.payment.amountSompi);
    const fee = budget - price - held;
    check(
      held + price + fee === budget && fee > 0n && fee < 10_000_000n,
      `the coin balances: ${budget} in, ${price} paid, ${fee} fee, ${held} left`,
      `fees leave the coin without being charged to the budget, which is why ` +
        `spentTotal (${receipt.grant.spentTotalAfter}) and the coin diverge`,
    );
  }

  // 4. The accounting the covenant enforces, restated from the receipt.
  const spent = BigInt(receipt.grant.spentTotalAfter) - BigInt(receipt.grant.spentTotalBefore);
  check(
    spent === BigInt(receipt.payment.amountSompi),
    `spentTotal advanced by exactly the amount paid (${spent})`,
  );
  check(
    BigInt(receipt.payment.amountSompi) <= BigInt(receipt.grant.maxPerSpend),
    `the payment was within the per-spend cap (${receipt.grant.maxPerSpend})`,
  );

  console.log(
    `\n${failures === 0 ? "the chain agrees with this receipt." : `${failures} claim(s) do NOT hold.`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  client.close();
}
