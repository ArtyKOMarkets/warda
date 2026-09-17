/**
 * Igra network parameters, and the decimal gap nobody mentions.
 *
 * Igra is a based rollup on Kaspa: KAS wraps 1:1 to iKAS across a bridge
 * backed by KAS locked on L1, and ordering is delegated to Kaspa miners. For
 * the router the important part is not the consensus design — it is that
 * **iKAS is an 18-decimal EVM token and KAS is 8-decimal sompi.**
 *
 * The wrap is 1:1 in value and 1:10^10 in representation. Ten orders of
 * magnitude is not a rounding detail; it is where money goes missing. Every
 * conversion below names the direction it rounds and why.
 *
 * Values are quoted from igra-labs.gitbook.io/igralabs-docs/quickstart/network-info.
 */

export interface IgraNetwork {
  readonly name: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly explorer: string;
  readonly nativeSymbol: "iKAS";
  readonly nativeDecimals: 18;
}

export const GALLEON_TESTNET: IgraNetwork = {
  name: "galleon-testnet",
  chainId: 38836,
  rpcUrl: "https://galleon-testnet.igralabs.com:8545",
  explorer: "https://explorer.galleon-testnet.igralabs.com",
  nativeSymbol: "iKAS",
  nativeDecimals: 18,
};

export const IGRA_MAINNET: IgraNetwork = {
  name: "igra-mainnet",
  chainId: 38833,
  rpcUrl: "https://rpc.igralabs.com:8545",
  explorer: "https://explorer.igralabs.com",
  nativeSymbol: "iKAS",
  nativeDecimals: 18,
};

/** KAS is 8-decimal. iKAS is 18-decimal. 1 sompi is this many iKAS wei. */
export const WEI_PER_SOMPI = 10n ** 10n;

function assertNonNegative(v: bigint, what: string): void {
  if (v < 0n) throw new Error(`${what} cannot be negative, got ${v}`);
}

/**
 * How many sompi arrive on L1 for a given amount of iKAS wei.
 *
 * Rounds **down**, because this answers "what will I receive" and an
 * overstated arrival is a shortfall discovered after the bridge. The
 * remainder is `bridgeDust` and does not cross.
 */
export function weiToSompi(wei: bigint): bigint {
  assertNonNegative(wei, "wei");
  return wei / WEI_PER_SOMPI;
}

/**
 * How many iKAS wei are needed to land exactly this many sompi.
 *
 * Exact, always: sompi is the coarser unit, so the conversion up loses
 * nothing. There is no rounding decision to make here and no silent one being
 * made.
 */
export function sompiToWei(sompi: bigint): bigint {
  assertNonNegative(sompi, "sompi");
  return sompi * WEI_PER_SOMPI;
}

/**
 * The part of an iKAS balance that cannot cross to L1, because it is smaller
 * than one sompi.
 *
 * Under 10^10 wei — a hundred-millionth of a KAS. Trivial per crossing and not
 * trivial as a surprise, which is why it is a function with a name rather than
 * a truncation inside another one.
 */
export function bridgeDust(wei: bigint): bigint {
  assertNonNegative(wei, "wei");
  return wei % WEI_PER_SOMPI;
}

/** Refuse a plan aimed at a chain the caller did not mean. */
export function assertChain(net: IgraNetwork, chainId: number): void {
  if (net.chainId !== chainId) {
    throw new Error(
      `this plan is for ${net.name} (chain ${net.chainId}) but the signer is on chain ` +
        `${chainId}. Igra mainnet is ${IGRA_MAINNET.chainId} and Galleon is ` +
        `${GALLEON_TESTNET.chainId}; they differ by three digits and one of them has real money on it.`,
    );
  }
}
