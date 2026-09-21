/**
 * A funding plan: the steps that turn an asset into a funded grant, written
 * down so somebody else can sign them.
 *
 * **The router holds no key.** Every step that moves value is handed back
 * unsigned for the caller to sign and submit. That is not a limitation to be
 * engineered away later — it is the reason the router can sit next to a
 * protocol whose argument is that authority lives in consensus. A router that
 * signs is a router that can be compromised into signing, and the day it holds
 * the float its security story becomes a balance sheet.
 *
 * `custody: "none"` is therefore a field on every plan, present rather than
 * implied, for the same reason `authorisedToPayMe` is a field: a guarantee
 * nobody wrote down is a guarantee nobody can check.
 */

import { formatKas } from "@warda_protocol/core";
import type { Quote } from "./quote.ts";
import { verdict, type Hop, type Route, type RouteVerdict } from "./route.ts";
import { MIN_EXIT_SOMPI, assertPayoutAddress } from "./bridge.ts";

/**
 * Addresses a venue needs, supplied by the caller.
 *
 * Never hardcoded. An address typed from memory is an address that sends money
 * somewhere nobody checked, and there is no published, verified deployment to
 * copy for Galleon at the time of writing. Config makes the gap visible;
 * a constant would make it invisible and wrong.
 */
export interface VenueConfig {
  readonly name: string;
  readonly chainId: number;
  readonly addresses: Readonly<Record<string, string>>;
}

export type StepAction =
  /** The caller signs it. The router builds it and never holds the key. */
  | "sign-and-submit"
  /** Wait for something to land. Nothing after this is undone by retrying. */
  | "await-confirmation"
  /**
   * The person does it somewhere Warda cannot see — an exchange trade, a
   * withdrawal. Marked as its own action rather than dressed up as a step we
   * perform, because a rail that pretends to cover the part it cannot observe
   * is how a receipt ends up claiming more than happened.
   */
  | "off-protocol";

export interface Step {
  readonly index: number;
  /** The hop this step performs, so the route and the plan cannot disagree. */
  readonly hop: Hop;
  readonly action: StepAction;
  /** Whether everything needed to produce this step exists yet. */
  readonly ready: boolean;
  /**
   * What is missing, named exactly. A step that cannot be built says which
   * address or parameter it wanted, rather than producing something that looks
   * executable and is not.
   */
  readonly missing: readonly string[];
  /**
   * Constraints config cannot fix. `missing` is "supply this and it works";
   * a blocker is the world saying no, and the two should never be confused —
   * one is a TODO and the other is a redesign.
   */
  readonly blockers: readonly string[];
  /** Human-readable: what the signer is being asked to do. */
  readonly describe: string;
}

export interface FundingPlan {
  /** The conversion this plan was priced at. Attested, never enforced. */
  readonly quote: Quote;
  readonly route: Route;
  readonly verdict: RouteVerdict;
  readonly steps: readonly Step[];
  /** Always "none". The router never holds a key and never signs. */
  readonly custody: "none";
  /** True only when every step could be built and nothing blocks it. */
  readonly executable: boolean;
  /** Protocol constraints in the way, aggregated. */
  readonly blockers: readonly string[];
}

export interface FundingPlanInput {
  readonly quote: Quote;
  /** The asset being spent, and where it lives. */
  readonly from: { readonly asset: string; readonly layer: "igra" };
  /** The venue that swaps it to iKAS. */
  readonly venue?: VenueConfig;
  /** The bridge that takes iKAS to KAS on L1. */
  readonly bridge?: VenueConfig;
  /** Where the bridge should pay out on L1. Checked here, because it is not
   *  checked by the contract. */
  readonly payoutAddress?: string;
  /** Network prefix the payout address must belong to, e.g. "kaspatest". */
  readonly expectPrefix?: string;
}

function need(cfg: VenueConfig | undefined, what: string, keys: string[]): string[] {
  if (!cfg) return [`${what} config`];
  return keys.filter((k) => !cfg.addresses[k]).map((k) => `${what}.addresses.${k}`);
}

/**
 * Build the plan for `asset -> iKAS -> KAS -> genesis`.
 *
 * The genesis step is **last**, and that is the whole reason the funding side
 * is the clean side: nothing happens after the covenant, so the grant's
 * recipient is enforced. `verdict()` derives that rather than this function
 * asserting it — if the shape ever changes, the claim changes with it.
 */
export function planFunding(input: FundingPlanInput): FundingPlan {
  const { quote, from, venue, bridge, payoutAddress, expectPrefix } = input;

  /* Validated eagerly, and it throws rather than becoming a blocker: a bad
     payout address is not a plan with a problem, it is a plan that must not
     exist. The bridge checks only the prefix and the character set, so this is
     the only place a transposed character gets caught before the KAS is gone. */
  if (payoutAddress !== undefined) assertPayoutAddress(payoutAddress, expectPrefix);

  const swapHop: Hop = {
    kind: "swap",
    from: from.asset,
    to: "iKAS",
    layer: "igra",
    counterparty: venue?.name ?? "an unconfigured venue",
  };
  const bridgeHop: Hop = {
    kind: "bridge",
    from: "iKAS",
    to: "KAS",
    layer: "kaspa-l1",
    counterparty: bridge?.name ?? "an unconfigured bridge",
  };
  const genesisHop: Hop = {
    kind: "covenant",
    from: "KAS",
    to: "grant",
    layer: "kaspa-l1",
    counterparty: null,
  };

  const route: Route = { hops: [swapHop, bridgeHop, genesisHop] };

  const swapMissing = need(venue, "venue", ["router", "token"]);
  const bridgeMissing = need(bridge, "bridge", ["withdraw"]);
  if (payoutAddress === undefined) bridgeMissing.push("payoutAddress");

  /* The crossing, not the payment — and the LEAST that can arrive, not the
     expected amount. The bridge refuses to move less than a thousand KAS at a
     time, and what reaches it is whatever the swap produced, so the floor has
     to hold at the bottom of the slippage range. Checked against `sompi` this
     passed a crossing whose ordinary outcome cleared the floor and whose
     worst outcome was a revert. Two messages, because the fixes differ: below
     the floor even at the quoted rate means cross more; below it only after
     slippage means cross more OR accept less slippage. */
  const bridgeBlockers =
    quote.sompi < MIN_EXIT_SOMPI
      ? [
          `the bridge will not move ${formatKas(quote.sompi)} KAS: its minimum exit is 1,000 KAS, ` +
            `so this crossing would revert with ExitAmountBelowMinimum. Crossing is a treasury ` +
            `operation — cross once, fund many grants from what arrived.`,
        ]
      : quote.minSompi < MIN_EXIT_SOMPI
        ? [
            `at ${quote.slippageBps / 100}% slippage as little as ${formatKas(quote.minSompi)} KAS ` +
              `could arrive, under the bridge's 1,000 KAS minimum exit — the crossing would revert ` +
              `if the pool fills at the bottom of the range you allowed. Cross more, or accept ` +
              `less slippage.`,
          ]
        : [];

  const steps: Step[] = [
    {
      index: 0,
      hop: swapHop,
      action: "sign-and-submit",
      ready: swapMissing.length === 0,
      missing: swapMissing,
      blockers: [],
      /* KAS, not sompi. The rail in exchange.ts already holds itself to "no
         sompi in an instruction to a human", and its test says so; this rail
         did not, and it showed — the console rendered "worth at most
         200000000000 sompi" to somebody deciding whether to move money. */
      describe:
        `swap ${from.asset} for iKAS on ${venue?.name ?? "a venue"}, receiving ` +
        `${formatKas(quote.sompi)} KAS at the quoted rate and no less than ` +
        `${formatKas(quote.minSompi)} KAS`,
    },
    {
      index: 1,
      hop: bridgeHop,
      action: "sign-and-submit",
      ready: bridgeMissing.length === 0 && bridgeBlockers.length === 0,
      missing: bridgeMissing,
      blockers: bridgeBlockers,
      describe: `withdraw iKAS across ${bridge?.name ?? "the bridge"} to KAS on Kaspa L1`,
    },
    {
      index: 2,
      hop: bridgeHop,
      action: "await-confirmation",
      ready: true,
      missing: [],
      blockers: [],
      describe:
        "wait for the withdrawal to land on L1 — the crossing above is not reversible by " +
        "retrying it, and a stranded crossing is a support conversation, not a failed call",
    },
    {
      index: 3,
      hop: genesisHop,
      action: "sign-and-submit",
      ready: true,
      missing: [],
      blockers: [],
      describe: `genesis a grant from the arrived KAS, funded by a single input`,
    },
  ];

  return {
    quote,
    route,
    verdict: verdict(route),
    steps,
    custody: "none",
    executable: steps.every((s) => s.ready),
    blockers: bridgeBlockers,
  };
}

/** Everything a plan still needs before anybody could run it. */
export function missingFrom(plan: FundingPlan): readonly string[] {
  const out: string[] = [];
  for (const s of plan.steps) for (const m of s.missing) if (!out.includes(m)) out.push(m);
  return out;
}
