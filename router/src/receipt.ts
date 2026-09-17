/**
 * What a funded grant actually got, claim by claim.
 *
 * The rail ends here. A buyer who sold USDC on an exchange and withdrew KAS
 * has crossed two steps nobody can prove anything about and one that consensus
 * refused every alternative to, and the difference has to survive being
 * written down — otherwise the whole thing reads as "Warda moved my money",
 * which is neither true nor the claim worth making.
 *
 * Every line carries its zone and, where somebody could be wrong, their name.
 */

import type { Quote, Zone } from "./quote.ts";
import { assertRecipientEnforced, verdict, type Route, type RouteVerdict } from "./route.ts";

export interface GrantTerms {
  /** The address the grant lives at. A hash of its state, so it moves on spend. */
  readonly address: string;
  readonly budgetSompi: bigint;
  readonly maxPerSpendSompi: bigint;
  readonly epochLimitSompi: bigint;
  readonly expiresAtDaa: bigint;
  readonly delegationDepth: number;
}

export interface ReceiptClaim {
  readonly claim: string;
  readonly zone: Zone;
  /** Who can be wrong about it. `null` where nobody can. */
  readonly by: string | null;
}

export interface FundingReceipt {
  readonly grant: GrantTerms;
  readonly quote: Quote;
  readonly verdict: RouteVerdict;
  readonly claims: readonly ReceiptClaim[];
  /** Warda held no key at any point on this rail. */
  readonly custody: "none";
}

/**
 * Build the receipt.
 *
 * `assertClaimSupported` runs first, so a route that cannot carry the claims
 * below throws rather than producing a document that overstates it. That is
 * the one failure mode worth spending a guard on: a wrong receipt is
 * indistinguishable from a working system until somebody checks.
 */
export function fundingReceipt(
  route: Route,
  quote: Quote,
  grant: GrantTerms,
): FundingReceipt {
  const v = verdict(route);

  /* The grant is the last hop on a funding route, so its recipient IS
     enforced. If that ever stops being true this throws instead of lying. */
  assertRecipientEnforced(route);

  const counterparties = v.counterparties.join(", ") || "nobody";

  const claims: ReceiptClaim[] = [
    {
      claim: `this agent can never spend more than ${grant.budgetSompi} sompi in total`,
      zone: "enforced",
      by: null,
    },
    {
      claim: `no single payment can exceed ${grant.maxPerSpendSompi} sompi`,
      zone: "enforced",
      by: null,
    },
    {
      claim: `no epoch can exceed ${grant.epochLimitSompi} sompi`,
      zone: "enforced",
      by: null,
    },
    {
      claim: `its authority ends at DAA score ${grant.expiresAtDaa}`,
      zone: "enforced",
      by: null,
    },
    {
      claim: `it may delegate at most ${grant.delegationDepth} levels, each narrower than its parent`,
      zone: "enforced",
      by: null,
    },
    {
      claim: "it can only pay an address on the allowlist fixed at creation",
      zone: "enforced",
      by: null,
    },
    {
      claim:
        `the grant was funded at a rate of ${quote.rate?.perKas ?? "n/a"} ` +
        `${quote.rate?.asset ?? "KAS"} per KAS`,
      zone: "attested",
      by: quote.rate?.source ?? "the caller",
    },
    {
      claim: "the asset was sold and the KAS withdrawn as described",
      zone: "assumed",
      by: counterparties,
    },
  ];

  return { grant, quote, verdict: v, claims, custody: "none" };
}

/** The receipt as lines, strongest first, for a terminal or a page. */
export function formatReceipt(r: FundingReceipt): string[] {
  const order: Zone[] = ["enforced", "attested", "assumed"];
  const out: string[] = [];
  for (const zone of order) {
    const lines = r.claims.filter((c) => c.zone === zone);
    if (lines.length === 0) continue;
    out.push(`${zone}:`);
    for (const c of lines) {
      out.push(`  ${c.claim}${c.by ? `  — ${c.by}` : ""}`);
    }
  }
  return out;
}
