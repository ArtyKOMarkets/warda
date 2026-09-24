/**
 * What one job costs, and whether the network will carry it.
 *
 * Extracted from growth/tools/one-job.ts so a test can hold it. The numbers
 * here are the demonstration's terms, and the arithmetic below is the reason
 * they are what they are rather than something rounder.
 */
import { storageMass, type MassCell } from "../../sdk/src/mass.ts";


export interface Terms { budget: bigint; cap: bigint; epoch: bigint }
export interface Plan {
  parentBudget: bigint; parentMaxPerSpend: bigint; parentWindowDaa: bigint;
  research: Terms; verify: Terms; childWindowDaa: bigint;
}

/* Sompi. Each worker's per-payment cap is its seller's listed price to the
   sompi, so a worker cannot overpay even by mistake. The BUDGETS are not
   chosen for the job — they are chosen so the transaction that pays for it
   will be carried by the network. See the storage-mass pre-flight below. */
export const PLAN = {
  parentBudget: 80_000_000n,        // 0.8 KAS
  parentMaxPerSpend: 5_000_000n,
  parentWindowDaa: 2_592_000n,      // ~3 days at 10 blocks a second
  research: { budget: 25_000_000n, cap: 5_000_000n, epoch: 15_000_000n },  // Researcher: 0.05
  verify:   { budget: 22_000_000n, cap: 4_000_000n, epoch: 12_000_000n },  // Auditor: 0.04
  childWindowDaa: 864_000n,         // ~1 day: a worker's authority outlives the job by hours, not weeks
};

/* Kaspa refuses a transaction whose STORAGE mass exceeds this. It is not the
   covenant's rule and no grant term relaxes it: the ceiling is a property of
   the outputs a transaction creates, and a grant that pays out is a transaction
   that creates a small one. The first run of this script lost a genesis and two
   delegations to it — VERIFY held 0.12 KAS, its purchase massed 583,334, and
   the money never moved. Sizing is now checked before anything is built. */
export const MASS_CEILING = 500_000n;
export const DELEGATE_FEE = 1_900_000n;  // sdk/tools/build-delegation.ts
export const SPEND_FEE = 2_000_000n;     // x402/src/payer.ts
export const SETTLE_FEE = 3_500_000n;    // sdk/tools/build-settlement.ts

/* A grant's UTXO carries a 32-byte covenant binding on top of its P2SH script,
   which pushes it into a second storage unit and SQUARES its weight; a plain
   payee output stays in the first. Those two pluralities are all the mass
   arithmetic needs, so these stand in for the real scripts at the right
   lengths rather than being built. Checked against a real rejection: the
   numbers below reproduce the 583,334 the network quoted, exactly. */
export const grantCell = (v: bigint): MassCell =>
  ({ value: v, scriptPublicKey: { version: 0, script: new Uint8Array(35) }, hasCovenant: true });
export const payeeCell = (v: bigint): MassCell =>
  ({ value: v, scriptPublicKey: { version: 0, script: new Uint8Array(34) } });

/**
 * Every transaction this run will broadcast, massed before any of them exist.
 *
 * The rule that bites is not a floor under the PAYMENT — 0.04 KAS is far above
 * any dust limit and it was still refused. It is a floor under what the grant
 * has LEFT: mass counts 1/value over the outputs, so the successor grant is
 * what costs, and a nearly-empty grant is the expensive one. Paying 0.04 KAS
 * needs about 0.133 KAS in the child; paying 0.05 needs about 0.138.
 */
export function preflight(plan: Plan = PLAN): { step: string; mass: bigint }[] {
  const rows: { step: string; mass: bigint }[] = [];
  const p1 = plan.parentBudget - plan.research.budget - DELEGATE_FEE;
  rows.push({ step: "delegate research", mass: storageMass([grantCell(plan.parentBudget)], [grantCell(p1), grantCell(plan.research.budget)]) });
  const p2 = p1 - plan.verify.budget - DELEGATE_FEE;
  if (p2 <= 0n) throw new Error(`the coordinator cannot hold ${plan.verify.budget} sompi for the second hire: raise parentBudget.`);
  rows.push({ step: "delegate verify", mass: storageMass([grantCell(p1)], [grantCell(p2), grantCell(plan.verify.budget)]) });
  const c1 = plan.research.budget - plan.research.cap - SPEND_FEE;
  const c2 = plan.verify.budget - plan.verify.cap - SPEND_FEE;
  if (c1 <= 0n || c2 <= 0n) throw new Error("a worker's budget cannot cover its price plus the fee.");
  rows.push({ step: "buy research", mass: storageMass([grantCell(plan.research.budget)], [payeeCell(plan.research.cap), grantCell(c1)]) });
  rows.push({ step: "buy verify", mass: storageMass([grantCell(plan.verify.budget)], [payeeCell(plan.verify.cap), grantCell(c2)]) });
  const p3 = p2 + c2 - SETTLE_FEE;
  rows.push({ step: "settle verify", mass: storageMass([grantCell(p2), grantCell(c2)], [grantCell(p3)]) });
  rows.push({ step: "settle research", mass: storageMass([grantCell(p3), grantCell(c1)], [grantCell(p3 + c1 - SETTLE_FEE)]) });
  return rows;
}

