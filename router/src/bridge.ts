/**
 * KasExitBridge: the constraints it imposes, and the one check it does not do.
 *
 * From Igra's own developer guide, the exit call is
 *
 *     requestExit(string kasPayoutAddress, uint64 unlockAmountSompi) payable
 *       returns (uint32 requestId, bytes32 messageId)
 *
 * and `msg.value` must equal exactly `(unlockAmountSompi + feeAmountSompi) * 1e10`
 * wei. That 1e10 is the same WEI_PER_SOMPI this package already computes with,
 * which is a pleasant confirmation rather than a coincidence: it is 18 decimals
 * of iKAS over 8 of KAS.
 *
 * No address is hardcoded here. The mainnet proxy is published in their docs and
 * recorded in DESIGN.md; the Galleon deployment is not published at all. Both
 * arrive through VenueConfig, so a caller is never one typo away from pointing a
 * testnet-only project at mainnet.
 */

import { decodeAddress } from "@warda_protocol/kaspa";
import { WEI_PER_SOMPI } from "./igra.ts";

/**
 * The bridge refuses an exit below 1,000 KAS with `ExitAmountBelowMinimum`.
 *
 * This is the number that decides what the funding path is FOR. A grant funded
 * with a few KAS cannot be reached by crossing the bridge for it — the minimum
 * crossing is larger than the whole grant. So funding-side routing is a
 * treasury operation, crossed once and drawn down many times, and it is not a
 * way to turn five dollars of USDC into one small grant.
 */
export const MIN_EXIT_SOMPI = 100_000_000_000n;

/** What `msg.value` must be for a given exit. Exact; the bridge checks it. */
export function exitValueWei(unlockAmountSompi: bigint, feeAmountSompi: bigint): bigint {
  if (unlockAmountSompi < 0n || feeAmountSompi < 0n) {
    throw new Error("exit amounts cannot be negative");
  }
  return (unlockAmountSompi + feeAmountSompi) * WEI_PER_SOMPI;
}

/** `uint64` in the ABI, so an amount that will not fit is a revert, not a wrap. */
const UINT64_MAX = 2n ** 64n - 1n;

export function assertExitAmount(unlockAmountSompi: bigint): void {
  if (unlockAmountSompi < MIN_EXIT_SOMPI) {
    throw new Error(
      `this exit is ${unlockAmountSompi} sompi and the bridge's minimum is ${MIN_EXIT_SOMPI} ` +
        `(1,000 KAS). It would revert with ExitAmountBelowMinimum. Crossing is a treasury-sized ` +
        `operation: cross once, then fund grants from what arrived.`,
    );
  }
  if (unlockAmountSompi > UINT64_MAX) {
    throw new Error(`unlockAmountSompi is a uint64 and ${unlockAmountSompi} does not fit`);
  }
}

/**
 * Check the Kaspa payout address properly, because the bridge does not.
 *
 * Their guide is explicit that the contract "only checks prefix + charset" and
 * performs no bech32 checksum validation. So a transposed character is a valid
 * call to the contract and an irrecoverable payout to an address nobody holds.
 *
 * `decodeAddress` verifies the checksum. This is the single highest-value line
 * in the package: it is the difference between a typo being caught here and a
 * thousand KAS being gone.
 */
export function assertPayoutAddress(address: string, expectPrefix?: string): void {
  let decoded;
  try {
    decoded = decodeAddress(address);
  } catch (e) {
    throw new Error(
      `payout address does not verify: ${(e as Error).message}. The bridge would ACCEPT this — ` +
        `it checks only the prefix and the character set, not the checksum — and the KAS would ` +
        `be sent somewhere nobody holds the key to.`,
    );
  }
  if (expectPrefix && decoded.prefix !== expectPrefix) {
    throw new Error(
      `payout address is a ${decoded.prefix} address and this plan is for ${expectPrefix}. ` +
        `The bridge does not check which network an address belongs to either.`,
    );
  }
}
