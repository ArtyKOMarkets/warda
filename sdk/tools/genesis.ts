/**
 * Creates a grant from JavaScript, end to end, and optionally broadcasts it.
 *
 * This is the last thing that needed the Rust tool. `warda-deploy genesis`
 * held the grant's parameters as compile-time constants, so changing a budget
 * or a term meant editing Rust and rebuilding. Here they are flags, and the
 * only remaining use for the Rust tool is `verify` — a development check
 * against the real script engine, not something a deployment needs.
 *
 *   WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
 *     node --experimental-strip-types tools/genesis.ts \
 *     --budget 500000000 --window 25920000 --out ../covenant/deploy/grant.json
 *
 * Add --submit to broadcast. Without it the transaction is written to stdout
 * for `warda-deploy verify`, which is the safer order the first few times.
 *
 * ## The ordering that matters
 *
 * The manifest is written BEFORE the broadcast, always. A grant's address is
 * derived from its parameters, so a submit that succeeds while the write fails
 * strands the coin at an address nobody can reconstruct. Writing first can
 * only ever leave a manifest for a grant that does not exist, which is
 * recoverable by noticing.
 *
 * Options:
 *   --budget <sompi>        total the agent may pay out   (default 500000000)
 *   --max-per-spend <n>     per-transaction cap           (default 100000000)
 *   --epoch-limit <n>       per-epoch cap                 (default 250000000)
 *   --epoch-length <daa>    epoch size                    (default 1000)
 *   --window <daa>          term from now  (default 25920000, ~30d at 10bps)
 *   --depth <n>             how deep delegation may go    (default 2)
 *   --fee <sompi>           default 1000000
 *   --out <path>            manifest path  (default ./grant.json)
 *   --submit                broadcast it
 *   --prefix, --rpc
 */

import { readFileSync, writeFileSync } from "node:fs";

import { pubkeyToAddress, scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { attachGenesisSignature, buildGenesis } from "../src/genesis.ts";
import { blake2b256 } from "../src/hashers.ts";
import { NodeClient } from "../src/node.ts";
import { RecipientSet } from "../src/recipients.ts";
import { agentPublicKey, signDigest, verifyDigest } from "../src/sign.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";
import { toWire } from "../src/wire.ts";

/** Genesis is a plain P2PK spend that happens to pay into a covenant: one
 *  signature, no covenant logic, so 12 units covers it. */
const GENESIS_COMPUTE_BUDGET = 12;

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK is required: genesis is the one time the principal signs.");
  process.exit(2);
}
const secret = fromHex(secretHex.trim());
const key = toHex(agentPublicKey(secret));

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;
const outPath = flag("out", "grant.json")!;
const fee = BigInt(flag("fee", "1000000")!);
const budget = BigInt(flag("budget", "500000000")!);

// The demo allowlist, rebuilt rather than copied — the root has to match what
// a spend can later prove against, and recomputing it is the only way to know
// the two agree.
const demoApiKey = agentPublicKey(blake2b256(new TextEncoder().encode("warda-demo-api-v1")));
const recipients = new RecipientSet([
  demoApiKey,
  new Uint8Array(32).fill(0xa2),
  new Uint8Array(32).fill(0xa3),
  new Uint8Array(32).fill(0xa4),
]);

// This demo uses one key for all three roles. They are three DIFFERENT powers
// and a deployment should separate them: the agent spends, the revocation key
// stops, the principal receives. Collapsing them is what makes a testnet demo
// runnable from one file, and it is the first thing to unpick in production.
const authority = { principalKey: key, revocationKey: key };

const client = await NodeClient.connect({ url: flag("rpc") });
let built, state: GrantState, notBefore: bigint;
try {
  const info = await client.getInfo();
  if (!info.isSynced) console.error("warning: the node is not synced.\n");

  const walletAddress = pubkeyToAddress(agentPublicKey(secret), prefix);
  const [dag, utxos] = await Promise.all([
    client.getBlockDagInfo(),
    client.getUtxosByAddresses([walletAddress]),
  ]);

  // Largest single UTXO. Genesis takes ONE input, so the grant cannot exceed
  // the biggest coin the wallet holds — consolidate first if it must be
  // bigger, rather than discovering it as an arithmetic failure below.
  const funding = utxos.filter((u) => !u.entry.covenantId).sort((a, b) => (b.entry.value > a.entry.value ? 1 : -1))[0];
  if (!funding) {
    console.error(`no spendable UTXO at ${walletAddress}. Use the faucet.`);
    process.exit(1);
  }
  if (funding.entry.value < budget + fee) {
    console.error(
      `the largest coin at ${walletAddress} is ${funding.entry.value} sompi; ` +
        `a budget of ${budget} plus ${fee} fee needs ${budget + fee}.\n` +
        `Genesis takes ONE input, so consolidate or lower --budget.`,
    );
    process.exit(1);
  }

  notBefore = dag.virtualDaaScore;
  state = {
    agentKey: key,
    budgetTotal: budget,
    maxPerSpend: BigInt(flag("max-per-spend", "100000000")!),
    epochLimit: BigInt(flag("epoch-limit", "250000000")!),
    epochLength: BigInt(flag("epoch-length", "1000")!),
    recipientsRoot: toHex(recipients.root),
    notBefore,
    expiresAt: notBefore + BigInt(flag("window", "25920000")!),
    delegationDepth: BigInt(flag("depth", "2")!),
    // A grant starts new. The covenant requires all four to be zero at
    // genesis, and a nonzero one here is a grant born already spent.
    spentTotal: 0n,
    reserved: 0n,
    epochIndex: 0n,
    epochSpent: 0n,
  };

  built = buildGenesis({
    template,
    grant: { authority, state },
    funding: {
      outpointTransactionId: funding.outpoint.transactionId,
      outpointIndex: funding.outpoint.index,
      value: funding.entry.value,
      scriptPublicKey: funding.entry.scriptPublicKey,
      blockDaaScore: funding.entry.blockDaaScore,
      isCoinbase: funding.entry.isCoinbase,
    },
    grantValue: budget,
    fee,
    computeBudget: GENESIS_COMPUTE_BUDGET,
  });

  const signature = signDigest(built.sighash, secret);
  if (!verifyDigest(signature, built.sighash, agentPublicKey(secret))) {
    throw new Error("signature failed to verify against the digest it was made over");
  }
  const tx = attachGenesisSignature(built, signature);
  const wire = toWire(tx, built.entry, "@warda/kaspa (genesis)");
  const grantAddress = scriptHashToAddress(toHex(built.grantScriptHash), prefix);

  // WRITTEN BEFORE BROADCAST. A grant's address is derived from these numbers;
  // losing them strands the coin at an address nobody can reconstruct.
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        covenant_id: toHex(built.covenantId),
        agent: key,
        principal: authority.principalKey,
        revocation: authority.revocationKey,
        recipients_root: state.recipientsRoot,
        not_before: Number(state.notBefore),
        expires_at: Number(state.expiresAt),
        budget: Number(state.budgetTotal),
        max_per_spend: Number(state.maxPerSpend),
        epoch_limit: Number(state.epochLimit),
        epoch_length: Number(state.epochLength),
        delegation_depth: Number(state.delegationDepth),
        grant_value: Number(budget),
        spent_total: 0,
        reserved: 0,
        epoch_index: 0,
        epoch_spent: 0,
      },
      null,
      2,
    ) + "\n",
  );

  console.error(`grant address : ${grantAddress}`);
  console.error(`  funded by   : ${walletAddress}`);
  console.error(`  budget      : ${budget} sompi, cap ${state.maxPerSpend}, epoch ${state.epochLimit}`);
  console.error(
    `  window      : ${state.notBefore} to ${state.expiresAt} ` +
      `(~${(state.expiresAt - state.notBefore) / 864_000n} days at 10 blocks/second)`,
  );
  console.error(`  depth       : ${state.delegationDepth}`);
  console.error(`  covenant id : ${toHex(built.covenantId)}`);
  console.error(`  change      : ${built.changeValue} sompi back to the wallet`);
  console.error(`  wrote       : ${outPath}`);

  if (has("submit")) {
    // The SDK's own submitTransaction, rather than handing the bytes to the
    // Rust tool. Everything else about this transaction was already built
    // here; this is the last step that was not.
    const txid = await client.submitTransaction(tx);
    console.error(`\nSUBMITTED: ${txid}`);
    if (txid !== wire.txid) {
      console.error(
        `  NOTE: the node calls it ${txid}, this package predicted ${wire.txid}. ` +
          `They disagree about serialization.`,
      );
    }
  } else {
    console.error(`\n(not broadcast — add --submit, or verify the JSON first)`);
  }

  process.stdout.write(JSON.stringify(wire, null, 2) + "\n");
} finally {
  client.close();
}
