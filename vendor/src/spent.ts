/**
 * One payment, one delivery.
 *
 * Everything else here can be done with no memory at all: the quote carries
 * its own signature, and the chain remembers the payment. This cannot. A coin
 * sitting at your address is a fact that stays true, so a buyer who paid once
 * can present the same `X-PAYMENT` header a hundred times and every check in
 * `verify.ts` passes every time. The demo vendor this package was extracted
 * from has exactly that hole, and on a testnet demo it costs nothing; on a
 * priced API it is the whole business model.
 *
 * There is no clever stateless fix. The alternatives are worse or harder:
 * spending the coin onward makes delivery cost a transaction and a fee;
 * binding the payment to the request body is what kaspa-x402 v2 does and needs
 * both ends to implement it. What a seller actually needs is a set of
 * transaction ids it has already served, which is a database row.
 *
 * So this package asks for one rather than pretending it does not need it. The
 * interface is two methods so that a Redis SET, a unique index, a KV namespace
 * or a Map all satisfy it without an adapter.
 *
 * ## The default is memory, and it is not a store
 *
 * `inMemorySpent()` exists so the first five minutes work. It is per-process,
 * so under any host that runs more than one — every serverless platform, and
 * every deployment with two instances — a replayed payment lands on a process
 * that has not seen it and is served again. It says so in its own name and it
 * says so on startup. It is a placeholder for a decision, not a decision.
 */

export interface SpentStore {
  /** Has this transaction already been served? */
  has(txid: string): boolean | Promise<boolean>;
  /** Record that it has. Called only after the payment verified. */
  add(txid: string): void | Promise<void>;
}

/**
 * A per-process set. Correct on one long-lived instance, wrong everywhere else.
 *
 * The warning goes to stderr once, at construction, rather than on every
 * request: a line per paid call is a line nobody reads, and the decision this
 * is standing in for is made at deploy time.
 */
export function inMemorySpent(options: { quiet?: boolean } = {}): SpentStore {
  const seen = new Set<string>();
  if (!options.quiet) {
    console.error(
      "[warda/vendor] replay protection is IN MEMORY. It holds for one process only, so a " +
        "second instance — or the next cold start — will serve a replayed payment again. " +
        "Pass a shared `spent` store before charging anyone real money.",
    );
  }
  return {
    has: (txid) => seen.has(txid),
    add: (txid) => void seen.add(txid),
  };
}

/**
 * A store that permits replays, for a seller who has decided that is fine.
 *
 * Named for what it does rather than offered as `spent: undefined`, because
 * the difference between "I chose to allow replays" and "I did not think about
 * replays" should be visible in the source of whatever is deployed.
 */
export function replayAllowed(): SpentStore {
  return { has: () => false, add: () => {} };
}
