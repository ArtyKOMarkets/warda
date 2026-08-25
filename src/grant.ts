import { hash, toHex, fromHex, u64, u32, utf8 } from "./hash.ts";
import type { Grant, GrantState, Hex } from "./types.ts";

/**
 * Canonical grant encoding. The covenant hashes exactly these bytes in
 * exactly this order — change the order and every grant_id changes.
 * Fixed-width fields only; no length prefixes, no optional fields.
 */
export function encodeGrant(g: Omit<Grant, "grantId">): Uint8Array {
  const assetBytes = utf8(g.assetId);
  if (assetBytes.length > 32) throw new Error(`assetId too long: ${g.assetId}`);
  const assetPadded = new Uint8Array(32);
  assetPadded.set(assetBytes);

  return concat([
    u32(g.version),
    g.parentId ? fromHex(g.parentId) : new Uint8Array(32),
    fromHex(g.principalKey),
    fromHex(g.agentKey),
    fromHex(g.revocationKey),
    assetPadded,
    u64(g.budgetTotal),
    u64(g.maxPerSpend),
    u64(g.epochLimit),
    u64(g.epochLength),
    fromHex(g.recipientsRoot),
    u32(g.recipientsDepth),
    u64(g.notBefore),
    u64(g.expiresAt),
    u32(g.delegationDepth),
    fromHex(g.nonce),
  ]);
}

/** Canonical state encoding — this is what the successor output commits to. */
export function encodeState(s: GrantState): Uint8Array {
  const statusByte = { ACTIVE: 0x01, REVOKED: 0x02, EXPIRED: 0x03 }[s.status];
  return concat([
    fromHex(s.grantId),
    u64(s.spentTotal),
    u64(s.reserved),
    u64(s.epochIndex),
    u64(s.epochSpent),
    new Uint8Array([statusByte]),
  ]);
}

export function deriveGrantId(g: Omit<Grant, "grantId">): Hex {
  return toHex(hash(utf8("warda:grant:v1"), encodeGrant(g)));
}

export function stateHash(s: GrantState): Hex {
  return toHex(hash(utf8("warda:state:v1"), encodeState(s)));
}

export function createGrant(g: Omit<Grant, "grantId">): Grant {
  assertWellFormed(g);
  return { ...g, grantId: deriveGrantId(g) };
}

export function initialState(grant: Grant): GrantState {
  return {
    grantId: grant.grantId,
    spentTotal: 0n,
    reserved: 0n,
    epochIndex: 0n,
    epochSpent: 0n,
    status: "ACTIVE",
  };
}

/** Authority still spendable by this agent: budget less spent less delegated. */
export function available(grant: Grant, state: GrantState): bigint {
  return grant.budgetTotal - state.spentTotal - state.reserved;
}

/**
 * A state that cannot be canonically encoded cannot be written into a
 * successor UTXO, so it can never equal the expected state. Returning false
 * rather than throwing matters: a covenant simply fails, and an SDK that
 * throws on hostile input hands an attacker a denial-of-service instead of a
 * rejection. Negative amounts reach here exactly this way.
 */
export function statesEqual(a: GrantState, b: GrantState): boolean {
  try {
    return stateHash(a) === stateHash(b);
  } catch {
    return false;
  }
}

function assertWellFormed(g: Omit<Grant, "grantId">): void {
  if (g.budgetTotal <= 0n) throw new Error("budgetTotal must be positive");
  if (g.maxPerSpend <= 0n) throw new Error("maxPerSpend must be positive");
  if (g.epochLimit <= 0n) throw new Error("epochLimit must be positive");
  if (g.epochLength <= 0n) throw new Error("epochLength must be positive");
  if (g.expiresAt <= g.notBefore) throw new Error("expiresAt must be after notBefore");
  if (g.delegationDepth < 0) throw new Error("delegationDepth must not be negative");
  // NOT an error: maxPerSpend above budgetTotal simply means the per-spend
  // cap never binds, because the budget binds first. Rejecting it would break
  // legitimate small delegations that inherit the parent's cap — a child with
  // a 0.5 KAS budget and an inherited 2 KAS cap is well-formed. Surface it as
  // an SDK warning if you like; it is not a protocol rule.
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
