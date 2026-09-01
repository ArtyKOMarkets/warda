/**
 * Emits vectors/vectors.json — the contract between this reference
 * implementation and any covenant that claims to implement Warda.
 *
 * A Silverscript covenant is correct when, for every vector, it reaches the
 * same accept/reject decision. Regenerate whenever the canonical encoding or
 * the hash function changes; every id in the file moves when they do.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSpend, validateDelegation } from "../src/validate.ts";
import { createGrant, initialState, encodeGrant, encodeState } from "../src/grant.ts";
import { RecipientSet } from "../src/merkle.ts";
import { toHex } from "../src/hash.ts";
import { kas, formatKas } from "../src/amounts.ts";
import type { Grant, GrantState, SpendRequest } from "../src/types.ts";

const hex32 = (b: number) => b.toString(16).padStart(2, "0").repeat(32);
const SEARCH = hex32(0xa1), DATA = hex32(0xa2), COMPUTE = hex32(0xa3), ATTACKER = hex32(0xee);
const SET = new RecipientSet([SEARCH, DATA, COMPUTE]);

const grant: Grant = createGrant({
  version: 1, parentId: null,
  principalKey: hex32(0x11), agentKey: hex32(0x22), revocationKey: hex32(0x44),
  assetId: "KAS",
  budgetTotal: kas("100"), maxPerSpend: kas("2"), epochLimit: kas("10"),
  epochLength: 1000n,
  recipientsRoot: SET.root, recipientsDepth: SET.depth,
  notBefore: 1_000_000n, expiresAt: 1_007_000n,
  delegationDepth: 2, nonce: hex32(0x01),
});

const s0 = initialState(grant);

function spend(amount: bigint, recipient: string, daa: bigint, mutate?: (r: SpendRequest) => void): SpendRequest {
  const epoch = (daa >= grant.notBefore) ? (daa - grant.notBefore) / grant.epochLength : 0n;
  const req: SpendRequest = {
    grantId: grant.grantId, amount, recipient,
    recipientProof: SET.has(recipient) ? SET.proof(recipient) : { index: 0, siblings: [] },
    daaScore: daa,
    successor: {
      grantId: grant.grantId, spentTotal: s0.spentTotal + amount, reserved: s0.reserved,
      epochIndex: epoch, epochSpent: amount, status: s0.status,
    },
  };
  mutate?.(req);
  return req;
}

const cases: { name: string; note: string; req: SpendRequest }[] = [
  { name: "honest_micropayment", note: "0.05 KAS to an allowlisted API", req: spend(kas("0.05"), SEARCH, 1_000_500n) },
  { name: "at_max_per_spend", note: "exactly at the cap, must be accepted", req: spend(kas("2"), SEARCH, 1_000_500n) },
  { name: "over_max_per_spend", note: "prompt-injected 20 KAS", req: spend(kas("20"), SEARCH, 1_000_500n) },
  { name: "unlisted_recipient", note: "attacker address not in the tree", req: spend(kas("1"), ATTACKER, 1_000_500n) },
  { name: "expired", note: "one DAA past expiry", req: spend(kas("1"), SEARCH, 1_007_000n) },
  { name: "before_not_before", note: "grant has not opened", req: spend(kas("1"), SEARCH, 999_999n) },
  { name: "zero_amount", note: "non-positive amount", req: spend(0n, SEARCH, 1_000_500n) },
  { name: "successor_budget_unchanged", note: "spends without recording the spend", req: spend(kas("2"), SEARCH, 1_000_500n, (r) => { r.successor.spentTotal = 0n; }) },
  { name: "successor_budget_inflated", note: "negative spent_total", req: spend(kas("2"), SEARCH, 1_000_500n, (r) => { r.successor.spentTotal = -kas("400"); }) },
  { name: "successor_epoch_forged", note: "claims a future epoch to dodge the limit", req: spend(kas("2"), SEARCH, 1_000_500n, (r) => { r.successor.epochIndex = 99n; }) },
];

const vectors = cases.map(({ name, note, req }) => {
  const v = validateSpend(grant, s0, req);
  return {
    name, note,
    daaScore: req.daaScore.toString(),
    amountSompi: req.amount.toString(),
    amountKas: formatKas(req.amount),
    recipient: req.recipient,
    expect: v.ok ? "ACCEPT" : "REJECT",
    failures: v.failures,
  };
});

const out = {
  $comment: "Warda protocol test vectors. Hash is a PLACEHOLDER — see src/hash.ts. Regenerate after swapping it.",
  version: 1,
  generatedFrom: "@warda_protocol/core reference implementation",
  grant: {
    grantId: grant.grantId,
    encodingHex: toHex(encodeGrant(grant)),
    budgetSompi: grant.budgetTotal.toString(),
    maxPerSpendSompi: grant.maxPerSpend.toString(),
    epochLimitSompi: grant.epochLimit.toString(),
    epochLength: grant.epochLength.toString(),
    notBefore: grant.notBefore.toString(),
    expiresAt: grant.expiresAt.toString(),
    delegationDepth: grant.delegationDepth,
  },
  recipients: { root: SET.root, depth: SET.depth, members: SET.recipients },
  initialState: { encodingHex: toHex(encodeState(s0)) },
  spendVectors: vectors,
};

const dir = dirname(fileURLToPath(import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "vectors.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${vectors.length} spend vectors`);
console.log(`  accept: ${vectors.filter((v) => v.expect === "ACCEPT").length}`);
console.log(`  reject: ${vectors.filter((v) => v.expect === "REJECT").length}`);
console.log(`  grant_id: ${grant.grantId}`);
