/**
 * Adversarial probes: transactions the covenant MUST refuse, and the nearest
 * legitimate ones it must still accept.
 *
 * Three holes were found in this covenant in one afternoon, and none of them
 * was found by reading the code. Each was found by asking "what does an
 * attacker supply here?" and handing the answer to the real script engine.
 * The pattern in all three is the same: the covenant checked the SHAPE of
 * something and not its MAGNITUDE.
 *
 *   the epoch index      compared for equality where it needed an inequality,
 *                        so claiming an EARLIER epoch reset the allowance
 *   expiry               absent from the spend path entirely
 *   the exit paths       constrained WHERE the coin went, never HOW MUCH, so
 *                        a revoke could burn the balance to fees
 *
 * A golden vector cannot catch any of these: it proves two implementations
 * agree about a transaction that is supposed to work. These prove the engine
 * REFUSES transactions that are supposed to fail, which is the other half and
 * the half that was missing.
 *
 * Every probe carries its nearest legitimate twin, because a covenant that
 * refuses everything passes a suite of refusals.
 *
 *   node --experimental-strip-types tools/probes.ts            # write them
 *   cd ../covenant/deploy && cargo run -q -- probe             # judge them
 *
 * Or one at a time: `cargo run -q -- verify probes/<name>.json`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { blake2b } from "@noble/hashes/blake2.js";

import { EMPTY_RESERVE } from "../src/keys.ts";
import { concat, fromHex, toHex } from "../src/bytes.ts";
import { ScriptBuilder } from "../src/script.ts";
import { pushState } from "../src/state.ts";
import { dispatchTag } from "../src/spend.ts";
import { bytecodeFor, templateIdFor } from "../src/template.ts";
import { payToPubkeyScript, payToScriptHashScript, sighash, SUBNETWORK_ID_NATIVE } from "../src/tx.ts";
import { attachExitSignature, buildUnsignedExit, type ExitPlan } from "../src/exit.ts";
import { RecipientSet } from "../src/recipients.ts";
import { agentPublicKey, signDigest, signSpend } from "../src/sign.ts";
import type { SpendPlan } from "../src/spend.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";
import { toWire, toWireMulti } from "../src/wire.ts";
import {
  attachReabsorbSignatures,
  buildUnsignedReabsorb,
  reabsorbSignatureScript,
  reabsorbSuccessorState,
  settleSignatureScript,
  type ReabsorbPlan,
} from "../src/reabsorb.ts";
import {
  attachDelegationSignature,
  buildUnsignedDelegation,
  childStateFrom,
  parentSuccessorState,
  pushChild,
  type DelegationPlan,
} from "../src/delegate.ts";
import { buildUnsignedSpend, spendSignatureScript } from "../src/spend.ts";

const here = (p: string) => new URL(p, import.meta.url);
const template: CovenantTemplate = JSON.parse(readFileSync(here("../covenant-template.json"), "utf8"));
const golden = JSON.parse(readFileSync(here("../golden-spend.json"), "utf8"));

const secret = fromHex(golden.key.secretHex);
const key = toHex(agentPublicKey(secret));
const recipients = new RecipientSet(golden.recipients.members.map((m: string) => fromHex(m)));
const target = fromHex(golden.recipients.target);
const authority = { principalKey: key, revocationKey: key };

const VALUE = 1_000_000_000n;
const EPOCH_LIMIT = 500_000_000n;

const base: GrantState = {
  agentKey: key,
  budgetTotal: VALUE,
  maxPerSpend: 200_000_000n,
  epochLimit: EPOCH_LIMIT,
  epochLength: 1000n,
  recipientsRoot: toHex(recipients.root),
  notBefore: 1_000_000n,
  expiresAt: 1_864_000n,
  delegationDepth: 2n,
  templateId: templateIdFor(template, authority),
  spentTotal: 0n,
  reserved: 0n,
  epochIndex: 0n,
  epochSpent: 0n,
  reserveRoot: EMPTY_RESERVE,
};

/** Epoch 5's allowance is entirely spent. */
const exhausted: GrantState = { ...base, epochIndex: 5n, epochSpent: EPOCH_LIMIT };
/** Epoch 5 with room left, so a same-epoch spend is legitimate. */
const headroom: GrantState = { ...base, epochIndex: 5n, epochSpent: 100_000_000n };

const utxo = {
  outpointTransactionId: fromHex("7d".repeat(32)),
  outpointIndex: 0,
  value: VALUE,
  blockDaaScore: 1_000_100n,
  isCoinbase: false,
  covenantId: fromHex(golden.utxo.covenantId),
};

function spend(state: GrantState, claimedDaa: bigint): SpendPlan {
  return {
    template,
    authority,
    state,
    utxo,
    amount: 200_000_000n,
    recipient: target,
    proof: recipients.proof(target),
    claimedDaa,
    fee: 1_000_000n,
    computeBudget: 16,
  };
}

function exit(fee: bigint): ExitPlan {
  return { kind: "revoke", template, authority, state: base, utxo, fee, computeBudget: 12, lockTime: 0n };
}


/**
 * Assembling a spend WITHOUT the SDK's guards.
 *
 * `buildUnsignedSpend` now refuses an epoch rewind and a past-expiry claim, so
 * asking it to build those probes gets a helpful error and no transaction —
 * and the engine, which is the thing under test, never sees them. An attacker
 * does not use our SDK. Neither should a probe.
 *
 * This duplicates a little of buildUnsignedSpend deliberately: the point is to
 * reach the covenant with bytes the SDK would not produce. Everything below
 * the guards is shared, so a change to the signature-script layout still
 * moves both.
 */
function unguardedSpend(state: GrantState, claimedDaa: bigint, amount: bigint) {
  const epochIndex = (claimedDaa - state.notBefore) / state.epochLength;
  const carried = epochIndex === state.epochIndex ? state.epochSpent : 0n;
  const next: GrantState = {
    ...state,
    spentTotal: state.spentTotal + amount,
    epochIndex,
    epochSpent: carried + amount,
    reserveRoot: EMPTY_RESERVE,
  };

  const scriptHash = (code: Uint8Array) => blake2b.create({ dkLen: 32 }).update(code).digest();
  const spk = (st: GrantState) =>
    payToScriptHashScript(scriptHash(bytecodeFor(template, { authority, state: st })));

  const entry = {
    value: utxo.value,
    scriptPublicKey: spk(state),
    blockDaaScore: utxo.blockDaaScore,
    isCoinbase: utxo.isCoinbase,
    covenantId: utxo.covenantId,
  };

  const sigScript = (signature: Uint8Array) => {
    const b = new ScriptBuilder();
    pushState(b, next);
    b.addI64(amount);
    b.addData(target);
    b.addData(concat(...recipients.proof(target).siblings));
    b.addData(Uint8Array.from(recipients.proof(target).left, (x) => (x ? 1 : 0)));
    b.addI64(claimedDaa);
    b.addData(signature);
    b.addData(dispatchTag("__covenant_entrypoint_auth_spend", SPEND_ARG_TYPES));
    b.addData(bytecodeFor(template, { authority, state }));
    return b.drain();
  };

  const tx = {
    version: 1,
    inputs: [
      {
        previousOutpoint: { transactionId: utxo.outpointTransactionId, index: utxo.outpointIndex },
        signatureScript: sigScript(new Uint8Array(65)),
        sequence: 0n,
        computeBudget: 16,
      },
    ],
    outputs: [
      {
        value: utxo.value - amount - 1_000_000n,
        scriptPublicKey: spk(next),
        covenant: { authorizingInput: 0, covenantId: utxo.covenantId },
      },
      { value: amount, scriptPublicKey: payToPubkeyScript(target) },
    ],
    lockTime: claimedDaa,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  const digest = sighash(tx, 0, entry);
  const signed = { ...tx, inputs: [{ ...tx.inputs[0]!, signatureScript: sigScript(signDigest(digest, secret)) }] };
  return { wire: toWire(signed, entry, "probe (unguarded)") };
}

const SPEND_ARG_TYPES = ["State", "int", "byte[32]", "byte[32][]", "bool[]", "int", "sig"];

/** `expect` is what the SCRIPT ENGINE must say, not what the SDK does. */
interface Probe {
  name: string;
  expect: "accept" | "refuse";
  why: string;
  build: () => { wire: unknown } | null;
}


// ---- settlement -----------------------------------------------------------
//
// A parent that has delegated 4 KAS to a child, and the child that received
// it. Both are needed for every probe below, and they must agree: the
// parent's reserveRoot is the child hashed onto an empty stack, which is what
// makes this child the one at the top and therefore the one that can be
// settled.

const CHILD_BUDGET = 400_000_000n;

const childTerms = {
  agentKey: toHex(agentPublicKey(fromHex("5c".repeat(32)))),
  budgetTotal: CHILD_BUDGET,
  maxPerSpend: 50_000_000n,
  epochLimit: 100_000_000n,
  delegationDepth: 1n,
};

/** The child at birth, and after it has spent 1 KAS of its own budget. */
const childBorn = childStateFrom(base, childTerms);
const childSpent: GrantState = { ...childBorn, spentTotal: 100_000_000n };

/** The parent AFTER delegating: reserve raised, child pushed onto the stack. */
const parentDelegated = parentSuccessorState(base, childBorn);

const parentUtxo = {
  outpointTransactionId: fromHex("a1".repeat(32)),
  outpointIndex: 0,
  value: VALUE - CHILD_BUDGET - 1_000_000n,
  blockDaaScore: 1_000_100n,
  isCoinbase: false,
  covenantId: fromHex(golden.utxo.covenantId),
};

/** The child's coin, less what it has spent and the fee that spend paid. */
const childUtxo = {
  outpointTransactionId: fromHex("b2".repeat(32)),
  outpointIndex: 0,
  value: CHILD_BUDGET - 100_000_000n - 1_000_000n,
  blockDaaScore: 1_000_200n,
  isCoinbase: false,
  covenantId: fromHex(golden.utxo.covenantId),
};

function reabsorbPlan(over: Partial<ReabsorbPlan> = {}): ReabsorbPlan {
  return {
    template,
    authority,
    parentState: parentDelegated,
    childState: childSpent,
    prevRoot: EMPTY_RESERVE,
    parentUtxo,
    childUtxo,
    fee: 1_000_000n,
    computeBudget: 32,
    ...over,
  };
}

function reabsorbWire(plan: ReabsorbPlan) {
  try {
    const u = buildUnsignedReabsorb(plan);
    const tx = attachReabsorbSignatures(
      plan,
      u,
      signDigest(u.parentSighash, secret),
      signDigest(u.childSighash, secret),
    );
    return { wire: toWireMulti(tx, u.entries, "probe") };
  } catch {
    return null;
  }
}

/**
 * `settle` on its own, with no parent anywhere in the transaction.
 *
 * The child is spent under `settle`, which needs only the revocation key. The
 * second input is an ordinary P2PK the revoker already controls, present only
 * because `settle` reads `tx.inputs[1].value`. Output 0 pays a plain P2PK the
 * REVOKER chose.
 *
 * If the engine accepts this, the revocation key is not a stop capability over
 * children — it is a TAKE capability, and the separation between revocationKey
 * and principalKey buys nothing for a delegated grant. That is the same shape
 * as the revoke-burn hole below it: a value check with no destination check.
 * `revoke` was fixed to constrain the destination; `settle` was written after
 * and constrains only the amount.
 */
/**
 * A settlement assembled WITHOUT the SDK's guards.
 *
 * `buildUnsignedReabsorb` refuses an out-of-order pop and a child with live
 * grandchildren, which is right for callers and useless for probes: the engine
 * — the thing actually under test — never sees the bytes. An attacker does not
 * use our SDK.
 *
 * Everything below the guards is shared with the real builder, so a change to
 * the signature-script layout still moves both.
 */
function unguardedReabsorb(plan: ReabsorbPlan) {
  const next = reabsorbSuccessorState(plan.parentState, plan.childState, plan.prevRoot);
  const scriptHashOf = (code: Uint8Array) => blake2b.create({ dkLen: 32 }).update(code).digest();
  const spk = (st: GrantState) =>
    payToScriptHashScript(scriptHashOf(bytecodeFor(template, { authority, state: st })));

  const entries = [
    {
      value: plan.parentUtxo.value,
      scriptPublicKey: spk(plan.parentState),
      blockDaaScore: plan.parentUtxo.blockDaaScore,
      isCoinbase: plan.parentUtxo.isCoinbase,
      covenantId: plan.parentUtxo.covenantId,
    },
    {
      value: plan.childUtxo.value,
      scriptPublicKey: spk(plan.childState),
      blockDaaScore: plan.childUtxo.blockDaaScore,
      isCoinbase: plan.childUtxo.isCoinbase,
      covenantId: plan.childUtxo.covenantId,
    },
  ];

  const tx = {
    version: 1,
    inputs: [
      {
        previousOutpoint: {
          transactionId: plan.parentUtxo.outpointTransactionId,
          index: plan.parentUtxo.outpointIndex,
        },
        signatureScript: reabsorbSignatureScript(plan, new Uint8Array(65)),
        sequence: 0n,
        computeBudget: plan.computeBudget,
      },
      {
        previousOutpoint: {
          transactionId: plan.childUtxo.outpointTransactionId,
          index: plan.childUtxo.outpointIndex,
        },
        signatureScript: settleSignatureScript(plan, new Uint8Array(65)),
        sequence: 0n,
        computeBudget: plan.computeBudget,
      },
    ],
    outputs: [
      {
        value: plan.parentUtxo.value + plan.childUtxo.value - plan.fee,
        scriptPublicKey: spk(next),
        covenant: { authorizingInput: 0, covenantId: plan.parentUtxo.covenantId },
      },
    ],
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  const signed = {
    ...tx,
    inputs: [
      {
        ...tx.inputs[0]!,
        signatureScript: reabsorbSignatureScript(plan, signDigest(sighash(tx, 0, entries[0]!), secret)),
      },
      {
        ...tx.inputs[1]!,
        signatureScript: settleSignatureScript(plan, signDigest(sighash(tx, 1, entries[1]!), secret)),
      },
    ],
  };
  return { wire: toWireMulti(signed, entries, "probe (unguarded)") };
}

function settleSteal() {
  const thiefKey = agentPublicKey(fromHex("7e".repeat(32)));
  const scriptHashOf = (code: Uint8Array) => blake2b.create({ dkLen: 32 }).update(code).digest();
  const childSpk = payToScriptHashScript(
    scriptHashOf(bytecodeFor(template, { authority, state: childSpent })),
  );

  // Any coin the revoker already owns. It is not a grant and carries no
  // covenant: settle reads only its VALUE.
  const decoy = {
    value: 1_000n,
    scriptPublicKey: payToPubkeyScript(thiefKey),
    blockDaaScore: 1_000_300n,
    isCoinbase: false,
    covenantId: undefined,
  };
  const childEntry = {
    value: childUtxo.value,
    scriptPublicKey: childSpk,
    blockDaaScore: childUtxo.blockDaaScore,
    isCoinbase: childUtxo.isCoinbase,
    covenantId: childUtxo.covenantId,
  };

  const plan = reabsorbPlan();
  const sigScript = (sig: Uint8Array) => settleSignatureScript(plan, sig);

  const tx = {
    version: 1,
    inputs: [
      {
        previousOutpoint: { transactionId: childUtxo.outpointTransactionId, index: childUtxo.outpointIndex },
        signatureScript: sigScript(new Uint8Array(65)),
        sequence: 0n,
        computeBudget: 16,
      },
      {
        previousOutpoint: { transactionId: fromHex("c3".repeat(32)), index: 0 },
        // Filled in below with a REAL P2PK signature. Left empty, this input
        // fails with InvalidStackOperation before `settle`'s semantics ever
        // decide anything — and the probe then reports a refusal that has
        // nothing to do with the attack it is supposed to be testing. The
        // engine validates every input now, so a decoy has to be spendable.
        signatureScript: new Uint8Array(0),
        sequence: 0n,
        computeBudget: 16,
      },
    ],
    // Everything, to an address of the revoker's choosing. No covenant
    // binding: the child is not continuing, it is being emptied.
    outputs: [
      {
        value: childUtxo.value + decoy.value - 1_000n,
        scriptPublicKey: payToPubkeyScript(thiefKey),
      },
    ],
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  const thiefSecret = fromHex("7e".repeat(32));
  const p2pkUnlock = (sig: Uint8Array) => new ScriptBuilder().addData(sig).drain();

  const signed = {
    ...tx,
    inputs: [
      { ...tx.inputs[0]!, signatureScript: sigScript(signDigest(sighash(tx, 0, childEntry), secret)) },
      { ...tx.inputs[1]!, signatureScript: p2pkUnlock(signDigest(sighash(tx, 1, decoy), thiefSecret)) },
    ],
  };
  return { wire: toWireMulti(signed, [childEntry, decoy], "probe (unguarded)") };
}


// ---- narrowing: who a child may pay ---------------------------------------
//
// The parent's allowlist has four members. `narrowed` is the pair {a4, target}
// — a subtree, so one node covers it and one sibling proves that node sits in
// the parent's tree. The child gets that node as its own recipientsRoot.
//
// The pair that matters is `narrowed-pays-inside` against
// `narrowed-pays-outside`: the same child, the same covenant, one paying a
// member of its own narrowed set and one paying a member of its PARENT's set
// that is not in its own. If both are accepted, narrowing is decoration.

const narrowedMembers = [recipients.members[2]!, recipients.members[3]!];
const narrowedSet = new RecipientSet(narrowedMembers);
const outsider = recipients.members[0]!;

const narrowTerms = {
  // Same key as the parent's agent, so these probes can sign the child's
  // spends. A real sub-agent has its own.
  agentKey: key,
  budgetTotal: CHILD_BUDGET,
  maxPerSpend: 50_000_000n,
  epochLimit: 100_000_000n,
  delegationDepth: 1n,
  recipients: narrowedMembers,
};

const narrowedChild = childStateFrom(base, narrowTerms, recipients);

function delegationPlan(over: Partial<DelegationPlan> = {}): DelegationPlan {
  return {
    template,
    authority,
    state: base,
    utxo,
    child: narrowTerms,
    recipients,
    fee: 1_000_000n,
    computeBudget: 24,
    ...over,
  };
}

function delegationWire(plan: DelegationPlan) {
  try {
    const u = buildUnsignedDelegation(plan);
    const tx = attachDelegationSignature(plan, u, signDigest(u.sighash, secret));
    return { wire: toWire(tx, u.entry, "probe") };
  } catch {
    return null;
  }
}

/** A spend by the narrowed child, to whoever is named. */
function narrowedChildSpend(recipient: Uint8Array, set: RecipientSet) {
  const childUtxoForSpend = {
    outpointTransactionId: fromHex("d4".repeat(32)),
    outpointIndex: 0,
    value: CHILD_BUDGET,
    blockDaaScore: 1_000_100n,
    isCoinbase: false,
    covenantId: fromHex(golden.utxo.covenantId),
  };
  try {
    const plan: SpendPlan = {
      template,
      authority,
      state: narrowedChild,
      utxo: childUtxoForSpend,
      amount: 50_000_000n,
      recipient,
      proof: set.proof(recipient),
      claimedDaa: 1_005_500n,
      fee: 1_000_000n,
      computeBudget: 16,
    };
    const u = buildUnsignedSpend(plan);
    const tx = { ...u.tx, inputs: [{ ...u.tx.inputs[0]!, signatureScript: spendSignatureScript(plan, signDigest(u.sighash, secret)) }] };
    return { wire: toWire(tx, u.entry, "probe") };
  } catch {
    return null;
  }
}

const probes: Probe[] = [
  {
    name: "epoch-exhausted",
    expect: "refuse",
    why: "the recorded epoch's allowance is spent; the control for the rewind below",
    build: () => wireOf(spend(exhausted, 1_005_500n)),
  },
  {
    name: "epoch-rewind",
    expect: "refuse",
    why:
      "THE EXPLOIT. claimedDaa is agent-supplied and bounded below only, so an " +
      "earlier epoch used to reset spentThisEpoch to zero and hand back the whole " +
      "allowance, repeatably. The per-epoch cap limited nothing.",
    build: () => unguardedSpend(exhausted, 1_004_500n, 200_000_000n),
  },
  {
    name: "epoch-forward",
    expect: "accept",
    why: "a LATER epoch legitimately carries a fresh allowance; the ratchet must not block it",
    build: () => wireOf(spend(exhausted, 1_007_500n)),
  },
  {
    name: "epoch-same-headroom",
    expect: "accept",
    why: "the recorded epoch with room left is an ordinary spend",
    build: () => wireOf(spend(headroom, 1_005_500n)),
  },
  {
    name: "past-expiry",
    expect: "refuse",
    why: "a claimedDaa at or beyond expiresAt. The spend path had no expiry check at all.",
    build: () => unguardedSpend(base, 1_900_000n, 200_000_000n),
  },
  {
    name: "delegate-narrowed",
    expect: "accept",
    why:
      "a delegation that narrows the child's allowlist to a subtree of the " +
      "parent's, with the witness proving that subtree sits in the parent's " +
      "tree. The control for the two below.",
    build: () => delegationWire(delegationPlan()),
  },
  {
    name: "narrowed-pays-inside",
    expect: "accept",
    why: "the narrowed child pays a member of its OWN set; narrowing must not break the legitimate case",
    build: () => narrowedChildSpend(recipients.members[3]!, narrowedSet),
  },
  {
    name: "narrowed-pays-outside",
    expect: "refuse",
    why:
      "THE POINT OF THE WITNESS. The narrowed child pays a member of its " +
      "PARENT'S allowlist that is not in its own. Before v4 a child inherited " +
      "the parent's root exactly, so this was an ordinary spend and delegation " +
      "could not scope counterparty at all. If the engine accepts it, narrowing " +
      "is decoration.",
    build: () => narrowedChildSpend(outsider, recipients),
  },
  {
    name: "reabsorb-honest",
    expect: "accept",
    why:
      "an ordinary settlement: the parent takes back the child at the top of " +
      "its reserve stack, releasing the child's budget and inheriting what the " +
      "child actually spent. The control for the three below.",
    build: () => reabsorbWire(reabsorbPlan()),
  },
  {
    name: "settle-steal",
    expect: "refuse",
    why:
      "THE SUSPECTED HOLE. `settle` requires the revocation key and checks that " +
      "output 0 receives inputs[0].value + inputs[1].value - maxFee, but it never " +
      "constrains output 0's scriptPubKey and nothing ties the second input to a " +
      "parent. So the revocation key alone, plus any dust it already owns, sweeps " +
      "a child's whole balance to an address of its choosing. If accepted, the " +
      "revocation key is a TAKE capability over children, not a STOP one.",
    build: () => settleSteal(),
  },
  {
    name: "reabsorb-live-grandchild",
    expect: "refuse",
    why:
      "the child still has 1 KAS reserved for a grandchild of its own. Settling " +
      "it releases the parent's reserve IN FULL while that coin sits in a " +
      "grandchild that nothing can ever reabsorb, because the only grant that " +
      "could — its parent — has just been consumed.",
    build: () =>
      unguardedReabsorb(
        reabsorbPlan({
          childState: { ...childSpent, reserved: 100_000_000n },
          // The parent committed to the child by its IMMUTABLE fields only, so
          // a child that has since delegated still matches the stack. That is
          // deliberate (a child must be able to spend), and it is exactly why
          // `reserved` needs its own check.
        }),
      ),
  },
  {
    name: "reabsorb-out-of-order",
    expect: "refuse",
    why:
      "reserveRoot is a hash chain, so only the most recently delegated child " +
      "can be popped. This settles the FIRST of two children while the second " +
      "is still outstanding, by claiming a prevRoot that does not rebuild the " +
      "parent's root.",
    build: () => {
      const second = childStateFrom(base, { ...childTerms, agentKey: toHex(agentPublicKey(fromHex("6d".repeat(32)))) });
      const twoDeep = {
        ...parentDelegated,
        reserved: parentDelegated.reserved + second.budgetTotal,
        reserveRoot: pushChild(parentDelegated.reserveRoot, second),
      };
      return unguardedReabsorb(reabsorbPlan({ parentState: twoDeep }));
    },
  },
  {
    name: "revoke-honest",
    expect: "accept",
    why: "an ordinary revoke, paying the principal and a normal fee",
    build: () => exitWire(exit(1_000_000n)),
  },
  {
    name: "revoke-burn",
    expect: "refuse",
    why:
      "1 sompi to the principal, the rest burned as fee. The exit paths checked " +
      "the output's scriptPubKey and never its value, which made the revocation " +
      "key a DESTROY capability rather than a STOP one.",
    build: () => exitWire(exit(VALUE - 1n)),
  },
];

function wireOf(plan: SpendPlan) {
  // The SDK refuses some of these itself now — that is the point of the guards
  // in spend.ts — so a probe it will not build is still written when possible
  // and reported when not.
  try {
    const { unsigned, tx } = signSpend(plan, secret);
    return { wire: toWire(tx, unsigned.entry, "probe") };
  } catch {
    return null;
  }
}

function exitWire(plan: ExitPlan) {
  try {
    const u = buildUnsignedExit(plan);
    const tx = attachExitSignature(plan, u, signDigest(u.sighash, secret));
    return { wire: toWire(tx, u.entry, "probe") };
  } catch {
    return null;
  }
}

const dir = new URL("../probes/", import.meta.url);
mkdirSync(dir, { recursive: true });

const manifest: { name: string; expect: string; why: string; sdkRefused: boolean }[] = [];
for (const p of probes) {
  const built = p.build();
  if (built) writeFileSync(new URL(`${p.name}.json`, dir), JSON.stringify(built.wire, null, 2) + "\n");
  manifest.push({ name: p.name, expect: p.expect, why: p.why, sdkRefused: !built });
  console.log(
    `${p.name.padEnd(22)} engine must ${p.expect.toUpperCase().padEnd(6)}` +
      `${built ? "" : "  (the SDK refuses to build it — checked in JS too)"}`,
  );
}
writeFileSync(new URL("probes.json", dir), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nwrote ${manifest.filter((m) => !m.sdkRefused).length} probes to probes/`);
console.log("judge them: cd ../covenant/deploy && cargo run -q -- probe");
