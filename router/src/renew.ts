/**
 * When a funding relationship needs its next grant.
 *
 * `plan.ts` and `exchange.ts` describe the moment an asset becomes KAS — the
 * expensive edge, crossed once per relationship rather than once per payment.
 * This is the other thing that happens at that edge, and it happens far more
 * often: a grant is a fixed budget, an agent that is working spends it, and
 * somebody has to issue the next one before it stops.
 *
 * Nothing here touches a chain or a wallet; it is the decision, so that the
 * decision can be wrong in a test rather than at 3am. `sdk/tools/topup.ts`
 * does the reading and `warda grant` does the creating.
 *
 * ## Two numbers end an agent, and the smaller one is the answer
 *
 * `budget - spent - reserved` is the authority left, and the network enforces
 * it. What the coin at the grant's address holds is the other, and no rule can
 * conjure more of it. They come apart in both directions — a grant funded with
 * less than its budget has authority it can never use, and one whose payments
 * were smaller than its fees can hold coin it is no longer authorised to move
 * — so taking either alone reports an agent as healthy in a state where it
 * cannot pay for anything.
 *
 * ## The threshold is not "empty"
 *
 * An agent stops being useful before it reaches zero: below its own
 * per-payment cap it can no longer make a payment of the size it was
 * authorised for, and every attempt from there on is a refusal. That is what
 * `below` is for, and why `sdk/tools/topup.ts` defaults it to the grant's own
 * `maxPerSpend` rather than to a number somebody picked.
 *
 * ## Enough, and enough in one coin
 *
 * Genesis takes a single input, so the largest grant a funder can create is
 * bounded by its biggest coin and not by its balance. A funder holding plenty
 * across many coins is a different problem from a funder holding too little,
 * and it has a different fix — `warda wallet consolidate` rather than a sale.
 * They are named separately here for the same reason `fund.ts` separates them:
 * the two look identical in a balance and the difference is somebody's night.
 */

/** A grant as the chain shows it, not as its manifest remembers it. */
export interface GrantReading {
  budgetTotal: bigint;
  spentTotal: bigint;
  reserved: bigint;
  /** What the coin at the grant's CURRENT address holds. */
  held: bigint;
  expiresAt: bigint;
}

/** The funder's ordinary key: what it could pay for the successor with. */
export interface FunderReading {
  /** The largest single mature, non-covenant coin. Genesis takes one input. */
  largest: bigint;
  /** Every such coin added up. Only ever used to explain the largest. */
  total: bigint;
}

export interface RenewInput {
  grant: GrantReading;
  funder: FunderReading;
  /** At or below this much left, a successor is due. */
  below: bigint;
  /** What the successor costs: its budget plus the genesis fee. */
  needed: bigint;
  /** The chain's virtual DAA score. */
  now: bigint;
}

export type RenewVerdict =
  | { due: false; left: bigint; stranded: bigint; expired: false }
  | { due: true; left: bigint; stranded: bigint; expired: boolean; fundable: true }
  | {
      due: true;
      left: bigint;
      stranded: bigint;
      expired: boolean;
      fundable: false;
      obstacle: "not-in-one-coin" | "short";
      /** How much more the funder needs IN ONE COIN. */
      shortBy: bigint;
    };

const max0 = (v: bigint): bigint => (v > 0n ? v : 0n);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** What the covenant would still permit, ignoring whether the coin is there. */
export function authorityLeft(g: GrantReading): bigint {
  return max0(g.budgetTotal - g.spentTotal - g.reserved);
}

/** What the agent can actually still pay: the smaller of the two limits. */
export function spendableLeft(g: GrantReading): bigint {
  return min(authorityLeft(g), max0(g.held));
}

export function renewVerdict(input: RenewInput): RenewVerdict {
  const { grant, funder, below, needed, now } = input;
  if (needed <= 0n) {
    throw new Error("needed must be positive: a successor with no budget is not a successor.");
  }
  if (below < 0n) throw new Error("below cannot be negative.");

  const left = spendableLeft(grant);
  const stranded = max0(grant.held);
  /* Expiry is not a threshold and does not compare to one. A grant past its
     term refuses every spend whatever its counters say, so the successor is
     due on that alone. */
  const expired = now >= grant.expiresAt;

  if (!expired && left > below) return { due: false, left, stranded, expired: false };

  if (funder.largest >= needed) return { due: true, left, stranded, expired, fundable: true };

  return {
    due: true,
    left,
    stranded,
    expired,
    fundable: false,
    obstacle: funder.total >= needed ? "not-in-one-coin" : "short",
    shortBy: needed - max0(funder.largest),
  };
}
