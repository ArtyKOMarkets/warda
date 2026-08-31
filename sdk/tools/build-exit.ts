/**
 * Builds a reclaim or a revoke: the principal taking the coin back.
 *
 * These are the two paths with no on-chain evidence behind them, and they are
 * the ones the whole trust story rests on. "The principal signs once and is
 * never online again" is only a reasonable thing to ask of somebody if the
 * money is definitely retrievable afterwards. Until an exit has moved coin,
 * that is a claim.
 *
 *   node --experimental-strip-types tools/build-exit.ts --reclaim \
 *     ../covenant/deploy/grant.json > js-reclaim.json
 *
 * Then hand it to the consensus engine, which is the point:
 *
 *   cd ../covenant/deploy && cargo run -- verify ../../sdk/js-reclaim.json
 *
 * It reads the grant's live UTXO and the current DAA score from a node, so
 * the lock time it picks is one the chain will actually accept. Signing needs
 * WARDA_SK; without it the transaction is written unsigned, which is still
 * enough for the engine to reject or accept the SHAPE.
 *
 * Options:
 *   --reclaim | --revoke   which exit. Reclaim needs the chain past
 *                          expiresAt; revoke works at any time.
 *   --fee <sompi>          default 1000000
 *   --principal <hex>      default: the manifest's `principal`, else its agent
 *   --revocation <hex>     default: the manifest's `revocation`, else principal
 *   --depth <n>            default: the manifest's delegation_depth, else 2
 *   --prefix <name>        default kaspatest
 *   --rpc <url>            default $WARDA_RPC_JSON, else ws://127.0.0.1:18210
 */

import { readFileSync } from "node:fs";

import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { attachExitSignature, buildUnsignedExit, type ExitPlan } from "../src/exit.ts";
import { NodeClient } from "../src/node.ts";
import { agentPublicKey, signDigest, verifyDigest } from "../src/sign.ts";
import { scriptHashFor, templateFingerprint, type CovenantTemplate, type GrantState } from "../src/template.ts";
import { toWire } from "../src/wire.ts";

/** How far behind the tip to set the lock time. A lock time at or above the
 *  current DAA score is not yet final, so the transaction would be rejected
 *  as non-final rather than for anything to do with the covenant. */
const DAA_BACKOFF = 100n;
const DEFAULT_FEE = 1_000_000n;
/** One signature verification is 100,000 script units; 12 covers this path,
 *  which does no Merkle work. Under-provisioning is rejected outright. */
const EXIT_COMPUTE_BUDGET = 12;

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const kind = has("revoke") ? "revoke" : "reclaim";
const manifestPath = process.argv.find((a, i) => i >= 2 && !a.startsWith("--") && a.endsWith(".json"));
if (!manifestPath) {
  console.error("usage: build-exit.ts <grant.json> [--reclaim|--revoke] [--fee n]");
  process.exit(2);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
/**
 * Which covenant a grant was issued under.
 *
 * A covenant upgrade changes the bytecode, so the SAME state derives a
 * DIFFERENT address. Grants issued under the old one are still on chain, still
 * spendable, and completely invisible to a tool holding only the new template.
 * An upgrade that stranded every outstanding grant would not be an upgrade.
 *
 * So: --template points at the template a grant was issued under, and a
 * manifest may name its own. New grants record it; older manifests predate the
 * field and fall back to the current template, which is what they were issued
 * under anyway.
 */
function loadTemplate(m: { covenant?: string } = {}): CovenantTemplate {
  const named = flag("template");
  const url = named
    ? new URL(named, `file://${process.cwd()}/`)
    : new URL("../covenant-template.json", import.meta.url);
  const tpl: CovenantTemplate = JSON.parse(readFileSync(url, "utf8"));
  const have = templateFingerprint(tpl);
  if (m.covenant && m.covenant !== have) {
    console.error(
      `this manifest was issued under covenant ${m.covenant}, and the template ` +
        `loaded is ${have}.\n` +
        `Deriving an address from the wrong covenant does not fail loudly: it ` +
        `produces a plausible address, finds nothing there, and reports the grant ` +
        `missing. Pass --template <path to that covenant's template>.`,
    );
    process.exit(1);
  }
  return tpl;
}

const template: CovenantTemplate = loadTemplate(m);

// A child grant records its authority explicitly; the genesis manifest
// predates the fields, where principal == revocation == agent held.
const principalKey = flag("principal", m.principal ?? m.agent)!;
const revocationKey = flag("revocation", m.revocation ?? principalKey)!;
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;
const fee = BigInt(flag("fee", DEFAULT_FEE.toString())!);

const state: GrantState = {
  agentKey: m.agent,
  budgetTotal: BigInt(m.budget),
  maxPerSpend: BigInt(m.max_per_spend),
  epochLimit: BigInt(m.epoch_limit),
  epochLength: BigInt(m.epoch_length),
  recipientsRoot: m.recipients_root,
  notBefore: BigInt(m.not_before),
  expiresAt: BigInt(m.expires_at),
  delegationDepth: BigInt(flag("depth", (m.delegation_depth ?? 2).toString())!),
  spentTotal: BigInt(m.spent_total),
  reserved: BigInt(m.reserved),
  epochIndex: BigInt(m.epoch_index),
  epochSpent: BigInt(m.epoch_spent),
};
const authority = { principalKey, revocationKey };
const address = scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);

const client = await NodeClient.connect({ url: flag("rpc") });
let unsigned, plan: ExitPlan, lockTime: bigint;
try {
  const [dag, utxos] = await Promise.all([
    client.getBlockDagInfo(),
    client.getUtxosByAddresses([address]),
  ]);
  const found = utxos[0];
  if (!found) {
    console.error(
      `no UTXO at ${address}.\n` +
        `Three things produce this, in the order worth checking:\n` +
        `  - the genesis was built but never submitted, so the grant does not exist yet\n` +
        `  - the manifest is stale: a grant's address derives from its state, so\n` +
        `    spending or delegating MOVES it, and the old address goes empty\n` +
        `  - the authority is wrong: principal, revocation and depth are all part\n` +
        `    of the address, so a wrong guess derives a different one`,
    );
    process.exit(1);
  }

  // Reclaim has to satisfy two bounds at once: the covenant's CLTV wants
  // lockTime >= expiresAt, and consensus wants lockTime < the current DAA
  // score. Both hold only once the chain has passed expiry — which is exactly
  // what the reclaim right means. Saying WHY it is impossible beats a script
  // error from the engine.
  lockTime = kind === "reclaim" ? dag.virtualDaaScore - DAA_BACKOFF : 0n;
  if (kind === "reclaim" && lockTime < state.expiresAt) {
    console.error(
      `cannot reclaim yet. The chain is at DAA ${dag.virtualDaaScore} and the grant ` +
        `expires at ${state.expiresAt}: ${state.expiresAt - dag.virtualDaaScore} to go ` +
        `(~${(state.expiresAt - dag.virtualDaaScore) / 10n}s at 10 blocks/second).\n` +
        `Revoke works now if this is urgent — it has no expiry condition.`,
    );
    process.exit(1);
  }

  plan = {
    kind,
    template,
    authority,
    state,
    utxo: {
      outpointTransactionId: found.outpoint.transactionId,
      outpointIndex: found.outpoint.index,
      value: found.entry.value,
      blockDaaScore: found.entry.blockDaaScore,
      isCoinbase: found.entry.isCoinbase,
      covenantId: found.entry.covenantId!,
    },
    fee,
    computeBudget: EXIT_COMPUTE_BUDGET,
    lockTime,
  };
  unsigned = buildUnsignedExit(plan);
} finally {
  client.close();
}

const secretHex = process.env.WARDA_SK;
let tx = unsigned.tx;
let signed = false;
if (secretHex) {
  const secret = fromHex(secretHex);
  const expected = authority[unsigned.signingKey];
  const actual = toHex(agentPublicKey(secret));
  if (actual !== expected) {
    // The covenant checks a specific key. Finding out here beats finding out
    // from a script failure that says only that a signature did not verify.
    console.error(
      `WARDA_SK is the wrong key for a ${kind}: it is ${actual}, and the covenant ` +
        `checks ${unsigned.signingKey} = ${expected}.`,
    );
    process.exit(1);
  }
  const signature = signDigest(unsigned.sighash, secret);
  // Note the order: signature first, then the digest. It is the reverse of
  // signDigest's, which is a trap I walked into writing this.
  if (!verifyDigest(signature, unsigned.sighash, fromHex(expected))) {
    throw new Error("signature failed to verify against the digest it was made over");
  }
  tx = attachExitSignature(plan, unsigned, signature);
  signed = true;
}

console.error(`${kind}: ${address}`);
console.error(`  value out : ${unsigned.tx.outputs[0]!.value} sompi (fee ${fee})`);
console.error(`  to        : P2PK ${toHex(unsigned.destination)}`);
console.error(`  lock time : ${lockTime}${kind === "reclaim" ? ` (expiresAt ${state.expiresAt})` : ""}`);
console.error(`  signed    : ${signed ? "yes" : "NO — set WARDA_SK to sign"}`);

process.stdout.write(JSON.stringify(toWire(tx, unsigned.entry), null, 2) + "\n");
