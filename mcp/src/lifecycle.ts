/**
 * The rest of a grant's life, for callers who reach Warda through MCP.
 *
 * `build.ts` builds a spend. A grant does four other things — it delegates, it
 * settles a child back into itself, it is revoked or reclaimed, and it gets
 * LOST — and until now an agent framework could only do the first of those
 * through this server. The gap mattered most at the ends: an operator whose
 * agent was misbehaving had no revocation path here, and an operator whose
 * manifest had gone stale had no way back to the grant at all.
 *
 * Same rule as everywhere else in this package: NOTHING HERE SEES A KEY. Every
 * function returns unsigned bytes and a digest. A settlement returns two
 * digests, because it is signed by two different parties and pretending
 * otherwise would hide who is agreeing to what.
 */
import {
  attachDelegationSignature,
  buildUnsignedDelegation,
  buildUnsignedExit,
  buildUnsignedReabsorb,
  childStateFrom,
  decodeGrant,
  grantFromSignatureScript,
  parentSuccessorState,
  pushChild,
  reabsorbSuccessorState,
  redeemScriptFrom,
  successorState,
  scriptHashFor,
  scriptHashToAddress,
  toWire,
  toWireMulti,
  toHex,
  fromHex,
  EMPTY_RESERVE,
  type ChildTerms,
  type ExitKind,
  type Grant,
  type GrantState as SdkGrantState,
  type NetworkPrefix,
  type WireTransaction,
  // The SDK's tree, NOT @warda_protocol/core's. They agree on the root and
  // disagree on the interface, and `subsetWitness` checks the root through
  // `rootHex` — which the core's set does not have, so the mismatch surfaces
  // as "this grant commits to <hash>" against `undefined`.
  RecipientSet,
} from "@warda_protocol/kaspa";

import { addressOf, authorityOf, loadTemplate, stateOf, utxoOf, type UtxoDescriptor } from "./build.ts";
import type { Materialised } from "./grant.ts";

const PLACEHOLDER = new Uint8Array(65);

function address(state: SdkGrantState, m: Materialised, prefix: NetworkPrefix): string {
  return scriptHashToAddress(
    scriptHashFor(loadTemplate(), { authority: authorityOf(m), state }),
    prefix,
  );
}

// ---- delegation ----------------------------------------------------------

export interface DelegateOptions {
  child: ChildTerms;
  /** The parent's FULL member list, needed only when the child narrows it. */
  parentRecipients?: string[];
  utxo: UtxoDescriptor;
  feeSompi: bigint;
  computeBudget: number;
  prefix: NetworkPrefix;
}

export function buildDelegation(m: Materialised, o: DelegateOptions) {
  const template = loadTemplate();
  const parentState = stateOf(m);
  const plan = {
    template,
    authority: authorityOf(m),
    state: parentState,
    utxo: utxoOf(o.utxo),
    child: o.child,
    recipients: o.parentRecipients ? new RecipientSet(o.parentRecipients) : undefined,
    fee: o.feeSompi,
    computeBudget: o.computeBudget,
  } as Parameters<typeof buildUnsignedDelegation>[0];
  const built = buildUnsignedDelegation(plan);
  const tx = attachDelegationSignature(plan, built, PLACEHOLDER);

  return {
    transaction: toWire(tx, built.entry, "@warda_protocol/mcp (unsigned delegation)") as WireTransaction,
    sighashHex: toHex(built.sighash),
    signedBy: "the parent's AGENT key — delegation subdivides the agent's budget",
    parentMovesTo: address(built.parentSuccessorState, m, o.prefix),
    childAddress: address(built.childState, m, o.prefix),
    childBudgetSompi: o.child.budgetTotal.toString(),
    parentChangeSompi: built.parentChange.toString(),
    /**
     * The one number settlement cannot derive. The parent's reserve is a hash
     * chain, and popping one means supplying the preimage — it is in neither
     * grant's state and in no transaction. Record it against this child; a
     * settlement without it is impossible, not merely inconvenient.
     */
    parentReserveRootBefore: parentState.reserveRoot,
    /**
     * And after. The parent's descriptor needs it to derive its own address
     * from here on: a caller that leaves this out is describing the parent as
     * it was BEFORE it delegated, and will find nothing at the address that
     * produces.
     */
    parentReserveRootAfter: built.parentSuccessorState.reserveRoot,
    childRecipientsNarrowed: built.childState.recipientsRoot !== parentState.recipientsRoot,
    successorNote:
      "The PARENT moves too. Its reserve root is part of its address, so a caller " +
      "that keeps watching the old one will conclude the grant vanished.",
  };
}

// ---- settlement ----------------------------------------------------------

export interface SettleOptions {
  parentUtxo: UtxoDescriptor;
  childUtxo: UtxoDescriptor;
  /** The parent's reserve root as it stood before this child was pushed. */
  prevRoot: string;
  feeSompi: bigint;
  computeBudget: number;
  prefix: NetworkPrefix;
}

/**
 * A child collapsing back into its parent.
 *
 * The parent's unspent loan returns to the AGENT's budget. Letting the child
 * expire instead returns it to the principal — to the human — which is no use
 * to an agent halfway through a task, and is why settlement exists at all.
 */
export function buildSettlement(parent: Materialised, child: Materialised, o: SettleOptions) {
  const template = loadTemplate();
  const parentState = stateOf(parent);
  const childState = stateOf(child);

  const pa = authorityOf(parent), ca = authorityOf(child);
  if (pa.principalKey !== ca.principalKey || pa.revocationKey !== ca.revocationKey) {
    throw new Error(
      `these grants do not share an authority, so no settlement between them exists. ` +
        `Authority is compiled into the covenant rather than carried in its state, so it ` +
        `is part of the template id: a parent can only ever reabsorb its own children.`,
    );
  }
  // Assert the pop before attempting it. The covenant re-derives this itself,
  // so this changes nothing about what the chain accepts — only what the
  // caller is told when it will not.
  const rebuilt = pushChild(o.prevRoot, childState);
  if (rebuilt !== parentState.reserveRoot) {
    throw new Error(
      `this child is not on top of the parent's reserve stack. The stack is LIFO, so ` +
        `the most recently delegated child settles first. The other cause is a child ` +
        `state that has moved since the delegation — the root commits to what the child ` +
        `has ACTUALLY spent, which is what the parent gets charged.`,
    );
  }

  const plan = {
    template,
    authority: pa,
    parentState,
    childState,
    prevRoot: o.prevRoot,
    parentUtxo: utxoOf(o.parentUtxo),
    childUtxo: utxoOf(o.childUtxo),
    fee: o.feeSompi,
    computeBudget: o.computeBudget,
  } as Parameters<typeof buildUnsignedReabsorb>[0];
  const built = buildUnsignedReabsorb(plan);
  const settled = reabsorbSuccessorState(parentState, childState, o.prevRoot);

  return {
    transaction: toWireMulti(built.tx, built.entries, "@warda_protocol/mcp (unsigned settlement)"),
    // TWO digests, deliberately unmerged. They are signed by different
    // parties, and each commits to its own input's entry — signing one over
    // the other's produces a transaction that fails at input 1 with a stack
    // error naming neither key.
    parentSighashHex: toHex(built.parentSighash),
    parentSignedBy: "the parent's AGENT key — it is the agent's budget being restored",
    childSighashHex: toHex(built.childSighash),
    childSignedBy:
      "the REVOCATION key — collapsing a grant is a revocation of it, so a sub-agent " +
      "must not be able to end its own grant on terms it chooses",
    parentMovesTo: address(settled, parent, o.prefix),
    releasedSompi: childState.budgetTotal.toString(),
    chargedSompi: childState.spentTotal.toString(),
    returnedToBudgetSompi: (childState.budgetTotal - childState.spentTotal).toString(),
  };
}

// ---- revoke and reclaim --------------------------------------------------

export interface ExitOptions {
  kind: ExitKind;
  utxo: UtxoDescriptor;
  /** Reclaim needs at least expiresAt; revoke takes 0. */
  lockTime: bigint;
  feeSompi: bigint;
  computeBudget: number;
}

/**
 * Ending a grant.
 *
 * `revoke` is the principal's emergency stop and takes effect the moment the
 * transaction confirms; `reclaim` is the same sweep after the window has
 * closed, and the covenant enforces the timing with a CLTV rather than
 * trusting the caller's word about it.
 *
 * Worth having here specifically because of monitoring: something that watches
 * a grant and finds it behaving badly needs a way to act, and until this
 * existed the only revocation path went through a CLI on someone's laptop.
 */
export function buildExit(m: Materialised, o: ExitOptions) {
  const plan = {
    kind: o.kind,
    template: loadTemplate(),
    authority: authorityOf(m),
    state: stateOf(m),
    utxo: utxoOf(o.utxo),
    fee: o.feeSompi,
    computeBudget: o.computeBudget,
    lockTime: o.lockTime,
  } as Parameters<typeof buildUnsignedExit>[0];
  const built = buildUnsignedExit(plan);
  return {
    transaction: toWire(built.tx, built.entry, `@warda_protocol/mcp (unsigned ${o.kind})`),
    sighashHex: toHex(built.sighash),
    signedBy:
      o.kind === "revoke"
        ? "the REVOCATION key. Takes effect as soon as this confirms; the agent cannot stop it."
        : "the PRINCIPAL key. Only valid once the chain has passed expiresAt — enforced by a CLTV, not by this server.",
    sweptToSompi: built.tx.outputs[0]!.value.toString(),
    destination: toHex(built.destination),
  };
}

// ---- recovery ------------------------------------------------------------

export interface RecoveredGrant {
  covenant: string;
  address: string;
  authority: Grant["authority"];
  state: Record<string, string>;
  movedTo?: string;
  kind: string;
  note: string;
}

const show = (s: SdkGrantState): Record<string, string> =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, String(v)]));

/**
 * Find a grant again from a transaction that spent it.
 *
 * A grant's address is a hash of its state, so the address reveals nothing and
 * a stale record points at somewhere the grant has already left. But Kaspa's
 * P2SH requires the redeem script to travel IN THE CLEAR inside the signature
 * script of every spending transaction — the network cannot check the hash
 * otherwise — and the state is spliced into that script at known offsets. So
 * every spend publishes the grant it spent, whether the spender meant to or
 * not.
 *
 * This matters more than it sounds. Without it a grant is reachable only
 * through a file on somebody's disk: lose it and the coin is perfectly valid
 * on chain and simply unreachable. A protocol whose argument is that limits
 * live in consensus should not have its recoverability live in a filesystem.
 */
export function recover(
  input: { wire?: WireTransaction; redeemScriptHex?: string },
  prefix: NetworkPrefix,
): RecoveredGrant {
  const template = loadTemplate();
  const addr = (g: Grant) => scriptHashToAddress(scriptHashFor(template, g), prefix);

  if (input.redeemScriptHex) {
    const g = decodeGrant(template, fromHex(input.redeemScriptHex));
    return {
      covenant: template.baselineHex.length ? "loaded template" : "",
      address: addr(g),
      authority: g.authority,
      state: show(g.state),
      kind: "script",
      note: "The state this script encodes, and nothing about where it went.",
    };
  }

  const wire = input.wire!;
  const spent = grantFromSignatureScript(fromHex(wire.inputs[0]!.signatureScriptHex), template);
  const ins = wire.inputs.length, outs = wire.outputs.length;
  const base = {
    covenant: "loaded template",
    address: addr(spent),
    authority: spent.authority,
    state: show(spent.state),
  };

  // The shape is read from the transaction rather than taken on its word, so
  // a mislabelled file cannot talk this into deriving the wrong successor.
  if (ins === 1 && outs === 2 && !wire.outputs[1]!.covenant) {
    const next = successorState(spent.state, BigInt(wire.outputs[1]!.value), BigInt(wire.lockTime));
    const successor = { authority: spent.authority, state: next };
    const paid = "aa20" + scriptHashFor(template, successor) + "87";
    if (paid !== wire.outputs[0]!.scriptPublicKeyHex) {
      throw new Error(
        `the successor derived from the decoded state is not the one this transaction ` +
          `pays. Reporting the address anyway would send you to an empty one. Either the ` +
          `template is a different version of the covenant than the grant was issued ` +
          `under, or this SDK and the chain disagree about the transition.`,
      );
    }
    return { ...base, kind: "spend", movedTo: addr(successor), note: "Confirmed against the address this transaction actually paid." };
  }
  if (ins === 1 && outs === 2) {
    return {
      ...base,
      kind: "delegation",
      note:
        "A delegation. The parent's successor commits to the CHILD's whole birth state, " +
        "and only the hash of the child's script is in this transaction. Recover the " +
        "child from a transaction that spends IT, and the parent follows.",
    };
  }
  if (ins === 1 && outs === 1) {
    return { ...base, kind: "exit", note: "A reclaim or a revocation. The grant is over; there is no successor." };
  }
  if (ins === 2 && outs === 1) {
    const parentIndex = wire.outputs[0]!.covenant?.authorizingInput ?? 0;
    const childIndex = parentIndex === 0 ? 1 : 0;
    const parent = grantFromSignatureScript(fromHex(wire.inputs[parentIndex]!.signatureScriptHex), template);
    const child = grantFromSignatureScript(fromHex(wire.inputs[childIndex]!.signatureScriptHex), template);
    // Both redeem scripts travel, so a settlement recovers BOTH grants.
    const prior = pushChild(EMPTY_RESERVE, child.state) === parent.state.reserveRoot ? EMPTY_RESERVE : null;
    const settled = prior === null ? null : reabsorbSuccessorState(parent.state, child.state, prior);
    return {
      covenant: "loaded template",
      address: addr(parent),
      authority: parent.authority,
      state: show(parent.state),
      kind: "settlement",
      movedTo: settled ? addr({ authority: parent.authority, state: settled }) : undefined,
      note: settled
        ? `A settlement. The child at ${addr(child)} collapsed into this parent.`
        : `A settlement, but the parent's reserve stack held more than this one child, so ` +
          `the root it returns to is not derivable here — a hash does not run backwards.`,
    };
  }
  throw new Error(`${ins} inputs and ${outs} outputs is not a shape any Warda entrypoint produces.`);
}

export { redeemScriptFrom, childStateFrom, parentSuccessorState };
