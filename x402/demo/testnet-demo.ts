/**
 * A Warda grant paying a real HTTP 402 endpoint on Kaspa testnet-10.
 *
 *   WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
 *     node --experimental-strip-types x402/demo/testnet-demo.ts \
 *     --grant covenant/deploy/grant-v4.json
 *
 * Nothing here is simulated. The vendor is a real HTTP server speaking the
 * x402 protocol; the payment is a real covenant spend broadcast to testnet-10;
 * and the vendor verifies it by looking the transaction up on chain before it
 * serves anything. The only thing that would be different against a third-party
 * vendor is whose process the server runs in.
 *
 * ## Why the vendor verifies for real
 *
 * A demo whose server returns 200 on sight of any header proves nothing — it
 * would pass just as happily against a fabricated txid. So this one polls the
 * chain for a UTXO at its own address whose transaction id matches the claim
 * and whose value is exactly the quoted amount, and answers 402 until it finds
 * one. That is the settling case the adapter is built to handle, exercised for
 * real rather than mocked: the client re-presents the same proof and never buys
 * a second call.
 *
 * ## The demo vendor's key is public, deliberately
 *
 * It is derived from blake2b256("warda-demo-api-v1"), the same way the genesis
 * tool derives the allowlist member it commits to. Anyone can compute it and
 * sweep what it receives. That is fine — this is testnet, the amounts are a
 * fraction of a KAS, and a demo whose vendor key is a secret would be one
 * nobody else could reproduce.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2.js";

import {
  NodeClient,
  RecipientSet,
  agentPublicKey,
  pubkeyToAddress,
  templateIdFor,
  resolveSigner,
  fromHex,
  toHex,
  EMPTY_RESERVE,
  type CovenantTemplate,
  type GrantState,
  type NetworkPrefix,
} from "@warda_protocol/kaspa";

import { WardaPayer, wardaFetch, X402Error } from "@warda_protocol/x402";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

const manifestPath = flag("grant", "covenant/deploy/grant.json")!;
const rpcUrl = flag("rpc", process.env.WARDA_RPC_JSON ?? "ws://127.0.0.1:18210")!;
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;
const receiptPath = flag("out", "x402/demo/receipt.json")!;
const PRICE = BigInt(flag("price", "20000000")!); // 0.2 KAS, the marketplace's floor
// Kaspa prices by mass and a covenant spend is ~6 KB on the wire, so it costs
// far more than a plain transfer. The node states the exact figure it wants if
// this is short, and the adapter relays that rather than the raw RPC error.
const FEE = BigInt(flag("fee", "2000000")!);

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK is required: it signs the agent's spend. Testnet key only.");
  process.exit(2);
}

// ---- the vendor -----------------------------------------------------------

const blake2b256 = (b: Uint8Array) => blake2b.create({ dkLen: 32 }).update(b).digest();
const vendorSecret = blake2b256(new TextEncoder().encode("warda-demo-api-v1"));
const vendorKey = agentPublicKey(vendorSecret);
const vendorAddress = pubkeyToAddress(vendorKey, prefix);

// ---- the grant ------------------------------------------------------------

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8"),
);
const authority = {
  principalKey: m.principal ?? m.agent,
  revocationKey: m.revocation ?? m.principal ?? m.agent,
};

// Rebuilt, never copied: the root has to be one a spend can prove against, and
// recomputing it is the only way to know the tree and the grant agree.
const recipients = new RecipientSet([
  vendorKey,
  new Uint8Array(32).fill(0xa2),
  new Uint8Array(32).fill(0xa3),
  new Uint8Array(32).fill(0xa4),
]);
if (recipients.rootHex !== m.recipients_root) {
  console.error(
    `this grant commits to recipients root ${m.recipients_root}, and the demo allowlist ` +
      `hashes to ${recipients.rootHex}. The vendor is not on this grant's list, so no ` +
      `payment to it can be proven. Mint the grant with tools/genesis.ts, which commits ` +
      `to this same set.`,
  );
  process.exit(1);
}

const state: GrantState = {
  agentKey: m.agent,
  budgetTotal: BigInt(m.budget),
  maxPerSpend: BigInt(m.max_per_spend),
  epochLimit: BigInt(m.epoch_limit),
  epochLength: BigInt(m.epoch_length),
  recipientsRoot: m.recipients_root,
  notBefore: BigInt(m.not_before),
  expiresAt: BigInt(m.expires_at),
  delegationDepth: BigInt(m.delegation_depth ?? 2),
  templateId: templateIdFor(template, authority),
  spentTotal: BigInt(m.spent_total),
  reserved: BigInt(m.reserved),
  epochIndex: BigInt(m.epoch_index),
  epochSpent: BigInt(m.epoch_spent),
  reserveRoot: m.reserve_root ?? EMPTY_RESERVE,
};

const client = await NodeClient.connect({ url: rpcUrl });
const info = await client.getInfo();
if (!info.isUtxoIndexed) {
  console.error("this node runs without --utxoindex; it cannot answer address queries.");
  process.exit(1);
}

/**
 * WARDA_SK is the FUNDER's key, not the agent's.
 *
 * The funder pays for genesis; the agent spends from the grant afterwards, and
 * `warda-deploy genesis` DERIVES the agent key from the funder's rather than
 * reusing it — which is the point of three separate roles. Signing a spend with
 * the funder's key produces a transaction the covenant refuses with nothing
 * more informative than "script ran, but verification failed".
 *
 * The manifest records how the derivation was done, so resolveSigner can follow
 * it. It returns null rather than guessing if it cannot.
 */
const resolved = resolveSigner(fromHex(secretHex), state.agentKey, m.agent_key_derived ?? null);
if (!resolved) {
  console.error(
    `WARDA_SK does not control this grant's agent key (${state.agentKey.slice(0, 16)}…), and the ` +
      `manifest records no derivation that reaches it. The agent key is usually derived from the ` +
      `funder's; without a recorded derivation there is nothing to follow, and guessing at keys is ` +
      `how a tool signs with the wrong one.`,
  );
  process.exit(1);
}
console.log(`signing key   : ${resolved.how}\n`);

const payer = new WardaPayer({
  grant: { template, authority, state, recipients },
  node: client,
  sign: resolved.secret,
  prefix,
  fee: FEE,
});

console.log(`node          : kaspad ${info.serverVersion}`);
console.log(`grant         : ${payer.address}`);
console.log(`vendor        : ${vendorAddress}`);
console.log(`price         : ${PRICE} sompi (fee ${FEE})`);
console.log(`headroom      : ${payer.headroom} sompi\n`);

// ---- an x402 server that actually checks the chain -------------------------

let issuedNonce: string | null = null;
const settleChecks: number[] = [];

const server = createServer((req, res) => {
  const send = (code: number, body: unknown) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  };

  const header = req.headers["x-payment"];
  if (!header) {
    issuedNonce = toHex(crypto.getRandomValues(new Uint8Array(8)));
    return send(402, {
      x402Version: 1,
      error: "payment required",
      accepts: [
        {
          scheme: "exact",
          network: "testnet-10",
          asset: "KAS",
          payTo: vendorAddress,
          amountSompi: PRICE.toString(),
          nonce: issuedNonce,
          maxTimeoutSeconds: 60,
        },
      ],
    });
  }

  // A proof was presented. Verify it against the chain rather than believing
  // it: find a UTXO at this vendor's own address created by the claimed
  // transaction, for exactly the quoted amount.
  const proof = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  if (proof.nonce !== issuedNonce) return send(400, { error: "nonce does not match the quote" });

  void (async () => {
    settleChecks.push(Date.now());
    try {
      const utxos = await client.getUtxosByAddresses([vendorAddress]);
      const paid = utxos.find(
        (u) => toHex(u.outpoint.transactionId) === proof.txid && u.entry.value === BigInt(proof.amountSompi),
      );
      if (!paid) {
        // Not on chain yet. This is the settling case, and answering 402 here
        // is what makes the client re-present the SAME proof instead of paying
        // again — the property the adapter exists to guarantee.
        return send(402, { error: "payment not yet visible on chain" });
      }
      send(200, {
        result: "GHOSTDAG orders blocks by how much work references them, so honest blocks " +
          "converge on one order without discarding competing ones.",
        settledBy: proof.txid,
        confirmations: "seen in the UTXO set",
      });
    } catch (e) {
      send(503, { error: String(e) });
    }
  })();
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const endpoint = `http://127.0.0.1:${port}/compute`;

// ---- 1. the refusal, which is the actual product --------------------------

console.log("── 1. a payee the grant never committed to ──────────────────");
const stranger = pubkeyToAddress(new Uint8Array(32).fill(0xcc), prefix);
const refusalServer = createServer((_req, res) => {
  const body = JSON.stringify({
    x402Version: 1,
    accepts: [{ scheme: "exact", network: "testnet-10", asset: "KAS", payTo: stranger, amountSompi: PRICE.toString(), nonce: "deadbeef" }],
  });
  res.writeHead(402, { "content-type": "application/json" });
  res.end(body);
});
await new Promise<void>((r) => refusalServer.listen(0, "127.0.0.1", r));
const refusalPort = (refusalServer.address() as { port: number }).port;

let refusal = "";
try {
  await wardaFetch(`http://127.0.0.1:${refusalPort}/compute`, { method: "POST" }, { payer });
  console.log("  UNEXPECTED: the payment was not refused\n");
} catch (e) {
  refusal = (e as Error).message;
  console.log(`  refused, nothing spent:\n  ${refusal.split("\n")[0]}\n`);
}
refusalServer.close();

// ---- 2. the real payment --------------------------------------------------

console.log("── 2. paying the vendor, on chain ──────────────────────────");
const before = { ...payer.state };
const addressBefore = payer.address;
const started = Date.now();

const events: string[] = [];
const res = await wardaFetch(endpoint, { method: "POST", body: JSON.stringify({ prompt: "explain GHOSTDAG" }) }, {
  payer,
  maxSettleAttempts: 12,
  onEvent: (e) => {
    if (e.type === "quote") events.push(`quote ${e.requirement.amountSompi} sompi to ${e.requirement.payTo.slice(0, 22)}…`);
    if (e.type === "paid") { events.push(`paid  ${e.result.txid}`); console.log(`  broadcast ${e.result.txid}`); }
    if (e.type === "settling") { events.push(`settling attempt ${e.attempt}`); console.log(`  settling, retrying in ${e.delayMs}ms (same proof)`); }
  },
});

const body = await res.json() as Record<string, unknown>;
const elapsed = Date.now() - started;
server.close();
client.close();

console.log(`\n  ${res.status} in ${(elapsed / 1000).toFixed(1)}s`);
console.log(`  vendor said: ${String(body.result).slice(0, 70)}…\n`);

const paymentTxid = events.find((e) => e.startsWith("paid"))!.split(/\s+/)[1]!;

console.log("── 3. what moved ───────────────────────────────────────────");
console.log(`  grant was at  : ${addressBefore}`);
console.log(`  grant is now  : ${payer.address}`);
console.log(`  spent total   : ${before.spentTotal} → ${payer.state.spentTotal}`);
console.log(`  epoch spent   : ${before.epochSpent} → ${payer.state.epochSpent}`);
console.log(`  headroom left : ${payer.headroom} sompi`);

const receipt = {
  _comment:
    "A real HTTP 402 round trip paid by a Warda covenant spend on Kaspa testnet-10. " +
    "The vendor verified the payment against the UTXO set before serving; the client " +
    "re-presented one proof across every settling retry and never paid twice.",
  network: "testnet-10",
  covenant: "b3e5eeefacf2021f",
  generatedAt: new Date().toISOString(),
  vendor: { address: vendorAddress, priceSompi: PRICE.toString() },
  payment: {
    txid: paymentTxid,
    amountSompi: PRICE.toString(),
    from: addressBefore,
    settleRetries: settleChecks.length - 1,
    elapsedMs: elapsed,
  },
  grant: {
    addressBefore,
    addressAfter: payer.address,
    spentTotalBefore: before.spentTotal.toString(),
    spentTotalAfter: payer.state.spentTotal.toString(),
    budgetTotal: payer.state.budgetTotal.toString(),
    maxPerSpend: payer.state.maxPerSpend.toString(),
    headroomAfter: payer.headroom.toString(),
  },
  refusal: { payTo: stranger, message: refusal },
  vendorResponse: body,
};
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
console.log(`\n  receipt written to ${receiptPath}`);
