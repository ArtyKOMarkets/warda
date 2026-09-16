import type { ServiceManifest } from "./manifest.ts";

export interface Query {
  /** Must offer ALL of these. An agent asking for two things needs both. */
  capability?: string | string[];
  /** Decimal string in the asset's own units, compared as a number. */
  maxPrice?: string;
  network?: string;
  /** Substring match over name and description. The crude one, and labelled
   *  as such: it is here so a human on /network can filter, not so an agent
   *  can do semantic search. */
  q?: string;
}

/**
 * Matching, in one place.
 *
 * `/network` renders it, the HTTP service answers with it and the MCP tool
 * calls that service — so there is exactly one implementation of what "matches"
 * means. Three copies of this would be the sixth time in this repo that
 * extracted-then-copied cost something.
 *
 * Every filter is a CONJUNCTION and every one is optional. An empty query
 * returns everything, which is the right answer to "what is there?" and is how
 * /network lists.
 */
export function matches(m: ServiceManifest, q: Query): boolean {
  if (q.capability) {
    const want = Array.isArray(q.capability) ? q.capability : [q.capability];
    const have = new Set(m.capabilities.map((c) => c.toLowerCase()));
    if (!want.every((c) => have.has(c.toLowerCase()))) return false;
  }

  if (q.network && m.payment.network.toLowerCase() !== q.network.toLowerCase()) return false;

  if (q.maxPrice !== undefined) {
    const cap = Number(q.maxPrice);
    const price = Number(m.pricing.amount);
    /* A price that is not a number does not "cost zero" and must not sneak
       under a ceiling. An unparseable price fails the filter. */
    if (!Number.isFinite(cap) || !Number.isFinite(price)) return false;
    if (price > cap) return false;
  }

  if (q.q) {
    const hay = `${m.name} ${m.description}`.toLowerCase();
    if (!hay.includes(q.q.toLowerCase())) return false;
  }

  return true;
}

export function search<T extends ServiceManifest>(listings: T[], q: Query): T[] {
  return listings.filter((m) => matches(m, q));
}
