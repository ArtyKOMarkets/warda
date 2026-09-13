/**
 * The rulebook, against the covenant's actual constraints.
 *
 * Every refusal here is one the chain would also make. The point of testing
 * them offline is that the chain makes them in a script error, after a fee,
 * and usually about a hash — and an orchestrator that learns its limits one
 * failed broadcast at a time is an orchestrator nobody can run unattended.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RecipientSet, agentPublicKey, blake2b256, toHex, type GrantState } from "@warda_protocol/kaspa";
import { EMPTY_RESERVE } from "@warda_protocol/kaspa";
import { checkHire, checkSettle, hireTerms, uncommitted, type JobSpec, type Outstanding } from "../src/hiring.ts";

const key = (s: string) => toHex(agentPublicKey(blake2b256(new TextEncoder().encode(s))));

const SEARCH = key("growth-search");
const INFERENCE = key("growth-inference");
const GITHUB = key("growth-github");
const VENDOR = key("growth-vendor");
const STRANGER = key("somebody-else");
const MEMBERS = new RecipientSet([SEARCH, INFERENCE, GITHUB, VENDOR]);

const NOW = 569_000_000n;

const PARENT: GrantState = {
  agentKey: key("orchestrator"),
  budgetTotal: 500_000_000n,
  maxPerSpend: 20_000_000n,
  epochLimit: 100_000_000n,
  epochLength: 1_000n,
  recipientsRoot: toHex(MEMBERS.root),
  notBefore: NOW - 1_000n,
  expiresAt: NOW + 100_000n,
  delegationDepth: 2n,
  templateId: "00".repeat(32),
  spentTotal: 0n,
  reserved: 0n,
  epochIndex: 0n,
  epochSpent: 0n,
  reserveRoot: EMPTY_RESERVE,
};

function job(over: Partial<JobSpec> = {}): JobSpec {
  return {
    name: "scout",
    agentKey: key("scout-agent"),
    payee: SEARCH,
    budgetSompi: 50_000_000n,
    maxPerSpendSompi: 5_000_000n,
    ...over,
  };
}

test("a sane hire is permitted, and the child is one level shallower", () => {
  assert.deepEqual(checkHire(PARENT, MEMBERS, job(), NOW), []);
  const terms = hireTerms(PARENT, job(), NOW);
  assert.equal(terms.delegationDepth, 1n);
  assert.deepEqual(terms.recipients, [SEARCH]);
  // Inherited rather than invented: an unset epoch limit is the parent's.
  assert.equal(terms.epochLimit, PARENT.epochLimit);
  assert.equal(terms.expiresAt, undefined, "no window means inherit the parent's term");
});

/**
 * The finding that decides the whole topology.
 *
 * A child's allowlist is proved by a SUBTREE witness, and the set is sorted by
 * the hex of the key — so which payees sit together is decided by their key
 * material, not by the caller. One member always aligns. Two is luck.
 */
test("one payee is always expressible, whatever the keys happen to be", () => {
  for (const payee of [SEARCH, INFERENCE, GITHUB, VENDOR]) {
    assert.deepEqual(checkHire(PARENT, MEMBERS, job({ payee }), NOW), [],
      `a single-payee child should be expressible for every member (${payee.slice(0, 8)})`);
  }
});

test("a payee the parent cannot pay is refused, with the reason", () => {
  const [r] = checkHire(PARENT, MEMBERS, job({ payee: STRANGER }), NOW);
  assert.equal(r?.code, "not-in-allowlist");
  assert.match(r!.detail, /fixed at genesis/);
});

/** Conservation. The whole point of the reserve. */
test("a parent cannot hand over more than it has uncommitted", () => {
  const busy: GrantState = { ...PARENT, spentTotal: 100_000_000n, reserved: 300_000_000n };
  assert.equal(uncommitted(busy), 100_000_000n);
  assert.deepEqual(checkHire(busy, MEMBERS, job({ budgetSompi: 100_000_000n }), NOW), []);
  const [r] = checkHire(busy, MEMBERS, job({ budgetSompi: 100_000_001n }), NOW);
  assert.equal(r?.code, "over-uncommitted");
  // The arithmetic is in the message, because "insufficient funds" sends
  // somebody to look at a balance that is not the constraint.
  assert.match(r!.detail, /already reserved in outstanding children/);
});

test("a grant at depth 0 may spend and may not hire", () => {
  const leaf: GrantState = { ...PARENT, delegationDepth: 0n };
  const [r] = checkHire(leaf, MEMBERS, job(), NOW);
  assert.equal(r?.code, "no-depth-left");
});

test("every term may only shrink", () => {
  const cases: [Partial<JobSpec>, string][] = [
    [{ maxPerSpendSompi: 20_000_001n }, "cap-over-parent"],
    [{ epochLimitSompi: 100_000_001n }, "epoch-over-parent"],
    [{ windowDaa: 100_001n }, "window-outside-parent"],
  ];
  for (const [over, code] of cases) {
    const codes = checkHire(PARENT, MEMBERS, job(over), NOW).map((r) => r.code);
    assert.ok(codes.includes(code as never), `${JSON.stringify(Object.keys(over))} should give ${code}, got ${codes}`);
  }
});

test("a shorter window is allowed, and is the attenuation that needs nobody online", () => {
  assert.deepEqual(checkHire(PARENT, MEMBERS, job({ windowDaa: 5_000n }), NOW), []);
  assert.equal(hireTerms(PARENT, job({ windowDaa: 5_000n }), NOW).expiresAt, NOW + 5_000n);
});

/**
 * Every reason at once, not the first.
 *
 * An orchestrator that fixes one refusal per round trip against a chain takes
 * five blocks to learn what one function knew.
 */
test("all the reasons come back together", () => {
  const codes = checkHire(
    { ...PARENT, delegationDepth: 0n },
    MEMBERS,
    job({ payee: STRANGER, budgetSompi: 900_000_000n, maxPerSpendSompi: 30_000_000n }),
    NOW,
  ).map((r) => r.code).sort();
  assert.deepEqual(codes, ["cap-over-parent", "no-depth-left", "not-in-allowlist", "over-uncommitted"]);
});

// ---- LIFO ------------------------------------------------------------------

const child = (name: string): Outstanding => ({
  name,
  agentKey: key(`agent-${name}`),
  manifest: `${name}.json`,
  reservedSompi: "50000000",
  hiredAt: "2026-09-13T00:00:00Z",
});

test("the most recent child settles, and only that one", () => {
  const a = child("scout"), b = child("researcher");
  const stack = [a, b];
  assert.equal(checkSettle(stack, b.agentKey).ok, true);

  const refused = checkSettle(stack, a.agentKey);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /LIFO/);
  // Names the way out, because "not allowed" is not an instruction.
  assert.match(refused.detail, /Settle researcher first|Settle researcher, then/);
  assert.match(refused.detail, /let this one expire/);
});

test("settling what is not outstanding says so rather than failing on chain", () => {
  assert.match(checkSettle([child("scout")], key("agent-nobody")).detail, /already have been settled|expired/);
  assert.match(checkSettle([], key("agent-scout")).detail, /no children to settle/);
});
