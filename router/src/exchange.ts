/**
 * The funding rail that needs no venue addresses: sell the asset you already
 * hold wherever you already hold it, withdraw KAS, and genesis a grant from it.
 *
 * This is the least infrastructure and the most custodial of the input-edge
 * options, and both halves of that are worth saying out loud. The exchange is
 * the counterparty; Warda is not, holds nothing, signs nothing, and cannot see
 * two of the four steps. The receipt says which two.
 *
 * It is also the version that works today. There is no published Zealous
 * deployment on Galleon, and `KasExitBridge` will not move less than 1,000 KAS
 * — neither of which matters here, because nothing crosses a bridge.
 */

import { formatKas } from "@warda_protocol/core";
import type { Quote } from "./quote.ts";
import { verdict, type Hop, type Route, type RouteVerdict } from "./route.ts";
import { assertPayoutAddress } from "./bridge.ts";
import type { Step, StepAction } from "./plan.ts";

export interface ExchangeFundingInput {
  /** What the buyer holds, and where they hold it. */
  readonly from: { readonly asset: string; readonly venue: string };
  /**
   * The grant they want. `feeSompi` is the network fee for the genesis
   * transaction, which comes out of the same coin.
   */
  readonly grant: { readonly budgetSompi: bigint; readonly feeSompi: bigint };
  /** What it costs in `from.asset`, at a rate somebody stated. */
  readonly quote: Quote;
  /** The funder address the withdrawal must land at. */
  readonly fundingAddress: string;
  /** Network prefix that address must belong to, e.g. "kaspatest". */
  readonly expectPrefix?: string;
}

export interface ExchangeFundingPlan {
  readonly quote: Quote;
  readonly route: Route;
  readonly verdict: RouteVerdict;
  readonly steps: readonly Step[];
  /** Always "none". Warda holds no key on this rail or any other. */
  readonly custody: "none";
  /** Sompi that must arrive, as ONE coin. See `singleInput` below. */
  readonly requiredSompi: bigint;
  /**
   * `genesis` is funded by a single input, so the largest grant a wallet can
   * issue is bounded by its biggest coin rather than its balance. An exchange
   * that splits a withdrawal into two payments funds nothing, and the person
   * doing it has no reason to expect that.
   */
  readonly singleInput: true;
}

function step(
  index: number,
  hop: Hop,
  action: StepAction,
  describe: string,
  missing: string[] = [],
): Step {
  return { index, hop, action, ready: missing.length === 0, missing, blockers: [], describe };
}

/**
 * Build the rail.
 *
 * Throws on a funding address that does not verify: the whole point of the
 * last two steps is that value lands somewhere recoverable, and an address
 * with a bad checksum is the one mistake nobody gets a second chance at.
 */
export function planExchangeFunding(input: ExchangeFundingInput): ExchangeFundingPlan {
  const { from, grant, quote, fundingAddress, expectPrefix } = input;

  assertPayoutAddress(fundingAddress, expectPrefix);
  if (grant.budgetSompi <= 0n) throw new Error("a grant with no budget authorises nothing");
  if (grant.feeSompi < 0n) throw new Error("fee cannot be negative");

  const requiredSompi = grant.budgetSompi + grant.feeSompi;

  const sellHop: Hop = {
    kind: "swap",
    from: from.asset,
    to: "KAS",
    layer: "external",
    counterparty: from.venue,
  };
  const withdrawHop: Hop = {
    kind: "transfer",
    from: "KAS",
    to: "KAS",
    layer: "external",
    counterparty: from.venue,
  };
  const genesisHop: Hop = {
    kind: "covenant",
    from: "KAS",
    to: "grant",
    layer: "kaspa-l1",
    counterparty: null,
  };

  const route: Route = { hops: [sellHop, withdrawHop, genesisHop] };

  const steps: Step[] = [
    step(
      0,
      sellHop,
      "off-protocol",
      `sell about ${quote.price.amount} ${quote.price.asset} for KAS on ${from.venue}. ` +
        `Warda cannot see this step and is not party to it.`,
    ),
    step(
      1,
      withdrawHop,
      "off-protocol",
      /* KAS, not sompi: a person about to move money reads the unit on their
         exchange screen, and a figure they have to convert is a figure they can
         mistype by a factor of a hundred million. */
      `withdraw ${formatKas(requiredSompi)} KAS to ${fundingAddress} in ONE withdrawal. ` +
        `A grant is funded by a single input, so two half-withdrawals fund nothing — ` +
        `the largest grant a wallet can issue is bounded by its biggest coin, not its balance.`,
    ),
    step(
      2,
      withdrawHop,
      "await-confirmation",
      `wait for a single coin of at least ${formatKas(requiredSompi)} KAS at that address`,
    ),
    step(
      3,
      genesisHop,
      "sign-and-submit",
      `genesis the grant from that coin, with the limits you asked for`,
    ),
  ];

  return {
    quote,
    route,
    verdict: verdict(route),
    steps,
    custody: "none",
    requiredSompi,
    singleInput: true,
  };
}
