/**
 * Turning a price into an amount, and being honest about what that answer is.
 *
 * A seller may price in dollars. A covenant cannot read dollars — it compares
 * sompi, because that is what Kaspa consensus can see. So a dollar price is a
 * QUOTE UNIT and never an authority unit, and the conversion between them is
 * something a named party asserted at a moment in time.
 *
 * Every value this module produces is therefore `attested`, never `enforced`.
 * See DESIGN.md. The one number here that touches the covenant is `maxSompi`,
 * and the rule for it is in `fitsUnderCap` below.
 */

import { SOMPI_PER_KAS } from "@warda_protocol/core";

/**
 * KIP-9 storage mass puts a floor of roughly 0.02 KAS under any payment. This
 * is consensus's answer, not the covenant's: below it there is no transaction
 * to broadcast at all. A dollar price does not know this number exists, which
 * is why a USD-priced listing has a KAS floor that moves with the market.
 */
export const STORAGE_MASS_FLOOR_SOMPI = 2_000_000n;

/**
 * What a statement rests on.
 *
 * - `enforced` — Kaspa consensus refused every alternative. Nobody can be
 *   wrong about it, because a transaction breaking it does not exist.
 * - `attested` — a named party signed a statement and can be held to it.
 * - `assumed`  — nobody proved it. It is a belief about the world.
 *
 * Nothing in this file is ever `enforced`.
 */
export type Zone = "enforced" | "attested" | "assumed";

/** A price as the seller stated it. `asset` is "KAS" or a quote asset. */
export interface Price {
  readonly asset: string;
  readonly amount: string;
}

/** A rate, as somebody said it. Not a fact about the world. */
export interface Rate {
  /** Units of `asset` that one KAS buys, as a decimal string. */
  readonly perKas: string;
  /** The asset this rate is against, e.g. "USD". */
  readonly asset: string;
  /** Who said it — a name a reader can go and ask. */
  readonly source: string;
  /** Unix milliseconds at which the source observed it. */
  readonly observedAt: number;
}

export interface QuoteInput {
  readonly price: Price;
  /** Required unless the price is already in KAS. */
  readonly rate?: Rate;
  /**
   * How far the executed price may drift from the quoted one, in basis
   * points. A quote with slippage is a RANGE; the covenant enforces a point.
   * `maxSompi` binds the worst case so the two can be compared honestly.
   */
  readonly slippageBps?: number;
  /** Unix milliseconds. A quote is a statement with a shelf life. */
  readonly expiresAt: number;
}

export interface Quote {
  readonly price: Price;
  /** The price converted at `rate`, rounded up. What you expect to pay. */
  readonly sompi: bigint;
  /**
   * The most this payment can cost once slippage is allowed.
   *
   * This — not `sompi` — is the number that must fit under a grant's
   * `maxPerSpend`. Checking the expected cost against the cap leaves a
   * payment that quotes inside the limit and executes outside it.
   */
  readonly maxSompi: bigint;
  /**
   * The LEAST that arrives once slippage is allowed — the other end of the
   * same range, for the other direction.
   *
   * `maxSompi` answers a buyer: the most a payment can cost. A funding
   * crossing is the opposite trade — you spend USDC and RECEIVE KAS — and
   * there slippage means getting less. `planFunding` used `maxSompi` anyway,
   * so the plan quoted the optimistic end as its bound and checked the
   * bridge's 1,000 KAS floor against the expected amount: a crossing that
   * cleared the floor on paper and slipped under it in the pool would be shown
   * as clear, and revert. Rounded down, because what arrives is never more
   * than the pool gave.
   */
  readonly minSompi: bigint;
  readonly slippageBps: number;
  /** `null` when the price was already in KAS and nothing was converted. */
  readonly rate: Rate | null;
  readonly expiresAt: number;
  /** Always `attested`. Present rather than omitted, so it cannot be assumed. */
  readonly zone: "attested";
}

/* Internal fixed-point scale. Money in floats is a defect, not a rounding
   detail, so every conversion below is integer arithmetic. */
const SCALE_DP = 18;
const SCALE = 10n ** BigInt(SCALE_DP);

function parseScaled(s: string, what: string): bigint {
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`${what} must be a non-negative decimal string, got ${JSON.stringify(s)}`);
  }
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > SCALE_DP) {
    throw new Error(`${what} has more than ${SCALE_DP} decimal places: ${s}`);
  }
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(SCALE_DP, "0") || "0");
}

/* Round up, everywhere and on purpose: a payment that rounds down is a payment
   a strict vendor refuses, and an understated ceiling is a cap that does not
   bind. Both errors cost more than the sompi they save. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Convert a price into sompi at a stated rate.
 *
 * Throws rather than returning a degraded answer: a quote that cannot be
 * honoured should fail where it is made, not where it is broadcast.
 */
export function quote(input: QuoteInput): Quote {
  const { price, rate, expiresAt } = input;
  const slippageBps = input.slippageBps ?? 0;

  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer in 0..10000, got ${slippageBps}`);
  }
  if (!Number.isFinite(expiresAt)) {
    throw new Error("expiresAt must be a unix-millisecond timestamp");
  }

  let sompi: bigint;
  let used: Rate | null;

  if (price.asset === "KAS") {
    /* Nothing was converted, so there is nothing to attest to. A rate passed
       here would be decoration, and decoration in a trust label is how a
       receipt starts lying. */
    if (rate) throw new Error("a KAS price needs no rate; pass one only when converting");
    sompi = ceilDiv(parseScaled(price.amount, "price.amount") * SOMPI_PER_KAS, SCALE);
    used = null;
  } else {
    if (!rate) {
      throw new Error(`price is in ${price.asset}, so a rate is required to reach sompi`);
    }
    if (rate.asset !== price.asset) {
      throw new Error(
        `rate is against ${rate.asset} but the price is in ${price.asset}; ` +
          `converting between them would be inventing a second rate nobody stated`,
      );
    }
    const rateScaled = parseScaled(rate.perKas, "rate.perKas");
    if (rateScaled === 0n) throw new Error("rate.perKas is zero; no amount of KAS buys anything");

    /* price / rate, both in the same asset, so the scale cancels. */
    const priceScaled = parseScaled(price.amount, "price.amount");
    sompi = ceilDiv(priceScaled * SOMPI_PER_KAS, rateScaled);
    used = rate;
  }

  const maxSompi = ceilDiv(sompi * BigInt(10_000 + slippageBps), 10_000n);
  const minSompi = (sompi * BigInt(10_000 - slippageBps)) / 10_000n;

  /* Against `sompi`, not `maxSompi`. The floor is about the transaction that
     actually gets built, and that is the expected amount. Checking the slippage
     ceiling instead would admit a quote whose ordinary outcome is unbroadcastable
     and which only clears the floor when the market moves against the buyer. */
  if (sompi < STORAGE_MASS_FLOOR_SOMPI) {
    throw new Error(
      `${price.amount} ${price.asset} converts to ${sompi} sompi, below Kaspa's ` +
        `~${STORAGE_MASS_FLOOR_SOMPI} sompi storage-mass floor. There is no transaction ` +
        `this small, so no buyer could pay it. A price denominated in ${price.asset} has a ` +
        `KAS floor that moves with the market; this listing has crossed it.`,
    );
  }

  return { price, sompi, maxSompi, minSompi, slippageBps, rate: used, expiresAt, zone: "attested" };
}

/** Why a quote cannot be paid from a particular grant. */
export interface CapVerdict {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Does this quote fit under a grant's per-payment cap?
 *
 * Compares `maxSompi`, never `sompi`. If a rate move puts a dollar-priced
 * service over the cap, the correct outcome is that the payment REFUSES. The
 * covenant is working. Widening the cap to fit the new rate would be the first
 * vulnerability in this system that was designed in rather than found.
 */
export function fitsUnderCap(q: Quote, maxPerSpendSompi: bigint): CapVerdict {
  if (q.maxSompi <= maxPerSpendSompi) return { ok: true };
  return {
    ok: false,
    reason:
      `this payment could cost up to ${q.maxSompi} sompi and the grant's cap is ` +
      `${maxPerSpendSompi}. The cap is in the coin and cannot be raised in place — ` +
      `a grant with a higher cap is a different address holding nothing.`,
  };
}

/** Has this quote passed its shelf life? */
export function isExpired(q: Quote, now: number = Date.now()): boolean {
  return now >= q.expiresAt;
}

function formatScaled(v: bigint): string {
  const whole = v / SCALE;
  const frac = (v % SCALE).toString().padStart(SCALE_DP, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * The other direction: I know how much KAS I need — what must I sell?
 *
 * Rounds **up**, for the mirror of the reason `quote` does: an understated
 * cost is a withdrawal that arrives short, and a grant funded a sompi under
 * its target is a grant that does not exist.
 *
 * `sompi` on the returned quote is the amount asked for, not a number derived
 * back from the rounded price — round-tripping a decimal through a rate twice
 * is how a figure drifts from the one the caller actually needs.
 */
export function quoteForSompi(input: {
  readonly sompi: bigint;
  readonly rate: Rate;
  readonly slippageBps?: number;
  readonly expiresAt: number;
}): Quote {
  const { sompi, rate, expiresAt } = input;
  const slippageBps = input.slippageBps ?? 0;

  if (sompi <= 0n) throw new Error(`sompi must be positive, got ${sompi}`);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be an integer in 0..10000, got ${slippageBps}`);
  }
  if (sompi < STORAGE_MASS_FLOOR_SOMPI) {
    throw new Error(
      `${sompi} sompi is below Kaspa's ~${STORAGE_MASS_FLOOR_SOMPI} sompi storage-mass floor; ` +
        `there is no transaction this small.`,
    );
  }

  const rateScaled = parseScaled(rate.perKas, "rate.perKas");
  if (rateScaled === 0n) throw new Error("rate.perKas is zero; no amount of KAS costs anything");

  const priceScaled = ceilDiv(sompi * rateScaled, SOMPI_PER_KAS);

  return {
    price: { asset: rate.asset, amount: formatScaled(priceScaled) },
    sompi,
    maxSompi: ceilDiv(sompi * BigInt(10_000 + slippageBps), 10_000n),
    minSompi: (sompi * BigInt(10_000 - slippageBps)) / 10_000n,
    slippageBps,
    rate,
    expiresAt,
    zone: "attested",
  };
}
