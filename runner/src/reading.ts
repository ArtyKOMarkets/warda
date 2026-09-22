/**
 * A hosted agent's reading, in the same shape agents/tools/dashboard.ts
 * publishes for Warda's own agents — so the console's Overview, Grants,
 * Activity and agent pages treat a hosted agent exactly like any other.
 *
 * Built from the chain (the grant as it stands) and the runner's own records
 * (every run's payments, and the runner fees settled out of the grant). The
 * reconciliation counts both, because a fee settlement is a spend the
 * covenant sees; leaving it out would make the console report spending with
 * no receipt when the receipt is the runner's own ledger.
 */
import { formatKas } from "@warda_protocol/core";
import type { FeeLedger } from "./fees.ts";
import type { GrantView } from "./grant.ts";
import type { GrantRecord } from "./registry.ts";
import type { RunRecord } from "./store.ts";
import type { Workflow } from "./workflow.ts";

const k = (s: bigint) => `${formatKas(s)} KAS`;
/** A manifest field as sompi; a missing one reads as zero, never as a throw. */
const big = (v: unknown) => BigInt(typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ? v : 0);
const DAA_MS = 100;

function span(ms: number): string {
  const h = Math.max(0, Math.round(ms / 3_600_000));
  return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} hours` : `${Math.max(0, Math.round(ms / 60_000))} minutes`;
}

export function hostedReading(o: {
  agent: string;
  record: GrantRecord;
  view: GrantView | null;
  runs: RunRecord[];
  workflows: Workflow[];
  ledger: FeeLedger | null;
  genesisTxid?: string;
  now: number;
}): Record<string, unknown> {
  const m = o.record.manifest;
  const v = o.view;
  const urlOf = new Map(o.workflows.map((w) => [w.id, w]));
  const purchases: Record<string, unknown>[] = [];
  let logged = 0n;
  for (const r of [...o.runs].reverse()) {
    const wf = urlOf.get(r.workflowId);
    r.steps.forEach((s, i) => {
      if (s.action !== "pay-x402" && s.action !== "send") return;
      const act = wf?.actions[i];
      const sompi = s.sompi ? BigInt(s.sompi) : 0n;
      if (s.txid) logged += sompi;
      purchases.push({
        at: new Date(r.startedAt).toISOString(),
        outcome: s.status === "ok" ? (s.action === "send" ? "sent" : "bought") : s.status === "submitted" ? "paid, not served" : s.status,
        url: act && act.type === "pay-x402" ? act.url : null,
        task: wf?.name ?? r.trigger,
        reason: s.status === "ok" ? null : s.detail ?? null,
        txid: s.txid ?? null,
        paid: s.txid ? k(sompi) : null,
        amountSompi: s.txid ? String(sompi) : null,
        payTo: act && act.type === "send" ? act.to : null,
        refusal: s.status === "refused" ? s.detail ?? null : null,
      });
    });
  }
  const fees = o.ledger?.settled ?? 0n;
  const spent = v ? v.spentTotal : big(m.spent_total);
  const named = logged + fees;
  const unrecorded = spent > named ? spent - named : 0n;
  const expiresAtMs = v?.expiresAtMs ?? null;
  const expired = v ? v.status === "EXPIRED" : false;
  const left = expiresAtMs === null ? null : expiresAtMs - o.now;
  const firstJob = o.workflows.find((w) => !w.id.startsWith("mcp-"));
  return {
    _comment: "Built by the Warda runner from the chain and its own run log, in the shape agents/tools/dashboard.ts publishes.",
    checkedAt: new Date(o.now).toISOString(),
    network: "testnet-10",
    hosted: true,
    identity: {
      agentId: o.agent,
      agent: m.agent,
      principal: m.principal,
      revocation: m.revocation,
      grantAddress: v?.address ?? null,
      covenantId: m.covenant_id,
      template: m.covenant,
      ...(o.genesisTxid ? { genesisTxid: o.genesisTxid } : {}),
    },
    buysFrom: {
      endpoint: (() => {
        for (const w of o.workflows) for (const a of w.actions) if (a.type === "pay-x402") return a.url;
        return null;
      })(),
      payees: o.record.recipients.map((r) => ({ address: r })),
    },
    timelock: {
      notBefore: String(m.not_before),
      open: true,
      expiresAt: String(m.expires_at),
      expired,
      expiresInDaa: left === null ? null : String(Math.max(0, Math.round(left / DAA_MS))),
      expiresIn: left === null ? null : span(left),
      expiredAgo: expired && left !== null ? span(-left) : null,
      enforcedBy: "the covenant, on every spend",
    },
    authority: {
      budget: k(big(m.budget)),
      spent: k(spent),
      remaining: k(big(m.budget) - spent - (v?.reserved ?? 0n)),
      maxPerPayment: k(big(m.max_per_spend)),
      epochLimit: k(big(m.epoch_limit)),
      epochLengthDaa: Number(m.epoch_length),
      authorizedPayees: o.record.recipients.length,
      payees: v?.payees ?? o.record.recipients,
      delegationDepth: Number(m.delegation_depth ?? 0),
      onChain: v ? k(v.coin) : null,
    },
    activity: {
      payments: purchases.filter((p) => p.txid).length,
      paid: k(logged),
      paidOutsideTheAllowlist: "0 KAS",
      coins: [],
    },
    purchases,
    reconciliation: {
      spentPerTheCovenant: k(spent),
      namedByTheLog: k(named),
      chargedHomeBySettlement: null,
      unrecorded: k(unrecorded),
      overclaimedByTheLog: named > spent ? k(named - spent) : null,
      couldAccountForIt: [],
      note: fees > 0n
        ? `The log names every payment, and ${k(fees)} of runner fees settled out of the grant.`
        : "Every payment the covenant counted is named by a run the runner recorded.",
    },
    refusals: [
      { rule: "payee allowlist", attempted: "pay anyone not on the grant's list", refusal: "no transaction can pay an address the grant did not commit to", derived: true },
      { rule: "per-payment cap", attempted: `pay more than ${k(big(m.max_per_spend))} at once`, refusal: "the covenant refuses the spend", derived: true },
    ],
    mission: firstJob ? `Hosted by the Warda runner. ${firstJob.name}.` : "Hosted by the Warda runner.",
  };
}
