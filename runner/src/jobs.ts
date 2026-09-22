/**
 * The checks every job gets before it is saved, whoever wrote it — the owner
 * in the console, a sentence drafted by Claude, or the agent itself over MCP.
 * The covenant would refuse these at payment time anyway; saying so now turns
 * a job that could never work into a sentence instead of a string of refusals.
 */
import { formatKas } from "@warda_protocol/core";
import type { FeePolicy } from "./fees.ts";
import { feePayeeFor } from "./fees.ts";
import { memberKey } from "./grant.ts";
import type { GrantRecord } from "./registry.ts";
import { spends, type Workflow } from "./workflow.ts";

export function jobProblem(wf: Workflow, g: GrantRecord, fees: FeePolicy): string | null {
  const members = g.recipients.map(memberKey);
  if (spends(wf) && !feePayeeFor(fees, (a) => members.includes(memberKey(a)))) {
    return `this job spends, and ${wf.agent}'s grant cannot pay the runner's fee: ${fees.payee} is not on its allowlist. ` +
      `An allowlist is fixed when a grant is created, so this grant can run notify, http and approval jobs only.`;
  }
  const cap = BigInt(g.manifest.max_per_spend);
  for (const a of wf.actions) {
    if (a.type === "send" && !members.includes(memberKey(a.to))) {
      return `${a.to} is not on ${wf.agent}'s allowlist; no transaction can pay it`;
    }
    const amt = a.type === "send" ? a.sompi : a.type === "pay-x402" ? a.maxSompi : 0n;
    if (amt > cap) return `${formatKas(amt)} KAS is over the grant's per-payment cap of ${formatKas(cap)} KAS`;
  }
  return null;
}
