/**
 * A manifest on disk is not a grant. This turns one into the other.
 *
 * The step that matters is the allowlist. A manifest commits to
 * `recipients_root` — a Merkle root — and not to the members, because the root
 * is what the address is derived from and the members are not recoverable from
 * it. So the caller brings the list, and the list is CHECKED against the root
 * rather than trusted.
 *
 * Getting that wrong is quiet in the worst way. A wrong list hashes to a
 * different root, which derives a different address, which holds nothing —
 * reported everywhere as "no UTXO", a message whose three causes do not
 * include "you passed the wrong payees". The check costs one hash and converts
 * that into a sentence.
 */
import {
  EMPTY_RESERVE,
  RecipientSet,
  decodeAddress,
  templateIdFor,
  toHex,
  type CovenantTemplate,
  type GrantState,
} from "@warda_protocol/kaspa";
import type { Manifest } from "./store.ts";

export interface LoadedGrant {
  template: CovenantTemplate;
  authority: { principalKey: string; revocationKey: string };
  state: GrantState;
  recipients: RecipientSet;
}

/** Addresses or bare hex payloads, the way every tool here accepts them. */
export function toRecipientSet(members: string[]): RecipientSet {
  return new RecipientSet(
    members
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean)
      .map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase())),
  );
}

export function toGrant(manifest: Manifest, members: string[], template: CovenantTemplate): LoadedGrant {
  const recipients = toRecipientSet(members);
  if (recipients.rootHex !== manifest.recipients_root) {
    throw new Error(
      `these recipients hash to ${recipients.rootHex}, but the grant commits to ` +
        `${manifest.recipients_root}. This is the wrong list for this grant.\n\n` +
        `A grant's address derives from that root, so continuing would look for the coin ` +
        `at an address nobody funded and report it as missing.`,
    );
  }

  const authority = {
    principalKey: manifest.principal,
    revocationKey: manifest.revocation ?? manifest.principal,
  };

  const state: GrantState = {
    agentKey: manifest.agent,
    budgetTotal: BigInt(manifest.budget),
    maxPerSpend: BigInt(manifest.max_per_spend),
    epochLimit: BigInt(manifest.epoch_limit),
    epochLength: BigInt(manifest.epoch_length),
    recipientsRoot: manifest.recipients_root,
    notBefore: BigInt(manifest.not_before),
    expiresAt: BigInt(manifest.expires_at),
    delegationDepth: BigInt(manifest.delegation_depth ?? 2),
    templateId: templateIdFor(template, authority),
    spentTotal: BigInt(manifest.spent_total ?? 0),
    reserved: BigInt(manifest.reserved ?? 0),
    epochIndex: BigInt(manifest.epoch_index ?? 0),
    epochSpent: BigInt(manifest.epoch_spent ?? 0),
    reserveRoot: manifest.reserve_root ?? EMPTY_RESERVE,
  };

  return { template, authority, state, recipients };
}
