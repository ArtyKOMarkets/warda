import { createGrant, initialState } from "../src/grant.ts";
import { RecipientSet } from "../src/merkle.ts";
import { kas } from "../src/amounts.ts";
import type { Grant, GrantState } from "../src/types.ts";

export const hex32 = (b: number): string => b.toString(16).padStart(2, "0").repeat(32);

export const PRINCIPAL = hex32(0x11);
export const AGENT_A = hex32(0x22);
export const AGENT_B = hex32(0x33);
export const REVOKER = hex32(0x44);

export const SEARCH_API = hex32(0xa1);
export const DATA_API = hex32(0xa2);
export const COMPUTE_API = hex32(0xa3);
export const ATTACKER = hex32(0xee);

export const ALLOWED = new RecipientSet([SEARCH_API, DATA_API, COMPUTE_API]);

/** The grant from the spec worked example: 100 KAS, max 2, 10/epoch, 7 days. */
export function rootGrant(over: Partial<Grant> = {}): Grant {
  return createGrant({
    version: 1,
    parentId: null,
    principalKey: PRINCIPAL,
    agentKey: AGENT_A,
    revocationKey: REVOKER,
    assetId: "KAS",
    budgetTotal: kas("100"),
    maxPerSpend: kas("2"),
    epochLimit: kas("10"),
    epochLength: 1000n,
    recipientsRoot: ALLOWED.root,
    recipientsDepth: ALLOWED.depth,
    notBefore: 1_000_000n,
    expiresAt: 1_007_000n,
    delegationDepth: 2,
    nonce: hex32(0x01),
    ...over,
  } as Omit<Grant, "grantId">);
}

export function freshState(g: Grant): GrantState {
  return initialState(g);
}

/** Build a spend whose successor is exactly what the covenant expects.
 *  Attacks are produced by mutating the result of this. */
export function honestSpend(
  grant: Grant,
  state: GrantState,
  amount: bigint,
  recipient: string,
  daaScore: bigint,
) {
  const epochLength = grant.epochLength;
  const currentEpoch = (daaScore - grant.notBefore) / epochLength;
  const spentThisEpoch = currentEpoch === state.epochIndex ? state.epochSpent : 0n;
  return {
    grantId: grant.grantId,
    amount,
    recipient,
    recipientProof: ALLOWED.has(recipient)
      ? ALLOWED.proof(recipient)
      : { index: 0, siblings: [] },
    daaScore,
    successor: {
      grantId: grant.grantId,
      spentTotal: state.spentTotal + amount,
      reserved: state.reserved,
      epochIndex: currentEpoch,
      epochSpent: spentThisEpoch + amount,
      status: state.status,
    },
  };
}
