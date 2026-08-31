import { blake2b } from "@noble/hashes/blake2.js";

import { HashWriter } from "./hashers.ts";
import { agentPublicKey } from "./sign.ts";
import { toHex } from "./bytes.ts";

/**
 * Deriving the keys a demo needs, and being explicit that a deployment should
 * not derive them at all.
 *
 * A grant names three powers, and they are three DIFFERENT powers:
 *
 *   agentKey       spends, within the limits
 *   revocationKey  stops the grant, at any moment, and receives nothing
 *   principalKey   receives the balance on revoke or reclaim
 *
 * Collapsing them into one key is what makes a demo runnable from one file,
 * and it quietly voids the design. The separation is not decoration: `revoke`
 * pays the PRINCIPAL rather than its own signer precisely so a monitor can be
 * given the power to stop a grant without being trusted with its balance —
 * and until v3 that promise was false anyway, because the monitor could burn
 * the coin to fees. Having fixed that, the tooling should let the separation
 * actually be expressed.
 *
 * In production each holder generates its own secret and publishes only the
 * x-only half. Nobody derives anybody else's key, and no single secret can
 * reconstruct the others — which is the entire point.
 *
 * These derivations exist so the demo can be re-run from one key without
 * writing secrets to disk. Every manifest records which domain and index a key
 * came from, so a key derived here can be found again, and a key that was NOT
 * derived is recorded as such and cannot be silently regenerated.
 */

/**
 * Domain separation matters here. Without it the same parent secret at index 0
 * would produce the same key for a top-level agent and for a sub-agent, and a
 * grant would be spendable by a sibling that was never meant to reach it.
 */
export const KEY_DOMAIN = {
  /** A grant's own agent, derived from the funder's key. */
  agent: "WardaAgent",
  /** A child grant's agent, derived from its parent's. */
  subAgent: "WardaSubAgent",
} as const;

export type KeyDomain = (typeof KEY_DOMAIN)[keyof typeof KEY_DOMAIN];

/** Where a key came from, as a manifest records it. */
export interface Derivation {
  domain: KeyDomain;
  index: number;
}

export function deriveSecret(parentSecret: Uint8Array, domain: KeyDomain, index: number): Uint8Array {
  if (parentSecret.length !== 32) throw new Error("a secret key is 32 bytes");
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, index, true);
  // Keyed rather than plain: the domain is the key, so the same parent secret
  // cannot collide across roles.
  return HashWriter.blake2b(domain).update(parentSecret).update(idx).digest();
}

export function derivePublic(parentSecret: Uint8Array, domain: KeyDomain, index: number): string {
  return toHex(agentPublicKey(deriveSecret(parentSecret, domain, index)));
}

/**
 * Finds the secret that controls `wantXOnly`, given one secret in hand and
 * whatever derivations a manifest recorded.
 *
 * Returns null rather than throwing, because "this key is not derivable from
 * what you hold" is the NORMAL answer for a properly separated deployment —
 * the sub-agent runs its own tooling with its own secret. A caller that gets
 * null should say so plainly rather than treating it as an error in the key.
 */
export function resolveSigner(
  provided: Uint8Array,
  wantXOnly: string,
  hint?: Derivation | null,
): { secret: Uint8Array; how: string } | null {
  if (toHex(agentPublicKey(provided)) === wantXOnly) {
    return { secret: provided, how: "the key provided" };
  }
  const attempts: Derivation[] = hint
    ? [hint]
    : // No hint: try both domains at index 0, which covers a manifest written
      // before derivations were recorded. Anything beyond that is guessing,
      // and guessing at keys is how a tool signs with the wrong one.
      [
        { domain: KEY_DOMAIN.agent, index: 0 },
        { domain: KEY_DOMAIN.subAgent, index: 0 },
      ];
  for (const a of attempts) {
    const secret = deriveSecret(provided, a.domain, a.index);
    if (toHex(agentPublicKey(secret)) === wantXOnly) {
      return { secret, how: `derived (${a.domain}, index ${a.index})` };
    }
  }
  return null;
}

/**
 * The empty delegation stack.
 *
 * NOT thirty-two zero bytes. Kaspa script encodes the value zero as the EMPTY
 * byte string, so a zero literal inside the covenant compiles to nothing and
 * the comparison silently tests against an empty push rather than a 32-byte
 * array. The covenant already documented that trap for its Merkle domain
 * separators, and the v4 delegation vector was rejected by the engine until it
 * was fixed here too. Derived on both sides rather than written out.
 */
export const EMPTY_RESERVE = toHex(
  blake2b.create({ dkLen: 32 }).update(new TextEncoder().encode("WardaEmptyReserve")).digest(),
);
