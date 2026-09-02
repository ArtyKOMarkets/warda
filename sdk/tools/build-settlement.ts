/**
 * Settlement: a child grant collapsing back into its parent.
 *
 * The covenant has supported this since v4, and nothing built one. That gap is
 * why delegation was one-way in practice: a parent could subdivide itself and
 * then had no way to get the reserve back except by letting the child expire
 * into the PRINCIPAL's hands — which returns the money to the human, not to
 * the agent that was mid-task.
 *
 *   WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
 *     node --experimental-strip-types tools/build-settlement.ts \
 *     ../covenant/deploy/grant.json \
 *     ../covenant/deploy/grant-child-8fefa35b.json > js-settlement.json
 *
 * ## Two inputs, two keys, one transaction
 *
 * The parent runs `reabsorb` and the child runs `settle`, atomically. The
 * parent's input is signed by the parent's AGENT — it is the agent's budget
 * being restored — and the child's by the REVOCATION key, because collapsing a
 * grant is a revocation of it, and a sub-agent must not be able to end its own
 * grant on terms it chooses.
 *
 * Each input's digest commits to its own UTXO entry, so both must be signed
 * over their own; signing the child's digest with the parent's entry produces
 * a valid-looking transaction that fails at input 1.
 *
 * ## What is not derivable
 *
 * `prevRoot` — the reserve stack as it stood before this child was pushed. A
 * hash chain pops by preimage, so no amount of reading the chain recovers it.
 * `build-delegation` writes it onto the child manifest as
 * `parent_reserve_root_before`, and this reads it from there.
 *
 * Options:
 *   --fee <sompi>     default 2000000; a settlement is two covenant inputs and
 *                     therefore roughly twice the mass of a spend
 *   --rpc <url> --prefix <p> --template <path> --principal <hex> --revocation <hex>
 *   --prev-root <hex> override, when the child manifest predates the field
 *   --dry-run         print what it would do and stop before signing
 */

import { readFileSync } from "node:fs";

import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex } from "../src/bytes.ts";
import { pushChild } from "../src/delegate.ts";
import { EMPTY_RESERVE, resolveSigner } from "../src/keys.ts";
import { NodeClient } from "../src/node.ts";
import {
  attachReabsorbSignatures,
  buildUnsignedReabsorb,
  reabsorbSuccessorState,
  type ReabsorbPlan,
} from "../src/reabsorb.ts";
import { signDigest, verifyDigest } from "../src/sign.ts";
import {
  scriptHashFor,
  templateFingerprint,
  templateIdFor,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
} from "../src/template.ts";
import { toWireMulti } from "../src/wire.ts";

/** Two covenant inputs, so roughly twice a spend's mass. */
/**
 * A settlement has TWO covenant inputs — the parent reabsorbing and the child
 * settling — so it carries two redeem scripts and masses roughly twice a
 * spend. 2,000,000 was set before either half had ever been broadcast; this is
 * headroom rather than a measurement, and the rejection path below turns the
 * node's own figure into a --fee flag if it is still short.
 */
const DEFAULT_FEE = 5_000_000n;
const SETTLE_COMPUTE_BUDGET = 32;

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const [parentPath, childPath] = process.argv.slice(2).filter((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!parentPath || !childPath) {
  console.error(
    "usage: build-settlement.ts <parent.json> <child.json> [--fee n] [--dry-run]\n\n" +
      "The child manifest is the one build-delegation wrote. It carries the\n" +
      "parent's reserve root from before the child was pushed, which is the one\n" +
      "number settlement cannot derive.",
  );
  process.exit(2);
}

const pm = JSON.parse(readFileSync(parentPath, "utf8"));
const cm = JSON.parse(readFileSync(childPath, "utf8"));

function loadTemplate(): CovenantTemplate {
  const named = flag("template");
  const url = named
    ? new URL(named, `file://${process.cwd()}/`)
    : new URL("../covenant-template.json", import.meta.url);
  const tpl: CovenantTemplate = JSON.parse(readFileSync(url, "utf8"));
  const have = templateFingerprint(tpl);
  for (const [label, m] of [["parent", pm], ["child", cm]] as const) {
    if (m.covenant && m.covenant !== have) {
      console.error(
        `the ${label} manifest was issued under covenant ${m.covenant}, and the ` +
          `template loaded is ${have}. Pass --template.`,
      );
      process.exit(1);
    }
  }
  return tpl;
}
const template = loadTemplate();
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;

/**
 * A child INHERITS its parent's authority — that is what makes settlement
 * possible at all. `principalKey` and `revocationKey` are compiled into the
 * covenant's suffix rather than its state, so they are part of the TEMPLATE
 * ID: a parent can only ever reabsorb a child that shares its authority,
 * enforced by the covenant without anyone having to add the check.
 *
 * So if these disagree the settlement cannot work, and saying so here beats
 * a script failure inside 6912 bytes.
 */
const principalKey = flag("principal", pm.principal ?? pm.agent)!;
const authority: GrantAuthority = {
  principalKey,
  revocationKey: flag("revocation", pm.revocation ?? principalKey)!,
};
const childPrincipal = cm.principal ?? cm.agent;
const childRevocation = cm.revocation ?? childPrincipal;
if (childPrincipal !== authority.principalKey || childRevocation !== authority.revocationKey) {
  console.error(
    `these two grants do not share an authority, so no settlement between them exists.\n` +
      `  parent : principal ${authority.principalKey}, revocation ${authority.revocationKey}\n` +
      `  child  : principal ${childPrincipal}, revocation ${childRevocation}\n` +
      `Authority is compiled into the covenant, not carried in its state, so it is\n` +
      `part of the template id — a parent can only reabsorb its own children.`,
  );
  process.exit(1);
}

function stateFrom(m: Record<string, any>, fallbackDepth: number): GrantState {
  return {
    agentKey: m.agent,
    budgetTotal: BigInt(m.budget),
    maxPerSpend: BigInt(m.max_per_spend),
    epochLimit: BigInt(m.epoch_limit),
    epochLength: BigInt(m.epoch_length),
    recipientsRoot: m.recipients_root,
    notBefore: BigInt(m.not_before),
    expiresAt: BigInt(m.expires_at),
    delegationDepth: BigInt(m.delegation_depth ?? fallbackDepth),
    templateId: templateIdFor(template, authority),
    spentTotal: BigInt(m.spent_total),
    reserved: BigInt(m.reserved),
    epochIndex: BigInt(m.epoch_index),
    epochSpent: BigInt(m.epoch_spent),
    reserveRoot: m.reserve_root ?? EMPTY_RESERVE,
  };
}

const parentState = stateFrom(pm, 2);
/**
 * The child as it stands NOW, not as it was born. `reabsorb` charges the
 * parent `child.spentTotal`, so a stale child manifest under-reports what the
 * child spent, the parent's arithmetic comes out short, and the covenant
 * refuses — correctly, and for a reason that reads as a covenant bug.
 */
const childState = stateFrom(cm, 1);

const prevRoot = flag("prev-root", cm.parent_reserve_root_before)!;
if (!prevRoot) {
  console.error(
    `${childPath} does not record parent_reserve_root_before, and settlement\n` +
      `cannot proceed without it: the parent's reserve stack is a hash chain, and\n` +
      `popping one means supplying the preimage. It is not in the parent's state,\n` +
      `not in the child's, and not recoverable from any transaction.\n\n` +
      `If this child predates the field: the parent's stack was empty before it,\n` +
      `if it was the parent's first and only delegation. Pass --prev-root with\n` +
      `${EMPTY_RESERVE} to assert that; the check below will tell you if it is wrong.`,
  );
  process.exit(1);
}

// Assert the pop before attempting it. The covenant re-derives this itself, so
// this changes nothing about what the chain accepts — it changes what you are
// told when it will not accept it.
const rebuilt = pushChild(prevRoot, childState);
if (rebuilt !== parentState.reserveRoot) {
  console.error(
    `this child is not on top of the parent's reserve stack.\n` +
      `  the parent's root      : ${parentState.reserveRoot}\n` +
      `  pushing this child onto ${prevRoot.slice(0, 16)}… gives : ${rebuilt}\n\n` +
      `The stack is LIFO, so the most recently delegated child must be settled\n` +
      `first. Two things reach this line: settling out of order, or a child\n` +
      `manifest that has advanced since the delegation — the root commits to the\n` +
      `child's CURRENT state, and the covenant charges the parent what the child\n` +
      `has actually spent.`,
  );
  process.exit(1);
}

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK is required: the parent's agent signs the reabsorb half.");
  process.exit(2);
}
const secret = fromHex(secretHex.trim());

const agentFound = resolveSigner(secret, parentState.agentKey, pm.agent_key_derived ?? null);
if (!agentFound) {
  console.error(
    `WARDA_SK does not control the parent's agent key (${parentState.agentKey}).\n` +
      `Only the parent's agent may reabsorb: it is the agent's budget being restored.`,
  );
  process.exit(1);
}
const revocationSecretHex = process.env.WARDA_REVOCATION_SK ?? secretHex;
const revocationFound = resolveSigner(fromHex(revocationSecretHex.trim()), authority.revocationKey, null);
if (!revocationFound) {
  console.error(
    `nothing available controls the revocation key (${authority.revocationKey}), and\n` +
      `the child's half of a settlement is signed by it — collapsing a grant is a\n` +
      `revocation of it, so a sub-agent cannot end its own grant on its own terms.\n` +
      `Set WARDA_REVOCATION_SK when the roles are separated.`,
  );
  process.exit(1);
}

const parentAddress = scriptHashToAddress(scriptHashFor(template, { authority, state: parentState }), prefix);
const childAddress = scriptHashToAddress(scriptHashFor(template, { authority, state: childState }), prefix);

const client = await NodeClient.connect({ url: flag("rpc") });
let plan: ReabsorbPlan, built;
try {
  const [parentUtxos, childUtxos] = await Promise.all([
    client.getUtxosByAddresses([parentAddress]),
    client.getUtxosByAddresses([childAddress]),
  ]);
  for (const [label, addr, utxos, path] of [
    ["parent", parentAddress, parentUtxos, parentPath],
    ["child", childAddress, childUtxos, childPath],
  ] as const) {
    if (!utxos[0]) {
      console.error(
        `no UTXO at the ${label} address ${addr}.\n` +
          `A grant's address derives from its state, so ${path} may simply be stale —\n` +
          `run advance-manifest against the transaction that last moved it, or\n` +
          `recover-grant against any transaction that spent it.`,
      );
      process.exit(1);
    }
  }
  const p = parentUtxos[0]!, c = childUtxos[0]!;
  plan = {
    template,
    authority,
    parentState,
    childState,
    prevRoot,
    parentUtxo: {
      outpointTransactionId: p.outpoint.transactionId,
      outpointIndex: p.outpoint.index,
      value: p.entry.value,
      blockDaaScore: p.entry.blockDaaScore,
      isCoinbase: p.entry.isCoinbase,
      covenantId: p.entry.covenantId!,
    },
    childUtxo: {
      outpointTransactionId: c.outpoint.transactionId,
      outpointIndex: c.outpoint.index,
      value: c.entry.value,
      blockDaaScore: c.entry.blockDaaScore,
      isCoinbase: c.entry.isCoinbase,
      covenantId: c.entry.covenantId!,
    },
    fee: BigInt(flag("fee", DEFAULT_FEE.toString())!),
    computeBudget: SETTLE_COMPUTE_BUDGET,
  };
  built = buildUnsignedReabsorb(plan);
} finally {
  client.close();
}

const successor = reabsorbSuccessorState(parentState, childState, prevRoot);
const successorAddress = scriptHashToAddress(scriptHashFor(template, { authority, state: successor }), prefix);

console.error(`parent      : ${parentAddress}`);
console.error(`  reserved  : ${parentState.reserved}, spent ${parentState.spentTotal}`);
console.error(`child       : ${childAddress}`);
console.error(`  budget    : ${childState.budgetTotal}, of which it spent ${childState.spentTotal}`);
console.error(`settles to  : ${successorAddress}`);
console.error(`  reserved  : ${successor.reserved} (released ${childState.budgetTotal})`);
// The parent is charged what the child SPENT, not what it was lent. This is
// the whole point of settlement: the unspent remainder returns to the agent's
// budget rather than being written off.
console.error(`  spent     : ${parentState.spentTotal} -> ${successor.spentTotal} (the child's spending, charged home)`);
console.error(`  reserve   : ${successor.reserveRoot === EMPTY_RESERVE ? "empty again" : successor.reserveRoot}`);

if (process.argv.includes("--dry-run")) {
  console.error(`\n--dry-run: nothing signed, nothing built.`);
  process.exit(0);
}

const agentSignature = signDigest(built.parentSighash, agentFound.secret);
const revocationSignature = signDigest(built.childSighash, revocationFound.secret);

// Each digest commits to its OWN input's entry. A signature made over the
// other half verifies against nothing, and the transaction fails at input 1
// with a stack error that says nothing about which key was wrong.
if (!verifyDigest(agentSignature, built.parentSighash, fromHex(parentState.agentKey))) {
  throw new Error("the parent's signature does not verify against the parent input's digest");
}
if (!verifyDigest(revocationSignature, built.childSighash, fromHex(authority.revocationKey))) {
  throw new Error("the revocation signature does not verify against the child input's digest");
}

const tx = attachReabsorbSignatures(plan, built, agentSignature, revocationSignature);
process.stdout.write(
  JSON.stringify(toWireMulti(tx, built.entries, "@warda_protocol/kaspa (settlement)"), null, 2) + "\n",
);

/**
 * Broadcasting it.
 *
 * `genesis.ts` has had `--submit` from the start; the tools that DELEGATE and
 * SETTLE never got it, so the only way to put either on chain was to hand the
 * JSON to something else. That made delegation look one-way in a second sense:
 * the covenant supported it, the tool built it, and nothing shipped could send
 * it.
 *
 * Opt-in, and after the manifest is written — a submit that succeeds while the
 * write fails strands coin at an address nobody can reconstruct.
 */
if (process.argv.includes("--submit")) {
  const submitter = await NodeClient.connect({ url: flag("rpc") });
  try {
    const txid = await submitter.submitTransaction(tx);
    console.error(`\nSUBMITTED: ${txid}`);
    /**
     * Submitting is not accepting.
     *
     * Returning here leaves the caller racing the network: the next tool asks
     * for a UTXO that has been broadcast and not yet accepted, and gets "no
     * UTXO at <address>" — an error whose three listed causes are all wrong.
     * The showcase hit this twice, once after genesis and once here.
     */
    process.stderr.write("Waiting for the network to accept it");
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      if ((await submitter.getUtxosByAddresses([successorAddress])).length > 0) { seen = true; break; }
      process.stderr.write(".");
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.error(seen ? " accepted." : "\nsubmitted, but not visible yet — look again in a moment.");
    if (!seen) process.exit(1);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    const needs = /required amount of (\d+)/.exec(message);
    console.error(
      needs
        ? `\nNOT SUBMITTED: the fee is too low — offered ${plan.fee}, required ${needs[1]}.\n` +
          `A covenant spend carries the whole redeem script, so it masses far more than an\n` +
          `ordinary payment. Re-run with --fee ${needs[1]}.`
        : `\nNOT SUBMITTED: ${message}`,
    );
    process.exit(1);
  } finally {
    submitter.close();
  }
} else {
  console.error(`\n(not broadcast — add --submit, or verify the JSON first)`);
}
