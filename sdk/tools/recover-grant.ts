/**
 * Find a grant again when its manifest is stale, wrong, or gone.
 *
 *   node --experimental-strip-types tools/recover-grant.ts js-spend.json
 *   node --experimental-strip-types tools/recover-grant.ts --script <redeem hex>
 *
 * A grant's address is a hash of its state, so the address tells you nothing
 * and a stale manifest points at an address the grant has already left. Until
 * now the only way back was the file on disk — which meant a protocol whose
 * entire argument is that limits live in consensus had its RECOVERABILITY
 * living in somebody's filesystem.
 *
 * It does not have to. P2SH requires the redeem script to travel in the clear
 * inside the signature script of every transaction that spends the grant, and
 * the state is spliced into that script at known offsets. So any spending
 * transaction carries, in plain sight, the exact state of the grant it spent —
 * and from that state plus the transaction's own outputs, the successor follows
 * deterministically.
 *
 * Give it any transaction from the grant's history and it walks forward to
 * where the grant is now.
 *
 * ## What it cannot do
 *
 * It cannot find a transaction you do not have. Kaspa's node RPC answers
 * "what is unspent at this address", not "what spent this outpoint", so there
 * is no way to follow the chain forward from genesis without an indexer. What
 * this needs is one transaction — the last one you have a record of, from a
 * log, an explorer, or the wire JSON the build tools write. From there it
 * reaches the present.
 */

import { readFileSync } from "node:fs";

import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { NodeClient } from "../src/node.ts";
import { successorState } from "../src/spend.ts";
import { pushChild } from "../src/delegate.ts";
import { reabsorbSuccessorState } from "../src/reabsorb.ts";
import { EMPTY_RESERVE } from "../src/keys.ts";
import {
  decodeGrant,
  redeemScriptFrom,
  scriptHashFor,
  templateFingerprint,
  type CovenantTemplate,
  type Grant,
} from "../src/template.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const template: CovenantTemplate = JSON.parse(
  readFileSync(
    flag("template")
      ? new URL(flag("template")!, `file://${process.cwd()}/`)
      : new URL("../covenant-template.json", import.meta.url),
    "utf8",
  ),
);
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const scriptHex = flag("script");
if (!positional[0] && !scriptHex) {
  console.error(
    "usage: recover-grant.ts <wire-tx.json> [--template t.json] [--prefix p] [--rpc url]\n" +
      "       recover-grant.ts --script <redeem script hex>\n\n" +
      "Give it any transaction that spent the grant. The wire JSON written by\n" +
      "build-spend, build-live-spend, build-delegation, build-exit and\n" +
      "build-settlement all work.",
  );
  process.exit(2);
}

interface WireOutput {
  value: string;
  scriptPublicKeyHex: string;
  covenant: { authorizingInput: number; covenantId: string } | null;
}
interface Wire {
  lockTime: string;
  inputs: { signatureScriptHex: string }[];
  outputs: WireOutput[];
}

let wire: Wire | null = null;
if (positional[0]) wire = JSON.parse(readFileSync(positional[0], "utf8"));

/** Decode the grant spent by one input. Nothing here is taken on trust. */
function grantOfInput(i: number): Grant {
  return decodeGrant(template, redeemScriptFrom(fromHex(wire!.inputs[i]!.signatureScriptHex), template));
}

function describe(label: string, g: Grant): void {
  console.log(`\n${label}`);
  console.log(`  address      : ${scriptHashToAddress(scriptHashFor(template, g), prefix)}`);
  console.log(`  agent        : ${g.state.agentKey}`);
  console.log(`  principal    : ${g.authority.principalKey}`);
  console.log(`  budget       : ${g.state.budgetTotal}, spent ${g.state.spentTotal}, reserved ${g.state.reserved}`);
  console.log(`  epoch        : ${g.state.epochIndex}, used ${g.state.epochSpent} of ${g.state.epochLimit}`);
  console.log(`  window       : ${g.state.notBefore} to ${g.state.expiresAt}`);
  console.log(`  reserve      : ${g.state.reserveRoot === EMPTY_RESERVE ? "empty (no live children)" : g.state.reserveRoot}`);
}

console.log(`covenant       : ${templateFingerprint(template)}`);

if (!wire) {
  // --script: the state, and nothing about where it went. Still worth having —
  // it is the difference between a hex blob and a grant you can point tools at.
  describe("the grant this script encodes:", decodeGrant(template, fromHex(scriptHex!)));
  process.exit(0);
}

const ins = wire.inputs.length;
const outs = wire.outputs.length;

/**
 * Which shape of transaction is this?
 *
 * The four entrypoints that move a grant each leave a distinct footprint, and
 * the footprint is in the transaction itself rather than in any label:
 *
 *   spend        1 in,  2 out, output 1 unbound   — pays a recipient, grant continues
 *   delegate     1 in,  2 out, output 1 bound     — both outputs are covenants
 *   exit         1 in,  1 out, unbound            — reclaim or revoke; the grant ends
 *   settlement   2 in,  1 out, bound              — child collapses into parent
 *
 * Reading the shape rather than being told it means a mislabelled or
 * hand-edited file cannot talk this into deriving the wrong successor.
 */
let successor: Grant | null = null;
let kind: string;
let expectedPaidTo: string | null = null;

if (ins === 2 && outs === 1) {
  kind = "settlement";
  const parentIndex = wire.outputs[0]!.covenant?.authorizingInput ?? 0;
  const childIndex = parentIndex === 0 ? 1 : 0;
  const parent = grantOfInput(parentIndex);
  const child = grantOfInput(childIndex);
  describe(`the PARENT this settlement reabsorbed into (input ${parentIndex}):`, parent);
  describe(`the CHILD it collapsed (input ${childIndex}):`, child);

  // reabsorbSuccessorState needs the reserve root as it stood BEFORE this child
  // was pushed, and a hash cannot be run backwards. But it can be CHECKED: if
  // the parent's recorded root is what pushing this child onto an empty stack
  // produces, the prior root was empty. That is the whole of the common case —
  // one child at a time — and anything deeper needs the delegation record.
  const prior = pushChild(EMPTY_RESERVE, child.state) === parent.state.reserveRoot ? EMPTY_RESERVE : null;
  if (prior === null) {
    console.log(`\n  the parent's reserve stack held more than this one child, so the root it`);
    console.log(`  returns to is not derivable from this transaction alone — a hash does not`);
    console.log(`  run backwards. Recover it from the delegation that pushed the child below`);
    console.log(`  this one, and the successor follows.`);
  } else {
    successor = {
      authority: parent.authority,
      state: reabsorbSuccessorState(parent.state, child.state, prior),
    };
  }
  expectedPaidTo = wire.outputs[0]!.scriptPublicKeyHex;
} else if (ins === 1 && outs === 1) {
  kind = "exit";
  const spent = grantOfInput(0);
  describe("the grant this transaction ENDED:", spent);
  console.log(`\n  This was a reclaim or a revocation: ${wire.outputs[0]!.value} sompi went to a`);
  console.log(`  plain address and the covenant is gone. There is no successor to find.`);
} else if (ins === 1 && outs === 2) {
  const spent = grantOfInput(0);
  describe("the grant this transaction SPENT:", spent);
  expectedPaidTo = wire.outputs[0]!.scriptPublicKeyHex;
  if (wire.outputs[1]!.covenant) {
    kind = "delegation";
    console.log(`\n  This was a DELEGATION: ${wire.outputs[1]!.value} sompi went to a child covenant`);
    console.log(`  at ${wire.outputs[1]!.scriptPublicKeyHex.slice(4, 68)}.`);
    console.log(`  The parent's successor commits to the child's WHOLE birth state, and the`);
    console.log(`  child's script is not in this transaction — only the hash of it. Recover`);
    console.log(`  the child from the first transaction that spends IT, or from the child`);
    console.log(`  manifest build-delegation wrote, and the parent follows.`);
  } else {
    kind = "spend";
    successor = {
      authority: spent.authority,
      // Output 1 is the payment; output 0 is the grant's continuation. The
      // amount that moves the state is what the RECIPIENT got, not the change.
      state: successorState(spent.state, BigInt(wire.outputs[1]!.value), BigInt(wire.lockTime)),
    };
  }
} else {
  console.error(
    `\n${ins} inputs and ${outs} outputs is not a shape any Warda entrypoint produces. ` +
      `This transaction carries a redeem script of the right length, which is odd; check ` +
      `you have the right file.`,
  );
  process.exit(1);
}

if (successor && expectedPaidTo) {
  const address = scriptHashToAddress(scriptHashFor(template, successor), prefix);
  const derived = "aa20" + scriptHashFor(template, successor) + "87";
  console.log(`\nthe grant MOVED to (a ${kind}):`);
  console.log(`  address      : ${address}`);
  console.log(`  budget       : ${successor.state.budgetTotal}, spent ${successor.state.spentTotal}, reserved ${successor.state.reserved}`);
  console.log(`  epoch        : ${successor.state.epochIndex}, used ${successor.state.epochSpent}`);
  // The successor derived from the decoded state must be the one this
  // transaction actually paid. If it is not, the arithmetic is wrong, and
  // printing the address anyway would send someone to an empty one and let
  // them believe the grant was drained.
  if (derived !== expectedPaidTo) {
    console.error(
      `\nREFUSING to report this address: the successor derived from the decoded state\n` +
        `is not the one the transaction pays.\n  derived : ${derived}\n  paid    : ${expectedPaidTo}\n\n` +
        `Two things cause this. The template may be a different version of the covenant\n` +
        `than the one this grant was issued under — pass --template. Or this SDK and the\n` +
        `chain disagree about the state transition, which is a bug worth reporting.`,
    );
    process.exit(1);
  }
  console.log(`  confirmed    : this is the address the transaction actually paid`);
}

// And is it still there? A grant that has moved again will be empty, which is
// information rather than an error: it means a later transaction exists.
if (!successor) process.exit(0);
const targetAddress = scriptHashToAddress(scriptHashFor(template, successor), prefix);

// The chain check is the last step and the only one that needs a network. It
// is deliberately not a precondition: everything above is derived from the
// transaction alone, so recovery works with no node at all — which matters,
// because "I cannot reach a node" is a common reason to be recovering.
let client: NodeClient;
try {
  client = await NodeClient.connect({ url: flag("rpc") });
} catch (e) {
  console.log(`\nrecovered without a node. The grant is at:\n  ${targetAddress}`);
  console.log(`Could not check whether it is still unspent (${(e as Error).message}).`);
  process.exit(0);
}
try {
  const utxos = await client.getUtxosByAddresses([targetAddress]);
  console.log(`\non chain:`);
  if (utxos.length === 1) {
    console.log(`  ${utxos[0]!.entry.value} sompi at ${targetAddress}`);
    console.log(`\nthis is the grant, live, as of now.`);
    console.log(`Rebuild a manifest from the fields above, or point the tools at this address.`);
  } else if (utxos.length === 0) {
    console.log(`  nothing at ${targetAddress}`);
    console.log(
      `\nthe grant has moved again since this transaction. Feed this tool a LATER\n` +
        `transaction and it will walk forward another step. Each one you have takes\n` +
        `you one spend closer to the present.`,
    );
  } else {
    console.log(`  ${utxos.length} UTXOs at ${targetAddress} — a grant holds exactly one`);
  }
} finally {
  client.close();
}
