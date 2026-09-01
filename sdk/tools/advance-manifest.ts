/**
 * Moves a manifest to the state a submitted transaction produced.
 *
 * This is not bookkeeping. A grant's ADDRESS is derived from its state, so a
 * manifest left behind points at an address the grant has already left, and
 * the next tool reports "no UTXO at the grant address" for a grant that is
 * perfectly healthy. That reads as a lost grant and is merely a stale file.
 *
 *   node --experimental-strip-types tools/advance-manifest.ts \
 *     ../covenant/deploy/grant-child-8fefa35b.json js-child-spend.json
 *
 * Advancing a PARENT past a delegation additionally needs the child it created:
 *
 *   node --experimental-strip-types tools/advance-manifest.ts \
 *     ../covenant/deploy/grant.json js-delegation.json \
 *     --child ../covenant/deploy/grant-child-8fefa35b.json
 *
 * `warda-deploy submit` does this for `grant.json` and only for `grant.json`,
 * which was fine while there was one grant. Delegation makes trees, and a
 * child's manifest is a separate file that nothing was advancing.
 *
 * ## Why this cannot quietly write the wrong thing
 *
 * The new state is not what we intended to do. It is derived from the
 * transaction's OWN numbers, and then the successor ADDRESS implied by that
 * state is required to equal the address the transaction actually pays. If
 * they disagree, nothing is written — a confidently wrong manifest is worse
 * than a stale one, because a stale one announces itself.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { EMPTY_RESERVE } from "../src/keys.ts";
import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { childStateFrom, parentSuccessorState, type ChildTerms } from "../src/delegate.ts";
import { reabsorbSuccessorState } from "../src/reabsorb.ts";
import { successorState } from "../src/spend.ts";
import { scriptHashFor, templateFingerprint, type CovenantTemplate, type GrantState, templateIdFor } from "../src/template.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const [manifestPath, txPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!manifestPath || !txPath) {
  console.error("usage: advance-manifest.ts <manifest.json> <wire-tx.json>");
  process.exit(2);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const wire = JSON.parse(readFileSync(txPath, "utf8"));
/**
 * Which covenant this grant was issued under. Missed here when the other four
 * tools got it, and the omission was invisible until a v1 grant needed
 * advancing: the input-identity guard refused, correctly, with a message about
 * sibling grants that had nothing to do with the real cause.
 */
function loadTemplate(m: { covenant?: string }): CovenantTemplate {
  const named = flag("template");
  const url = named
    ? new URL(named, `file://${process.cwd()}/`)
    : new URL("../covenant-template.json", import.meta.url);
  const tpl: CovenantTemplate = JSON.parse(readFileSync(url, "utf8"));
  const have = templateFingerprint(tpl);
  if (m.covenant && m.covenant !== have) {
    console.error(
      `this manifest was issued under covenant ${m.covenant}, and the template ` +
        `loaded is ${have}. Pass --template <that covenant's template>.`,
    );
    process.exit(1);
  }
  return tpl;
}

const template: CovenantTemplate = loadTemplate(m);

const principalKey = flag("principal", m.principal ?? m.agent)!;
const authority = { principalKey, revocationKey: flag("revocation", m.revocation ?? principalKey)! };
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;

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
  templateId: templateIdFor(template, authority),
  spentTotal: BigInt(m.spent_total),
  reserved: BigInt(m.reserved),
  epochIndex: BigInt(m.epoch_index),
  epochSpent: BigInt(m.epoch_spent),
  // A parent that has delegated is NOT at EMPTY_RESERVE, and the root is part
  // of the address. Reading it as empty derives an address the grant left the
  // moment it delegated, and every tool then reports a healthy grant as
  // missing -- which is what made delegation one-way in practice rather than
  // in the covenant. `advance-manifest` writes this field now; a manifest
  // predating it has never delegated, so the default is right for it.
  reserveRoot: m.reserve_root ?? EMPTY_RESERVE,
};

/** P2SH is OP_BLAKE2B <32-byte hash> OP_EQUAL. */
const p2sh = (scriptHashHex: string) => "aa20" + scriptHashHex + "87";
/** P2PK is OP_DATA_32 <x-only key> OP_CHECKSIG. */
const p2pk = (xonly: string) => "20" + xonly + "ac";

if (wire.outputs.length !== 1 && wire.outputs.length !== 2) {
  console.error(`this transaction has ${wire.outputs.length} outputs; nothing this covenant builds does.`);
  process.exit(1);
}

/** P2SH is OP_BLAKE2B <32-byte hash> OP_EQUAL. */
const p2shOf = (scriptHashHex: string) => "aa20" + scriptHashHex + "87";

/**
 * A SETTLEMENT: two inputs, one output, and the output continues a covenant.
 *
 * It is the only shape with two inputs, and it advances TWO manifests in
 * opposite directions — the parent gains its reserve back and is charged what
 * the child spent; the child is over. Handled before everything below because
 * the checks under here assume one input and read `wire.utxo`, which a
 * two-input transaction deliberately does not carry.
 */
if (wire.inputs.length === 2 && wire.outputs.length === 1 && wire.outputs[0].covenant) {
  const childPath = flag("child");
  if (!childPath) {
    console.error(
      `this is a SETTLEMENT, and it moves two grants. Pass --child <the child\n` +
        `manifest> so both can be advanced together: the parent reclaims the\n` +
        `child's unspent reserve and is charged what the child did spend, and\n` +
        `recording one without the other leaves the pair inconsistent.`,
    );
    process.exit(1);
  }
  const cm = JSON.parse(readFileSync(childPath, "utf8"));
  const childState: GrantState = {
    ...state,
    agentKey: cm.agent,
    budgetTotal: BigInt(cm.budget),
    maxPerSpend: BigInt(cm.max_per_spend),
    epochLimit: BigInt(cm.epoch_limit),
    recipientsRoot: cm.recipients_root,
    notBefore: BigInt(cm.not_before),
    expiresAt: BigInt(cm.expires_at),
    delegationDepth: BigInt(cm.delegation_depth ?? 1),
    spentTotal: BigInt(cm.spent_total),
    reserved: BigInt(cm.reserved),
    epochIndex: BigInt(cm.epoch_index),
    epochSpent: BigInt(cm.epoch_spent),
    reserveRoot: cm.reserve_root ?? EMPTY_RESERVE,
  };
  const prevRoot = flag("prev-root", cm.parent_reserve_root_before);
  if (!prevRoot) {
    console.error(
      `${childPath} does not record parent_reserve_root_before, so the parent's\n` +
        `reserve stack cannot be popped. Pass --prev-root.`,
    );
    process.exit(1);
  }

  // Both grants must be inputs of THIS transaction, at the addresses their
  // manifests currently derive. Checked against the entries rather than the
  // outputs: the output is the successor, which proves nothing about which
  // grants went in.
  const parentScript = p2shOf(scriptHashFor(template, { authority, state }));
  const childScript = p2shOf(scriptHashFor(template, { authority, state: childState }));
  const present = (wire.utxos ?? []).map((u: { scriptPublicKeyHex: string }) => u.scriptPublicKeyHex);
  for (const [label, want, path] of [
    ["parent", parentScript, manifestPath],
    ["child", childScript, childPath],
  ] as const) {
    if (!present.includes(want)) {
      console.error(
        `the ${label} this settlement consumed is not the one ${path} describes.\n` +
          `  the manifest derives : ${want}\n` +
          `  this transaction ate : ${present.join(", ")}\n` +
          `Nothing changed. The manifest is probably stale, or already advanced.`,
      );
      process.exit(1);
    }
  }

  const settled = reabsorbSuccessorState(state, childState, prevRoot);
  const expected = p2shOf(scriptHashFor(template, { authority, state: settled }));
  if (expected !== wire.outputs[0].scriptPublicKeyHex) {
    console.error(
      `\nREFUSING to advance ${manifestPath}.\n` +
        `  settling this child implies a parent at:\n    ${expected}\n` +
        `  but the transaction pays:\n    ${wire.outputs[0].scriptPublicKeyHex}\n` +
        `Either --prev-root is wrong, or the child manifest has moved since the\n` +
        `settlement was built. Unchanged.`,
    );
    process.exit(1);
  }

  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        ...m,
        grant_value: Number(wire.outputs[0].value),
        spent_total: Number(settled.spentTotal),
        reserved: Number(settled.reserved),
        reserve_root: settled.reserveRoot,
        // The stack entry this settlement popped, removed. Leaving it would
        // let the same child be settled twice on paper.
        reserve_stack: (m.reserve_stack ?? []).slice(0, -1),
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    childPath,
    JSON.stringify(
      {
        ...cm,
        grant_value: 0,
        closed: {
          kind: "settled",
          txid: wire.txid,
          // Not "swept to" anyone: the coin went back into the parent's
          // budget, which is the entire difference between settling and
          // letting a child expire into the principal's hands.
          settled_into: manifestPath,
          value: Number(childState.budgetTotal - childState.spentTotal),
          from_address: scriptHashToAddress(scriptHashFor(template, { authority, state: childState }), prefix),
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`settled ${childPath} into ${manifestPath}`);
  console.log(`  parent now at : ${scriptHashToAddress(scriptHashFor(template, { authority, state: settled }), prefix)}`);
  console.log(`  holds         : ${wire.outputs[0].value} sompi, reserved ${settled.reserved}`);
  console.log(`  charged       : ${childState.spentTotal} sompi the child spent`);
  console.log(`  returned      : ${childState.budgetTotal - childState.spentTotal} sompi to the parent's budget`);
  process.exit(0);
}

// Is this a transaction of THIS grant, or of a relative?
//
// The covenant id is NOT unique per grant: a delegated child inherits its
// parent's, so every grant in a tree answers to the same id. The only honest
// gate is the INPUT — a transaction moves the grant this manifest describes
// only if the UTXO it consumes sits at the address this manifest's CURRENT
// state derives. Without it, pointing at the wrong manifest produces a
// successor-address disagreement, which reads as "these numbers are wrong"
// when the truth is "this is not your transaction".
const currentScript = p2sh(scriptHashFor(template, { authority, state }));
if (wire.utxo.scriptPublicKeyHex !== currentScript) {
  console.error(
    `this transaction does not spend the grant ${manifestPath} describes.\n` +
      `  it consumes a UTXO at : ${wire.utxo.scriptPublicKeyHex}\n` +
      `  this manifest is at   : ${currentScript}\n` +
      `Nothing changed. Two causes reach this line: a sibling grant in the same ` +
      `tree (they share a covenant id, so the id cannot tell them apart), or the ` +
      `WRONG TEMPLATE — a grant issued under a different covenant derives a ` +
      `different address from the same state. Try --template.`,
  );
  process.exit(1);
}

// An EXIT — reclaim or revoke — has one output, paying the principal's P2PK,
// and no successor at all. There is no state to advance to: the grant is over.
// Recording that is not tidiness. Without it the manifest still describes a
// live grant, and the next verify reports "nothing at this address, the grant
// has probably moved" — which is the message for a LOST grant, about one that
// was deliberately closed.
if (wire.outputs.length === 1) {
  const expectedPayout = p2pk(authority.principalKey);
  if (wire.outputs[0].scriptPublicKeyHex !== expectedPayout) {
    console.error(
      `a one-output transaction of this grant should pay the principal's P2PK.\n` +
        `  it pays  : ${wire.outputs[0].scriptPublicKeyHex}\n` +
        `  expected : ${expectedPayout}\nNothing changed.`,
    );
    process.exit(1);
  }
  // Revoke carries no lock time; reclaim's is at least expiresAt. That is the
  // only difference visible in the transaction itself.
  const kind = BigInt(wire.lockTime) >= state.expiresAt ? "reclaim" : "revoke";
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        ...m,
        grant_value: 0,
        closed: {
          kind,
          txid: wire.txid,
          swept_to: authority.principalKey,
          value: Number(wire.outputs[0].value),
          from_address: scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix),
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`closed ${manifestPath} (${kind})`);
  console.log(`  swept  : ${wire.outputs[0].value} sompi to P2PK ${authority.principalKey}`);
  console.log(`  txid   : ${wire.txid}`);
  process.exit(0);
}

// A SPEND and a DELEGATION are both "two outputs, output 0 continuing the
// covenant", and they move the state in opposite directions. The discriminator
// is output 1: a spend pays a recipient's plain P2PK, a delegation pays a
// CHILD GRANT, which carries a covenant binding of its own.
const delegating = wire.outputs[1].covenant !== null && wire.outputs[1].covenant !== undefined;

/**
 * A delegation moves the parent's reserve ROOT as well as its reserve, and the
 * root is a hash of the child's whole birth state — not of its budget. So the
 * parent cannot be advanced past a delegation from the transaction alone: the
 * child's terms are not recoverable from the child's ADDRESS, which is a hash.
 *
 * That is not a gap to paper over. It is the reserve accumulator doing its job:
 * the parent's state now NAMES its children, so releasing a reserve later has
 * to name which child is being released. The price is that this tool needs the
 * child's manifest, and `build-delegation` writes one.
 *
 * The reconstruction is not trusted. Output 1 pays the child's BIRTH address,
 * so a child state rebuilt from the wrong manifest — or from a manifest that
 * has since advanced — derives a different address and is refused here.
 */
function childBirthState(): GrantState {
  const childPath = flag("child");
  if (!childPath) {
    console.error(
      `this transaction is a DELEGATION, and advancing the parent past one needs\n` +
        `the child's terms: the parent's reserve root commits to the child's whole\n` +
        `birth state, and that is not recoverable from the child's address.\n` +
        `Pass --child <the child manifest build-delegation wrote>.`,
    );
    process.exit(1);
  }
  const cm = JSON.parse(readFileSync(childPath, "utf8"));
  const terms: ChildTerms = {
    agentKey: cm.agent,
    budgetTotal: BigInt(cm.budget),
    maxPerSpend: BigInt(cm.max_per_spend),
    epochLimit: BigInt(cm.epoch_limit),
    delegationDepth: BigInt(cm.delegation_depth),
    notBefore: BigInt(cm.not_before),
    expiresAt: BigInt(cm.expires_at),
  };
  // Birth state, deliberately: the root committed to the child as it was
  // created, so a child that has since spent must NOT be read at its current
  // numbers. childStateFrom is the same function the delegation was built
  // with, which is why the two agree.
  const child = childStateFrom(state, terms);

  const expected = p2sh(scriptHashFor(template, { authority, state: child }));
  if (wire.outputs[1].scriptPublicKeyHex !== expected) {
    console.error(
      `--child does not describe the child this transaction created.\n` +
        `  it pays a grant at   : ${wire.outputs[1].scriptPublicKeyHex}\n` +
        `  ${childPath} derives : ${expected}\n` +
        `Nothing changed. Either this is a different child, or that manifest has\n` +
        `already been advanced and no longer describes the child at birth.`,
    );
    process.exit(1);
  }
  return child;
}

/** The child this delegation created, by address — what the stack entry names. */
function childAddressOf(_next: GrantState): string {
  return scriptHashToAddress(
    fromP2sh(wire.outputs[1].scriptPublicKeyHex),
    prefix,
  );
}

/** P2SH script back to the 32-byte hash inside it. */
function fromP2sh(hex: string): string {
  if (!hex.startsWith("aa20") || !hex.endsWith("87") || hex.length !== 4 + 64 + 2) {
    throw new Error(`not a P2SH script public key: ${hex}`);
  }
  return hex.slice(4, 4 + 64);
}

const next = delegating
  ? // Nothing is spent — the coin has not left the grant, it has been
    // subdivided — and no epoch allowance is consumed, which is why a
    // delegation carries no lock time to read one from.
    parentSuccessorState(state, childBirthState())
  : successorState(state, BigInt(wire.outputs[1].value), BigInt(wire.lockTime));

const expectedScript = p2sh(scriptHashFor(template, { authority, state: next }));
const paid = wire.outputs[0].scriptPublicKeyHex;

if (expectedScript !== paid) {
  console.error(`\nREFUSING to advance ${manifestPath}.`);
  console.error(`  read as a ${delegating ? "DELEGATION" : "SPEND"}`);
  console.error(`  the state derived from this transaction:`);
  console.error(
    `    spent ${next.spentTotal}, reserved ${next.reserved}, epoch ${next.epochIndex}, epochSpent ${next.epochSpent}`,
  );
  console.error(`  implies a successor at:\n    ${expectedScript}`);
  console.error(`  but the transaction pays:\n    ${paid}`);
  console.error(
    `\nEither this manifest describes a different state than the transaction was\n` +
      `built from, or this is not the transaction it appears to be. Unchanged.`,
  );
  process.exit(1);
}

const updated = { ...m };
updated.grant_value = Number(wire.outputs[0].value);
updated.spent_total = Number(next.spentTotal);
updated.reserved = Number(next.reserved);
updated.epoch_index = Number(next.epochIndex);
updated.epoch_spent = Number(next.epochSpent);
/**
 * The reserve stack, written down.
 *
 * This was computed correctly and then thrown away, and throwing it away is
 * what made delegation one-way OUTSIDE the covenant. The root is part of the
 * address, so a parent whose manifest still said "empty" derived the address
 * it had occupied BEFORE it delegated: every tool afterwards reported a
 * perfectly healthy grant as missing, and the delegation looked irreversible
 * because nothing could find the parent again.
 */
updated.reserve_root = next.reserveRoot;
if (delegating) {
  // What the root was before this push. Popping a hash chain means supplying
  // the preimage, so a parent has to remember its own stack -- this is the
  // one number `reabsorb` cannot derive and cannot do without.
  updated.reserve_stack = [...(m.reserve_stack ?? []), { prev_root: state.reserveRoot, child: childAddressOf(next) }];
}
writeFileSync(manifestPath, JSON.stringify(updated, null, 2) + "\n");

console.log(`advanced ${manifestPath} (read as a ${delegating ? "delegation" : "spend"})`);
console.log(`  now at : ${scriptHashToAddress(scriptHashFor(template, { authority, state: next }), prefix)}`);
console.log(`  holds  : ${wire.outputs[0].value} sompi`);
console.log(
  `  state  : spent ${next.spentTotal}, reserved ${next.reserved}, epoch ${next.epochIndex}, epochSpent ${next.epochSpent}`,
);
