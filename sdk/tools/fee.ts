/**
 * Let the node price the transaction, because this SDK cannot.
 *
 * Kaspa's minimum relay fee is proportional to mass, and nothing here computes
 * mass. Every fee in these tools is therefore a constant somebody measured
 * once, and this repository has now shipped that mistake three separate times:
 *
 *   - `build-exit.ts` carried an ordinary transfer's 1,000,000 and the first
 *     real revoke was refused, needing 1,437,200 for a mass of 14,372.
 *   - `consolidate.ts` guessed 8,220 mass for seven inputs; the real figure
 *     was 9,746, and the first submit was refused.
 *   - the same constants are still in three more tools, none of which has ever
 *     been rejected only because none of them has been run often enough.
 *
 * A default that is wrong only at broadcast survives any amount of offline
 * verification. `cargo run -- verify` accepts a transaction no node will
 * relay, because a fee is not part of the shape a script engine checks.
 *
 * So: submit, and if the node names the figure it wanted, rebuild at that
 * figure and submit again. The estimate stops having to be right and only has
 * to be close, and being wrong becomes a printed line rather than a failure.
 *
 * ## Why it retries only on a fee rejection, never on any error
 *
 * A rejected transaction changed nothing, so rebuilding is safe. A submit that
 * TIMED OUT may well have been accepted, and retrying that one would be a
 * second spend of the same UTXO — harmless in the end, because the node
 * refuses it as already-spent, but it turns a network hiccup into a confusing
 * double failure. So the retry fires only when the node has said, in words,
 * that the fee was too small. Anything else is re-thrown untouched.
 */
import type { Transaction } from "@warda_protocol/kaspa";

/**
 * The figure the node asked for, or null if it did not name one.
 *
 * kaspad's message is specific and worth matching exactly rather than
 * scavenging for the largest number in it:
 *
 *   "transaction X is not standard: transaction has 822000 fees which is under
 *    the required amount of 974600 for compute mass 9746"
 *
 * A looser parser would find a figure in messages that are not about fees at
 * all — an amount, a DAA score, a txid fragment — and rebuild a transaction to
 * satisfy a rule nobody stated. Better to fail than to guess: an unparsed
 * message is re-thrown with its own words intact, which is what an operator
 * needs anyway.
 */
export function requiredFeeFrom(message: string): bigint | null {
  const m = /required amount of (\d+)/i.exec(message);
  if (m) return BigInt(m[1]!);
  // Older and alternative phrasings seen in the wild, still fee-specific.
  const alt = /(?:minimum|min)\s+(?:relay\s+)?fee(?:\s+of)?\s+(\d+)/i.exec(message);
  return alt ? BigInt(alt[1]!) : null;
}

/** True when a rejection is about the fee, rather than about anything else. */
export function isFeeRejection(message: string): boolean {
  return /fee/i.test(message) && requiredFeeFrom(message) !== null;
}

export interface Submitter {
  submitTransaction(tx: Transaction, allowOrphan?: boolean): Promise<string>;
}

export interface Corrected {
  txid: string;
  /** What was actually paid — the estimate, or the node's figure. */
  fee: bigint;
  /** Whether the first attempt was refused and rebuilt. */
  corrected: boolean;
  /** The transaction that was accepted, which may not be the one passed in. */
  tx: Transaction;
}

/**
 * Submit, and pay what the node asks if it refuses the estimate.
 *
 * `rebuild` must produce a fully signed transaction at the given fee. It is
 * called at most once, and only after a rejection that named a required
 * figure — so a caller whose rebuild is expensive pays for it only when the
 * estimate was wrong.
 */
export async function submitCorrectingFee(opts: {
  client: Submitter;
  tx: Transaction;
  fee: bigint;
  rebuild: (fee: bigint) => Transaction;
  /** Printed when a correction happens, e.g. "a revoke". */
  what?: string;
}): Promise<Corrected> {
  const { client, tx, fee, rebuild } = opts;
  try {
    return { txid: await client.submitTransaction(tx), fee, corrected: false, tx };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    const wanted = requiredFeeFrom(message);
    if (wanted === null || wanted <= fee) throw e;

    console.error(
      `\nthe node refused that fee and named ${wanted} sompi. Rebuilding${
        opts.what ? ` ${opts.what}` : ""
      }.`,
    );
    console.error(`  (${message.split("\n")[0]})`);

    const rebuilt = rebuild(wanted);
    const txid = await client.submitTransaction(rebuilt);
    console.error(
      `\nNote: the default fee in this tool was low — ${fee} against a real ${wanted}.\n` +
        `      Nothing was lost; the first transaction was never accepted.`,
    );
    return { txid, fee: wanted, corrected: true, tx: rebuilt };
  }
}
