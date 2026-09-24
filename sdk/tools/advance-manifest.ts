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
 * An ATOMIC delegation — v5's `delegate2`, one transaction and two children —
 * has three outputs, and nothing here could read that shape at all. The parent
 * was therefore LOST to the tooling the moment it delegated atomically: the
 * reserve root is part of the address, so a manifest left at the old root
 * derives an address the grant has already left, and every tool afterwards
 * reports a healthy grant as missing. It takes its own form, because both
 * children derive from the same parent state and the successor is a pure
 * function of the two manifests `build-delegation2` wrote:
 *
 *   node --experimental-strip-types tools/advance-manifest.ts \
 *     ../v5-demo/grant.json --atomic \
 *     --child-a ../v5-demo/grant-child-A.json \
 *     --child-b ../v5-demo/grant-child-B.json
 *
 * That form needs a node. Every other shape here checks the derived successor
 * against the address the transaction pays; an atomic delegation usually
 * leaves no transaction file behind, so it is checked against the UTXO SET
 * instead — all three outputs, not just the parent's. The chain is a stronger
 * oracle than a file, not a weaker one.
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
import { childStateFrom, parentSuccessorState, parentSuccessorState2, pushChild, type ChildTerms } from "../src/delegate.ts";
import { NodeClient } from "../src/node.ts";
import { reabsorbSuccessorState } from "../src/reabsorb.ts";
import { successorState } from "../src/spend.ts";
import { scriptHashFor, templateFingerprint, type CovenantTemplate, type GrantState, templateIdFor } from "../src/template.ts";
import { resolveNetwork, rpcFrom } from "./network.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * An ATOMIC delegation leaves no wire file behind in the common case -- it is
 * piped to a node and the JSON is gone -- and unlike every other shape, the
 * parent's successor is fully determined by the two child manifests the tool
 * wrote. So this mode derives it and then asks the CHAIN to agree, which is a
 * stronger oracle than a file on disk, not a weaker one.
 */
const atomic = process.argv.includes("--atomic");

const positional = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith("--")) return false;
  const prev = all[i - 1];
  // A flag's VALUE is not a positional. Without this, `--child-a a.json`
  // donates a.json to the transaction slot and the tool reads a manifest as a
  // transaction.
  return !(prev && prev.startsWith("--") && prev !== "--atomic");
});
const [manifestPath, txPath] = positional;
if (!manifestPath || (!txPath && !atomic)) {
  console.error(
    "usage: advance-manifest.ts <manifest.json> <wire-tx.json>\n" +
      "       advance-manifest.ts <parent.json> --atomic --child-a a.json --child-b b.json\n\n" +
      "The second form advances a parent past an ATOMIC delegation (delegate2),\n" +
      "which has three outputs and no single child. It needs a node: the derived\n" +
      "successor must be found on chain before anything is written.",
  );
  process.exit(2);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const wire = atomic ? null : JSON.parse(readFileSync(txPath!, "utf8"));
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
/* Resolved and CHECKED together: a prefix and a network that disagree
   derive a well-formed address on the wrong chain, which holds nothing and
   is indistinguishable from a grant that was drained. See network.ts. */
const { prefix, network } = resolveNetwork({
  prefix: flag("prefix"),
  network: flag("network"),
  action: "advance a manifest",
});

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

/**
 * An ATOMIC DELEGATION: one input, THREE outputs, all three covenants.
 *
 * `delegate2` shipped with no way to move the parent's manifest past it, and
 * that is not a cosmetic gap -- the reserve root is part of the address, so a
 * parent left at its pre-delegation state derives an address it has already
 * left, and every tool afterwards reports a healthy grant as missing. The
 * grant was, to the tooling, lost the moment it delegated atomically.
 *
 * Both children derive from the SAME parent state -- `buildUnsignedDelegation2`
 * measures B against what is left after A, but builds both from `plan.state` --
 * so the successor is a pure function of this manifest and the two the tool
 * wrote. Deriving it is easy; being sure is the work, and the three addresses
 * below are checked against the chain before a byte is written.
 */
if (atomic) {
  const pathA = flag("child-a"), pathB = flag("child-b");
  if (!pathA || !pathB) {
    console.error(
      "--atomic needs both children: --child-a <a.json> --child-b <b.json>.\n" +
        "Order is not a preference. A was pushed onto the reserve chain first and B\n" +
        "second, so the successor's root is push(push(root, A), B) -- the other order\n" +
        "is a different address. Each child manifest records which it is in\n" +
        "`atomic_position`, and the pair is cross-checked below.",
    );
    process.exit(1);
  }
  const cms = [JSON.parse(readFileSync(pathA, "utf8")), JSON.parse(readFileSync(pathB, "utf8"))];
  const [cmA, cmB] = cms;

  // Are these two actually siblings, and this way round? Each manifest names
  // the other and its own position, so a swapped pair is caught here rather
  // than as an address that holds nothing.
  if (cmA.atomic_sibling !== cmB.agent || cmB.atomic_sibling !== cmA.agent) {
    console.error(
      `these two children were not created by the same transaction.\n` +
        `  ${pathA} names sibling ${cmA.atomic_sibling}\n` +
        `  ${pathB} names sibling ${cmB.atomic_sibling}\nNothing changed.`,
    );
    process.exit(1);
  }
  if (cmA.parent_txid !== cmB.parent_txid) {
    console.error(`these two children name different parent transactions. Nothing changed.`);
    process.exit(1);
  }

  const termsOf = (cm: Record<string, any>): ChildTerms => ({
    agentKey: cm.agent,
    budgetTotal: BigInt(cm.budget),
    maxPerSpend: BigInt(cm.max_per_spend),
    epochLimit: BigInt(cm.epoch_limit),
    delegationDepth: BigInt(cm.delegation_depth),
    notBefore: BigInt(cm.not_before),
    expiresAt: BigInt(cm.expires_at),
  });
  // Birth states, deliberately -- the reserve root commits to each child as it
  // was created, so a child that has since spent must not be read at its
  // current numbers.
  const childA = childStateFrom(state, termsOf(cmA));
  const childB = childStateFrom(state, termsOf(cmB));
  const next = parentSuccessorState2(state, childA, childB);

  // The order the manifests claim, re-derived. `parent_reserve_root_before` is
  // the one number settlement cannot recover, so a pair that disagrees with
  // the chain it describes would strand a child permanently.
  const rootAfterA = pushChild(state.reserveRoot, childA);
  if (cmA.parent_reserve_root_before !== state.reserveRoot || cmB.parent_reserve_root_before !== rootAfterA) {
    console.error(
      `the children's recorded reserve roots do not describe this parent.\n` +
        `  A should sit on ${state.reserveRoot}\n` +
        `    it records    ${cmA.parent_reserve_root_before}\n` +
        `  B should sit on ${rootAfterA}\n` +
        `    it records    ${cmB.parent_reserve_root_before}\n\n` +
        `Either --child-a and --child-b are the wrong way round, or this manifest\n` +
        `has already been advanced. Nothing changed.`,
    );
    process.exit(1);
  }

  const addr = (g: GrantState) => scriptHashToAddress(scriptHashFor(template, { authority, state: g }), prefix);
  const [succAddr, addrA, addrB] = [addr(next), addr(childA), addr(childB)];

  // The chain is the oracle. Every other shape here checks the derived
  // successor against the address the transaction pays; an atomic delegation
  // usually leaves no transaction file, so it is checked against the UTXO set
  // instead -- and against all three outputs, not just the parent's, because a
  // parent that lands right while a child lands wrong is the failure that
  // strands money.
  const client = await NodeClient.connect({ url: rpcFrom(flag("rpc")) });
  let values: bigint[];
  try {
    const found = await Promise.all([succAddr, addrA, addrB].map((a) => client.getUtxosByAddresses([a])));
    const missing = (["the parent's successor", "child A", "child B"] as const)
      .map((label, i) => [label, [succAddr, addrA, addrB][i]!, found[i]!.length] as const)
      .filter(([, , n]) => n !== 1);
    if (missing.length) {
      console.error(`\nREFUSING to advance ${manifestPath}: the chain does not show this delegation.`);
      for (const [label, a, n] of missing) {
        console.error(`  ${label} at ${a}\n    ${n === 0 ? "holds nothing" : `${n} UTXOs -- a grant holds exactly one`}`);
      }
      console.error(
        `\nA grant's address is a hash of its state, so an address that holds nothing\n` +
          `means the state derived here is not the state on chain. Three things reach\n` +
          `this line: the wrong template, a manifest already advanced, or a child that\n` +
          `has since spent and so is no longer at its birth address. Nothing changed.`,
      );
      process.exit(1);
    }
    values = found.map((u) => BigInt(u[0]!.entry.value));
  } finally {
    client.close();
  }

  const updated = {
    ...m,
    grant_value: Number(values[0]),
    reserved: Number(next.reserved),
    reserve_root: next.reserveRoot,
    reserve_stack: [
      ...(m.reserve_stack ?? []),
      { prev_root: state.reserveRoot, child: addrA },
      { prev_root: rootAfterA, child: addrB },
    ],
  };
  writeFileSync(manifestPath, JSON.stringify(updated, null, 2) + "\n");

  console.log(`advanced ${manifestPath} (read as an ATOMIC delegation, one transaction, two children)`);
  console.log(`  now at  : ${succAddr}`);
  console.log(`  holds   : ${values[0]} sompi, reserved ${next.reserved}`);
  console.log(`  child A : ${values[1]} sompi at ${addrA}`);
  console.log(`  child B : ${values[2]} sompi at ${addrB}`);
  console.log(`  confirmed on chain: all three outputs are where this derivation says they are.`);
  console.log(`  settlement order  : B (${cmB.agent.slice(0, 8)}) first, then A (${cmA.agent.slice(0, 8)}).`);
  process.exit(0);
}

if (wire.outputs.length !== 1 && wire.outputs.length !== 2) {
  console.error(
    wire.outputs.length === 3
      ? `this is an ATOMIC delegation -- three outputs, two children in one transaction.\n` +
        `Advance the parent with --atomic --child-a <a.json> --child-b <b.json>; the\n` +
        `successor commits to BOTH children's birth states, which a transaction's\n` +
        `outputs do not carry.`
      : `this transaction has ${wire.outputs.length} outputs; nothing this covenant builds does.`,
  );
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
