/**
 * Translation between the shape an agent framework finds natural and the
 * shape the protocol enforces.
 *
 * Everything here delegates to @warda_protocol/core. The MCP layer must never carry
 * its own copy of the rules: a server whose verdicts drift from the covenant's
 * is worse than no server at all, because it would tell an agent it may spend
 * when the chain will refuse — or, worse, that it may not when the chain would
 * allow it.
 */
import { RecipientSet } from "@warda_protocol/core";
import { createGrant, initialState, available } from "@warda_protocol/core";
import { kas, formatKas } from "@warda_protocol/core";
import type { Grant, GrantState } from "@warda_protocol/core";
import { EMPTY_RESERVE } from "@warda_protocol/kaspa";

export interface GrantDescriptor {
  agentKey: string;
  principalKey: string;
  revocationKey: string;
  budgetKas: string;
  maxPerSpendKas: string;
  epochLimitKas: string;
  epochLength: string;
  recipients: string[];
  notBefore: string;
  expiresAt: string;
  delegationDepth: number;
  nonce: string;
  state?: {
    spentTotalKas: string;
    reservedKas: string;
    epochIndex: string;
    epochSpentKas: string;
    /**
     * The LIFO stack of children this grant has outstanding, as a hash chain.
     *
     * Not derivable — it is history — so a grant that has delegated must state
     * it. Omitting it means "this grant has never delegated", which is the
     * common case and the only one a descriptor can safely assume. It is part
     * of the ADDRESS, so a wrong value here derives a grant that is not there.
     */
    reserveRoot?: string;
  };
}

export interface Materialised {
  grant: Grant;
  state: GrantState;
  set: RecipientSet;
  /** Carried separately: @warda_protocol/core's GrantState predates the covenant's
   *  reserve accumulator and has no field for it. */
  reserveRoot: string;
}

export function materialise(d: GrantDescriptor): Materialised {
  const set = new RecipientSet(d.recipients);
  const grant = createGrant({
    version: 1,
    parentId: null,
    principalKey: d.principalKey,
    agentKey: d.agentKey,
    revocationKey: d.revocationKey,
    assetId: "KAS",
    budgetTotal: kas(d.budgetKas),
    maxPerSpend: kas(d.maxPerSpendKas),
    epochLimit: kas(d.epochLimitKas),
    epochLength: BigInt(d.epochLength),
    recipientsRoot: set.root,
    recipientsDepth: set.depth,
    notBefore: BigInt(d.notBefore),
    expiresAt: BigInt(d.expiresAt),
    delegationDepth: d.delegationDepth,
    nonce: d.nonce,
  });
  const s = d.state;
  const state: GrantState = s
    ? {
        grantId: grant.grantId,
        spentTotal: kas(s.spentTotalKas),
        reserved: kas(s.reservedKas),
        epochIndex: BigInt(s.epochIndex),
        epochSpent: kas(s.epochSpentKas),
        status: "ACTIVE",
      }
    : initialState(grant);
  return { grant, state, set, reserveRoot: s?.reserveRoot ?? EMPTY_RESERVE };
}

export function headroom(m: Materialised, daaScore: bigint) {
  const { grant, state } = m;
  const avail = available(grant, state);
  const epochNow =
    daaScore >= grant.notBefore ? (daaScore - grant.notBefore) / grant.epochLength : 0n;
  const spentThisEpoch = epochNow === state.epochIndex ? state.epochSpent : 0n;
  const epochLeft = grant.epochLimit - spentThisEpoch;
  // The binding constraint is whichever is smallest right now — that is the
  // number an agent actually needs when deciding what it can afford.
  const largest = [avail, epochLeft, grant.maxPerSpend].reduce((a, b) => (a < b ? a : b));
  return {
    grantId: grant.grantId,
    availableKas: formatKas(avail),
    epochRemainingKas: formatKas(epochLeft > 0n ? epochLeft : 0n),
    maxPerSpendKas: formatKas(grant.maxPerSpend),
    largestPermittedSpendKas: formatKas(largest > 0n ? largest : 0n),
    currentEpoch: epochNow.toString(),
    expiresAtDaa: grant.expiresAt.toString(),
    recipients: m.set.recipients,
  };
}

export { formatKas, kas };
