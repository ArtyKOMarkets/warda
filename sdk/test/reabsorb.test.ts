import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { toHex, fromHex } from "../src/bytes.ts";
import { childStateFrom, parentSuccessorState, pushChild } from "../src/delegate.ts";
import { EMPTY_RESERVE } from "../src/keys.ts";
import {
  buildUnsignedReabsorb,
  reabsorbSuccessorState,
  type ReabsorbPlan,
} from "../src/reabsorb.ts";
import { agentPublicKey } from "../src/sign.ts";
import { templateIdFor, type CovenantTemplate, type GrantState } from "../src/template.ts";

/**
 * Settlement is the only path where two covenants run in one transaction, and
 * the only one signed by two different keys. The engine has the last word —
 * `probes/reabsorb-honest.json` is the real check — but these pin the
 * arithmetic and the refusals, which is where a caller meets them.
 */

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);
const golden = JSON.parse(readFileSync(new URL("../golden-spend.json", import.meta.url), "utf8"));

const key = toHex(agentPublicKey(fromHex(golden.key.secretHex)));
const authority = { principalKey: key, revocationKey: key };

const parent: GrantState = {
  agentKey: key,
  budgetTotal: 1_000_000_000n,
  maxPerSpend: 200_000_000n,
  epochLimit: 500_000_000n,
  epochLength: 1000n,
  recipientsRoot: golden.params.recipientsRoot,
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

const terms = {
  agentKey: toHex(agentPublicKey(fromHex("5c".repeat(32)))),
  budgetTotal: 400_000_000n,
  maxPerSpend: 50_000_000n,
  epochLimit: 100_000_000n,
  delegationDepth: 1n,
};

const childBorn = childStateFrom(parent, terms);
const childNow: GrantState = { ...childBorn, spentTotal: 100_000_000n };
const delegated = parentSuccessorState(parent, childBorn);

const utxo = (tag: string, value: bigint) => ({
  outpointTransactionId: fromHex(tag.repeat(32)),
  outpointIndex: 0,
  value,
  blockDaaScore: 1_000_100n,
  isCoinbase: false,
  covenantId: fromHex(golden.utxo.covenantId),
});

function plan(over: Partial<ReabsorbPlan> = {}): ReabsorbPlan {
  return {
    template,
    authority,
    parentState: delegated,
    childState: childNow,
    prevRoot: EMPTY_RESERVE,
    parentUtxo: utxo("a1", 599_000_000n),
    childUtxo: utxo("b2", 299_000_000n),
    fee: 1_000_000n,
    computeBudget: 32,
    ...over,
  };
}

test("settling releases the reserve AND inherits what the child spent", () => {
  // The two moves are a pair. Releasing the reserve without charging the
  // child's spending would let the same authority be issued twice: delegate
  // 4 KAS, child spends it, settle, and the parent's budget is untouched
  // while 4 KAS has left the tree for good.
  const next = reabsorbSuccessorState(delegated, childNow, EMPTY_RESERVE);
  assert.equal(next.reserved, delegated.reserved - childNow.budgetTotal);
  assert.equal(next.spentTotal, delegated.spentTotal + childNow.spentTotal);
  assert.equal(next.reserveRoot, EMPTY_RESERVE);

  // A settlement is not a spend: no epoch allowance is consumed by it.
  assert.equal(next.epochIndex, delegated.epochIndex);
  assert.equal(next.epochSpent, delegated.epochSpent);
});

test("everything else about the parent stands still", () => {
  const next = reabsorbSuccessorState(delegated, childNow, EMPTY_RESERVE);
  const moves = new Set(["spentTotal", "reserved", "reserveRoot"]);
  for (const [k, v] of Object.entries(delegated)) {
    if (moves.has(k)) continue;
    assert.equal((next as unknown as Record<string, unknown>)[k], v, `${k} must not move`);
  }
});

test("both inputs' coin lands in the one continuation", () => {
  const p = plan();
  const built = buildUnsignedReabsorb(p);
  assert.equal(built.tx.inputs.length, 2);
  assert.equal(built.tx.outputs.length, 1);
  assert.equal(built.recovered, p.parentUtxo.value + p.childUtxo.value - p.fee);
  assert.equal(built.tx.outputs[0]!.value, built.recovered);

  // Output 0 is bound to the PARENT's input. The child authorises nothing —
  // that is how a covenant terminates rather than continuing.
  assert.equal(built.tx.outputs[0]!.covenant?.authorizingInput, 0);
});

test("the two inputs are signed under different keys, so the digests differ", () => {
  // Input 0 runs `reabsorb` under the parent's agent key; input 1 runs
  // `settle` under the revocation key. Signing one digest twice would produce
  // a transaction where one of the two checks cannot pass.
  const built = buildUnsignedReabsorb(plan());
  assert.notEqual(toHex(built.parentSighash), toHex(built.childSighash));
});

test("a child that is not on top of the stack is refused, and the message says why", () => {
  // reserveRoot is a hash chain: with two children outstanding, the second
  // must be settled first. Popping out of order cannot be made to verify, and
  // the engine agrees — probes/reabsorb-out-of-order.json.
  const second = childStateFrom(parent, {
    ...terms,
    agentKey: toHex(agentPublicKey(fromHex("6d".repeat(32)))),
  });
  const twoDeep: GrantState = {
    ...delegated,
    reserved: delegated.reserved + second.budgetTotal,
    reserveRoot: pushChild(delegated.reserveRoot, second),
  };
  assert.throws(() => buildUnsignedReabsorb(plan({ parentState: twoDeep })), /OUT OF ORDER/);
});

test("a child with live grandchildren is refused", () => {
  // The engine accepted this before the covenant gained `child.reserved == 0`:
  // the parent released the child's whole budget while that coin sat in
  // grandchildren nothing could ever reabsorb, the only grant that could
  // having just been consumed. Both sides check it now.
  assert.throws(
    () => buildUnsignedReabsorb(plan({ childState: { ...childNow, reserved: 100_000_000n } })),
    /grandchildren|reserved for children/,
  );
});

test("releasing more reserve than the parent holds is refused", () => {
  const thin: GrantState = { ...delegated, reserved: 1n };
  assert.throws(() => buildUnsignedReabsorb(plan({ parentState: thin })), /reserved/);
});
