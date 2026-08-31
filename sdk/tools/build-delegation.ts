/**
 * Builds a delegation against the LIVE grant: a grant subdividing itself.
 *
 * The reference delegation in `build-spend.ts --delegate` rebuilds a recorded
 * vector. This one reads the chain — the grant's current UTXO and the DAA
 * score — and produces a transaction that can actually be broadcast. It needs
 * no `warda-deploy plan` and no Rust toolchain, which is the whole point of
 * the node client existing.
 *
 *   WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
 *     node --experimental-strip-types tools/build-delegation.ts \
 *     ../covenant/deploy/grant.json > js-delegation.json
 *
 *   cd ../covenant/deploy && cargo run -q -- verify ../../sdk/js-delegation.json
 *
 * ## The child's key
 *
 * In production a sub-agent generates its own key and hands over the public
 * half; nobody derives it for them, and nobody else ever holds the secret.
 * For a demo that has to stay reproducible, this DERIVES the child key from
 * the parent's — blake2b-256 keyed with "WardaSubAgent" over the parent
 * secret and an index — so the child grant remains spendable later without
 * anyone writing a secret to disk or pasting one into a shell.
 *
 * That is a demo affordance, not the protocol. Pass --child-key to use a real
 * sub-agent's public key instead, which is what a deployment would do.
 *
 * Options:
 *   --child-key <hex>     x-only key of the sub-agent (default: derived)
 *   --index <n>           which derived child (default 0)
 *   --budget <sompi>      the child's total budget      (default 200000000)
 *   --max-per-spend <n>   may only ever shrink          (default 50000000)
 *   --epoch-limit <n>     may only ever shrink          (default 100000000)
 *   --depth <n>           strictly less than the parent (default: parent - 1)
 *   --fee <sompi>         default 1000000
 *   --principal <hex> --revocation <hex> --parent-depth <n> --prefix <p> --rpc <url>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { attachDelegationSignature, buildUnsignedDelegation, type DelegationPlan } from "../src/delegate.ts";
import { HashWriter } from "../src/hashers.ts";
import { NodeClient } from "../src/node.ts";
import { agentPublicKey, signDigest, verifyDigest } from "../src/sign.ts";
import { scriptHashFor, type CovenantTemplate, type GrantState } from "../src/template.ts";
import { toWire } from "../src/wire.ts";

const DEFAULT_FEE = 1_000_000n;
/** The delegate path does no Merkle work but does one signature check and
 *  builds two successor scripts; 16 matches what a spend provisions. */
const DELEGATE_COMPUTE_BUDGET = 16;

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const manifestPath = process.argv.find((a, i) => i >= 2 && !a.startsWith("--") && a.endsWith(".json"));
if (!manifestPath) {
  console.error("usage: build-delegation.ts <grant.json> [--budget n] [--child-key hex]");
  process.exit(2);
}

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK is required: only the parent agent can delegate.");
  process.exit(2);
}
const secret = fromHex(secretHex.trim());

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

const principalKey = flag("principal", m.agent)!;
const authority = { principalKey, revocationKey: flag("revocation", principalKey)! };
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;
const parentDepth = BigInt(flag("parent-depth", "2")!);

const state: GrantState = {
  agentKey: m.agent,
  budgetTotal: BigInt(m.budget),
  maxPerSpend: BigInt(m.max_per_spend),
  epochLimit: BigInt(m.epoch_limit),
  epochLength: BigInt(m.epoch_length),
  recipientsRoot: m.recipients_root,
  notBefore: BigInt(m.not_before),
  expiresAt: BigInt(m.expires_at),
  delegationDepth: parentDepth,
  spentTotal: BigInt(m.spent_total),
  reserved: BigInt(m.reserved),
  epochIndex: BigInt(m.epoch_index),
  epochSpent: BigInt(m.epoch_spent),
};

// The parent's own key must be the one signing, or the covenant's checkSig
// fails and the error says only that a script did not verify.
const parentPub = toHex(agentPublicKey(secret));
if (parentPub !== state.agentKey) {
  console.error(`WARDA_SK is ${parentPub}, but this grant's agent is ${state.agentKey}.`);
  process.exit(1);
}

/**
 * A reproducible sub-agent secret. Keyed blake2b rather than a plain hash so
 * the derivation is domain-separated: the same parent key used elsewhere
 * cannot collide into the same child.
 */
function deriveChildSecret(parentSecret: Uint8Array, index: number): Uint8Array {
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, index, true);
  return HashWriter.blake2b("WardaSubAgent").update(parentSecret).update(idx).digest();
}

const index = Number(flag("index", "0")!);
const derivedSecret = deriveChildSecret(secret, index);
const childKey = flag("child-key", toHex(agentPublicKey(derivedSecret)))!;
const derived = childKey === toHex(agentPublicKey(derivedSecret));

const address = scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);

const client = await NodeClient.connect({ url: flag("rpc") });
let plan: DelegationPlan, built;
try {
  const utxos = await client.getUtxosByAddresses([address]);
  const found = utxos[0];
  if (!found) {
    console.error(
      `no UTXO at ${address}.\n` +
        `The grant's address derives from its state, so a stale grant.json points ` +
        `at an address the grant has already moved away from.`,
    );
    process.exit(1);
  }

  plan = {
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
    child: {
      agentKey: childKey,
      budgetTotal: BigInt(flag("budget", "200000000")!),
      maxPerSpend: BigInt(flag("max-per-spend", "50000000")!),
      epochLimit: BigInt(flag("epoch-limit", "100000000")!),
      delegationDepth: BigInt(flag("depth", (parentDepth - 1n).toString())!),
    },
    fee: BigInt(flag("fee", DEFAULT_FEE.toString())!),
    computeBudget: DELEGATE_COMPUTE_BUDGET,
  };
  built = buildUnsignedDelegation(plan);
} finally {
  client.close();
}

const signature = signDigest(built.sighash, secret);
// Argument order: signature, then digest. The reverse of signDigest's.
if (!verifyDigest(signature, built.sighash, fromHex(state.agentKey))) {
  throw new Error("signature failed to verify against the digest it was made over");
}
const tx = attachDelegationSignature(plan, built, signature);

const childAddress = scriptHashToAddress(
  scriptHashFor(template, { authority, state: built.childState }),
  prefix,
);
const parentNextAddress = scriptHashToAddress(
  scriptHashFor(template, { authority, state: built.parentSuccessorState }),
  prefix,
);

/**
 * The child is a GRANT, and a grant's address derives from its state — so
 * losing the state strands the coin. Genesis writes a manifest before it
 * broadcasts for exactly this reason, and a delegation creates a grant just
 * as surely. Written BEFORE the transaction leaves this process: a broadcast
 * that succeeds while the write fails is the unrecoverable ordering.
 *
 * It carries `parent_txid`, which is what lets someone reconstruct the tree
 * later rather than finding two unrelated grants sharing a covenant id.
 */
const childManifestPath = join(
  dirname(manifestPath),
  `grant-child-${childKey.slice(0, 8)}.json`,
);
const c = built.childState;
writeFileSync(
  childManifestPath,
  JSON.stringify(
    {
      _comment:
        "A child grant, created by delegation. Shares its parent's principal and revocation keys: delegation subdivides an agent's budget, it does not hand over the right to revoke or reclaim.",
      covenant_id: m.covenant_id,
      agent: c.agentKey,
      // Explicit, because the child INHERITS these and they are not its own
      // agent key. Every manifest before this one could default principal to
      // `agent` and be right; a child cannot, and the address derives from
      // them — so a manifest without them points somewhere the grant is not.
      principal: authority.principalKey,
      revocation: authority.revocationKey,
      agent_key_derived: derived ? { from: "WARDA_SK", index } : null,
      parent_agent: state.agentKey,
      parent_txid: toWire(tx, built.entry).txid,
      recipients_root: c.recipientsRoot,
      not_before: Number(c.notBefore),
      expires_at: Number(c.expiresAt),
      budget: Number(c.budgetTotal),
      max_per_spend: Number(c.maxPerSpend),
      epoch_limit: Number(c.epochLimit),
      epoch_length: Number(c.epochLength),
      delegation_depth: Number(c.delegationDepth),
      grant_value: Number(plan.child.budgetTotal),
      spent_total: 0,
      reserved: 0,
      epoch_index: 0,
      epoch_spent: 0,
    },
    null,
    2,
  ) + "\n",
);

console.error(`parent      : ${address}`);
console.error(`  moves to  : ${parentNextAddress}`);
console.error(`  keeps     : ${built.parentChange} sompi, reserved now ${built.parentSuccessorState.reserved}`);
console.error(`child       : ${childAddress}`);
console.error(`  receives  : ${plan.child.budgetTotal} sompi, cap ${plan.child.maxPerSpend}, depth ${plan.child.delegationDepth}`);
console.error(`  agent key : ${childKey}${derived ? ` (derived, index ${index})` : " (supplied)"}`);
// Conservation is the property that matters: the parent RESERVES exactly what
// the child receives, and real coins move with the reserve. Reserve without
// coins and the child can pay nobody; coins without reserve and the same KAS
// is spendable twice, from two addresses, both legitimately.
console.error(
  `conserved   : ${plan.utxo.value} = ${built.parentChange} + ${plan.child.budgetTotal} + ${plan.fee}`,
);
console.error(`wrote       : ${childManifestPath}`);

process.stdout.write(JSON.stringify(toWire(tx, built.entry, "@warda/kaspa (live delegation)"), null, 2) + "\n");
