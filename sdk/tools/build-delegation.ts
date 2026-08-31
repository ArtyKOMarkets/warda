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
 *   --window <daa>        the child's term, in DAA from now. Omit to inherit
 *                         the parent's. A short window is the only attenuation
 *                         that ends BY ITSELF, with nobody online to revoke.
 *   --not-before <daa> --expires-at <daa>   the same, stated absolutely
 *   --fee <sompi>         default 1000000
 *   --principal <hex> --revocation <hex> --parent-depth <n> --prefix <p> --rpc <url>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { attachDelegationSignature, buildUnsignedDelegation, type DelegationPlan } from "../src/delegate.ts";
import { HashWriter } from "../src/hashers.ts";
import { NodeClient } from "../src/node.ts";
import { agentPublicKey, signDigest, verifyDigest } from "../src/sign.ts";
import { scriptHashFor, templateFingerprint, type CovenantTemplate, type GrantState } from "../src/template.ts";
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
  // --window is relative to the chain's CURRENT position, which is the way
  // anyone actually thinks about a lease: "this sub-agent has an hour". The
  // absolute forms exist for reproducibility.
  const dagForWindow = flag("window") ? await client.getBlockDagInfo() : null;
  const childWindow: { notBefore?: bigint; expiresAt?: bigint } = {};
  if (dagForWindow) {
    childWindow.notBefore = state.notBefore;
    childWindow.expiresAt = dagForWindow.virtualDaaScore + BigInt(flag("window")!);
  }
  if (flag("not-before")) childWindow.notBefore = BigInt(flag("not-before")!);
  if (flag("expires-at")) childWindow.expiresAt = BigInt(flag("expires-at")!);

  const utxos = await client.getUtxosByAddresses([address]);
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
      ...childWindow,
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

// The derived child key is deterministic in (parent secret, index), so index
// 0 produces the SAME filename for every tree this key ever builds. Writing
// blind means a new delegation silently overwrites the record of an older
// child — including one that was reclaimed, whose manifest was the only note
// of where its coin went.
//
// A rebuild of the SAME child is fine and common: verify, adjust, rebuild.
// The test is therefore not "does the file exist" but "does it describe a
// different grant", and the child's address is what answers that.
const childAddressForCheck = scriptHashToAddress(
  scriptHashFor(template, { authority, state: built.childState }),
  prefix,
);
if (existsSync(childManifestPath)) {
  const prior = JSON.parse(readFileSync(childManifestPath, "utf8"));
  const priorAddress =
    prior.closed?.from_address ??
    scriptHashToAddress(
      scriptHashFor(template, {
        authority: {
          principalKey: prior.principal ?? prior.agent,
          revocationKey: prior.revocation ?? prior.principal ?? prior.agent,
        },
        state: {
          agentKey: prior.agent,
          budgetTotal: BigInt(prior.budget),
          maxPerSpend: BigInt(prior.max_per_spend),
          epochLimit: BigInt(prior.epoch_limit),
          epochLength: BigInt(prior.epoch_length),
          recipientsRoot: prior.recipients_root,
          notBefore: BigInt(prior.not_before),
          expiresAt: BigInt(prior.expires_at),
          delegationDepth: BigInt(prior.delegation_depth ?? 1),
          spentTotal: BigInt(prior.spent_total),
          reserved: BigInt(prior.reserved),
          epochIndex: BigInt(prior.epoch_index),
          epochSpent: BigInt(prior.epoch_spent),
        },
      }),
      prefix,
    );
  if (priorAddress !== childAddressForCheck) {
    console.error(
      `${childManifestPath} already describes a DIFFERENT child grant.\n` +
        `  on disk : ${priorAddress}${prior.closed ? ` (closed by ${prior.closed.kind})` : ""}\n` +
        `  new one : ${childAddressForCheck}\n` +
        `Overwriting would erase the only record of where that grant's coin went.\n` +
        `Move it aside, or use --index to derive a different sub-agent key.`,
    );
    process.exit(1);
  }
}
const c = built.childState;
writeFileSync(
  childManifestPath,
  JSON.stringify(
    {
      _comment:
        "A child grant, created by delegation. Shares its parent's principal and revocation keys: delegation subdivides an agent's budget, it does not hand over the right to revoke or reclaim.",
      covenant: m.covenant ?? templateFingerprint(template),
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
console.error(
  `  window    : ${built.childState.notBefore} to ${built.childState.expiresAt}` +
    `${built.childState.expiresAt === state.expiresAt ? " (inherited)" : " (narrowed)"}`,
);
// Conservation is the property that matters: the parent RESERVES exactly what
// the child receives, and real coins move with the reserve. Reserve without
// coins and the child can pay nobody; coins without reserve and the same KAS
// is spendable twice, from two addresses, both legitimately.
console.error(
  `conserved   : ${plan.utxo.value} = ${built.parentChange} + ${plan.child.budgetTotal} + ${plan.fee}`,
);
console.error(`wrote       : ${childManifestPath}`);

process.stdout.write(JSON.stringify(toWire(tx, built.entry, "@warda/kaspa (live delegation)"), null, 2) + "\n");
