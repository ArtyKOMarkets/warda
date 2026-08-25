/**
 * The strongest structural claim in the protocol: authority is neither
 * created nor destroyed by delegation, only subdivided.
 *
 * Across any tree of grants, at any moment:
 *   sum(available) + sum(spent) == root.budgetTotal
 *
 * Deterministic PRNG so a failure is reproducible from the seed alone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateDelegation, validateSpend } from "../src/validate.ts";
import { createGrant, available, initialState } from "../src/grant.ts";
import { kas } from "../src/amounts.ts";
import type { Grant, GrantState } from "../src/types.ts";
import { rootGrant, honestSpend, ALLOWED, SEARCH_API, REVOKER, hex32 } from "./fixtures.ts";

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

interface Node { grant: Grant; state: GrantState }

function runTree(seed: number, steps: number): void {
  const rnd = lcg(seed);
  const root = rootGrant();
  const nodes: Node[] = [{ grant: root, state: initialState(root) }];
  let nonce = 0x10;

  for (let step = 0; step < steps; step++) {
    const i = Math.floor(rnd() * nodes.length);
    const node = nodes[i]!;
    const avail = available(node.grant, node.state);
    if (avail <= 0n) continue;

    const delegating = rnd() < 0.4 && node.grant.delegationDepth > 0;

    if (delegating) {
      const amount = (avail * BigInt(1 + Math.floor(rnd() * 60))) / 100n;
      if (amount <= 0n) continue;
      const child = createGrant({
        version: 1, parentId: node.grant.grantId,
        principalKey: node.grant.principalKey, agentKey: hex32(nonce),
        revocationKey: REVOKER, assetId: "KAS",
        budgetTotal: amount,
        maxPerSpend: node.grant.maxPerSpend,
        epochLimit: node.grant.epochLimit,
        epochLength: node.grant.epochLength,
        recipientsRoot: node.grant.recipientsRoot,
        recipientsDepth: node.grant.recipientsDepth,
        notBefore: node.grant.notBefore, expiresAt: node.grant.expiresAt,
        delegationDepth: node.grant.delegationDepth - 1,
        nonce: hex32(nonce++),
      });
      const v = validateDelegation(node.grant, node.state, {
        parentId: node.grant.grantId, child, daaScore: 1_000_500n,
        parentSuccessor: { ...node.state, reserved: node.state.reserved + amount },
      });
      if (!v.ok) continue;
      node.state = v.expectedSuccessor!;
      nodes.push({ grant: child, state: initialState(child) });
    } else {
      const amount = kas("0.5");
      if (amount > avail) continue;
      const v = validateSpend(
        node.grant, node.state,
        honestSpend(node.grant, node.state, amount, SEARCH_API, 1_000_500n),
      );
      if (!v.ok) continue;
      node.state = v.expectedSuccessor!;
    }

    // Invariant re-checked after every accepted transition.
    let totalAvailable = 0n;
    let totalSpent = 0n;
    for (const n of nodes) {
      totalAvailable += available(n.grant, n.state);
      totalSpent += n.state.spentTotal;
    }
    assert.equal(
      totalAvailable + totalSpent,
      root.budgetTotal,
      `seed ${seed} step ${step}: authority leaked (${nodes.length} grants)`,
    );
  }
}

test("conservation holds across randomised delegation trees", () => {
  for (let seed = 1; seed <= 40; seed++) runTree(seed, 60);
});

test("a delegated child cannot be over-drawn by its parent", () => {
  const parent = rootGrant();
  let ps = initialState(parent);
  const childBudget = kas("90");
  const child = createGrant({
    version: 1, parentId: parent.grantId, principalKey: parent.principalKey,
    agentKey: hex32(0x77), revocationKey: REVOKER, assetId: "KAS",
    budgetTotal: childBudget, maxPerSpend: kas("2"), epochLimit: kas("10"),
    epochLength: parent.epochLength, recipientsRoot: ALLOWED.root,
    recipientsDepth: ALLOWED.depth, notBefore: parent.notBefore,
    expiresAt: parent.expiresAt, delegationDepth: 1, nonce: hex32(0x78),
  });
  const d = validateDelegation(parent, ps, {
    parentId: parent.grantId, child, daaScore: 1_000_500n,
    parentSuccessor: { ...ps, reserved: childBudget },
  });
  assert.ok(d.ok, d.failures.join(", "));
  ps = d.expectedSuccessor!;

  // 10 KAS left to the parent. Five 2-KAS spends drain it; the sixth cannot
  // reach into the child's reserved 90.
  for (let i = 0; i < 5; i++) {
    const v = validateSpend(parent, ps, honestSpend(parent, ps, kas("2"), SEARCH_API, 1_000_000n + BigInt(i) * 1000n));
    assert.ok(v.ok, `parent spend ${i + 1}: ${v.failures.join(", ")}`);
    ps = v.expectedSuccessor!;
  }
  const overdraw = validateSpend(parent, ps, honestSpend(parent, ps, kas("2"), SEARCH_API, 1_005_000n));
  assert.equal(overdraw.ok, false);
  assert.ok(overdraw.failures.includes("EXCEEDS_AVAILABLE_BUDGET"));
});
