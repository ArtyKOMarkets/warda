/**
 * A route, and what may honestly be claimed about one.
 *
 * `provider/src/verify.ts` already carries the shape of the answer:
 * `authorisedToPayMe` is the string `"unknown"`, present rather than omitted,
 * because the x402 relay hop means the chain did not constrain who was
 * ultimately paid. A router is that problem with more hops across more layers,
 * so the honest answer is not a better guarantee — it is the same admission,
 * computed rather than remembered.
 *
 * The rule this file exists to enforce: **the covenant constrains the hop
 * immediately after it, and nothing further.** Everything a route does past
 * that point is somebody's promise.
 */

import type { Zone } from "./quote.ts";

/** Where a hop happens. L1 and Igra are different machines, and it matters. */
export type Layer = "kaspa-l1" | "igra" | "external";

export type HopKind =
  /** The covenant spend itself. Consensus refused every alternative. */
  | "covenant"
  /** Grant pays a key the agent holds, so the agent chooses what comes next. */
  | "relay"
  /** Value crosses layers. Somebody is holding the other side. */
  | "bridge"
  /** An asset becomes another asset at a venue, at a price nobody fixed. */
  | "swap"
  /** An ordinary payment from a key to an address. */
  | "transfer";

export interface Hop {
  readonly kind: HopKind;
  /** What goes in, named as a reader would name it: an asset, or "grant". */
  readonly from: string;
  /** What comes out. */
  readonly to: string;
  readonly layer: Layer;
  /**
   * Who can make this hop go wrong. `null` only where consensus refuses every
   * alternative — which in practice means the covenant hop and nothing else.
   */
  readonly counterparty: string | null;
}

export interface Route {
  readonly hops: readonly Hop[];
}

/** Which zone a hop's outcome sits in, derived from what the hop is. */
export function zoneOf(hop: Hop): Zone {
  if (hop.kind === "covenant") return "enforced";
  /* A relay or a transfer is somebody signing something they said they would
     sign. A bridge or a swap additionally depends on solvency and depth that
     nobody has proved and nobody can promise. */
  return hop.kind === "bridge" || hop.kind === "swap" ? "assumed" : "attested";
}

const RANK: Record<Zone, number> = { enforced: 2, attested: 1, assumed: 0 };

export interface RouteVerdict {
  /** The weakest zone on the route. A route is no stronger than this. */
  readonly zone: Zone;
  /**
   * Whether the party who ends up with the value is the party the covenant
   * approved. True only when nothing at all happens after the covenant hop.
   */
  readonly recipientEnforced: boolean;
  /** The same answer in the vocabulary `provider` already publishes. */
  readonly authorisedToPayMe: "yes" | "unknown";
  /** Everyone who can make this route go wrong, in the order they can. */
  readonly counterparties: readonly string[];
  /** Every layer touched. More than one means a bridge, whatever it is called. */
  readonly layers: readonly Layer[];
  /**
   * What the covenant still enforces no matter how many hops follow it. This
   * list does not shrink — it is the part that never stopped being true, and
   * saying it is how a weaker claim stays an honest one rather than a retreat.
   */
  readonly stillEnforced: readonly string[];
}

const ALWAYS_ENFORCED = [
  "budgetTotal",
  "maxPerSpend",
  "epochLimit",
  "notBefore/expiresAt",
  "delegationDepth",
] as const;

/** The covenant hops on a route. Exactly one is the only valid answer. */
function covenantIndices(route: Route): number[] {
  const out: number[] = [];
  route.hops.forEach((h, i) => {
    if (h.kind === "covenant") out.push(i);
  });
  return out;
}

/**
 * What may be claimed about this route.
 *
 * Throws on a route that is malformed rather than merely weak: no covenant
 * hop, or more than one. A route with two covenant spends is two payments
 * being described as one, and the claim that came out of it would be a
 * blend of two different grants' limits.
 */
export function verdict(route: Route): RouteVerdict {
  const hops = route.hops;
  if (hops.length === 0) throw new Error("a route with no hops moves nothing");

  const cov = covenantIndices(route);
  if (cov.length === 0) {
    throw new Error(
      "no covenant hop on this route: nothing here was authorised by a grant, " +
        "so there is no Warda claim to make about it",
    );
  }
  if (cov.length > 1) {
    throw new Error(
      `${cov.length} covenant hops on one route: that is ${cov.length} payments described ` +
        "as one, and any single verdict over them would blend different grants' limits",
    );
  }

  for (const h of hops) {
    if (h.kind === "covenant" && h.counterparty !== null) {
      throw new Error(
        `the covenant hop names ${h.counterparty} as a counterparty. If somebody can make ` +
          "it go wrong it is not the covenant hop — consensus refuses every alternative or " +
          "this is mislabelled",
      );
    }
    if (h.kind !== "covenant" && h.counterparty === null) {
      throw new Error(
        `a ${h.kind} hop with no counterparty: somebody is on the other side of it, and a ` +
          "receipt that cannot name them cannot be checked",
      );
    }
  }

  const covIdx = cov[0]!;
  /* The covenant constrains the hop immediately after it and nothing further.
     So the recipient is enforced only when the covenant hop is last. */
  const recipientEnforced = covIdx === hops.length - 1;

  let weakest: Zone = "enforced";
  for (const h of hops) {
    const z = zoneOf(h);
    if (RANK[z] < RANK[weakest]) weakest = z;
  }

  const counterparties: string[] = [];
  for (const h of hops) if (h.counterparty && !counterparties.includes(h.counterparty)) counterparties.push(h.counterparty);

  const layers: Layer[] = [];
  for (const h of hops) if (!layers.includes(h.layer)) layers.push(h.layer);

  return {
    zone: weakest,
    recipientEnforced,
    authorisedToPayMe: recipientEnforced ? "yes" : "unknown",
    counterparties,
    layers,
    stillEnforced: [...ALWAYS_ENFORCED],
  };
}

/** A claim somebody wants to publish about a route. */
export interface Claim {
  readonly recipientEnforced?: boolean;
  readonly zone?: Zone;
}

/**
 * Refuse a claim the route does not support.
 *
 * This is the whole point of the module. A receipt that overstates what
 * consensus saw is worse than no receipt: it is the failure the design
 * document was written to prevent, and it would be indistinguishable from a
 * working system right up until somebody checked.
 */
/**
 * The recipient check, in one place so no caller has to write the claim out as
 * a literal to ask for it. A literal in a call site is indistinguishable, to a
 * reader or a grep, from a literal in a receipt.
 */
function refuseIfRecipientUnenforced(route: Route): void {
  if (verdict(route).recipientEnforced) return;
  const after = route.hops.slice(covenantIndices(route)[0]! + 1).map((h) => h.kind);
  throw new Error(
    `this route claims the recipient was enforced, but ${after.length} hop(s) follow the ` +
      `covenant spend (${after.join(" -> ")}). Once value leaves the covenant the chain ` +
      "stops constraining where it lands. The honest field is authorisedToPayMe: \"unknown\".",
  );
}

/** Refuse a route whose final recipient the covenant did not constrain. */
export function assertRecipientEnforced(route: Route): void {
  refuseIfRecipientUnenforced(route);
}

export function assertClaimSupported(route: Route, claim: Claim): void {
  const v = verdict(route);
  if (claim.recipientEnforced === true) {
    refuseIfRecipientUnenforced(route);
  }
  if (claim.zone && RANK[claim.zone] > RANK[v.zone]) {
    throw new Error(
      `this route claims ${claim.zone} but its weakest hop is ${v.zone}. A route is no ` +
        "stronger than the least certain thing on it.",
    );
  }
}
