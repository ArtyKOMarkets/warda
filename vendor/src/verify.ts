/**
 * Did the money arrive?
 *
 * This is the only question a seller actually needs answered, and the only
 * honest way to answer it is to look at the UTXO set. A vendor that reads the
 * buyer's `X-PAYMENT` header and believes it has verified nothing: the header
 * is written by the party who benefits from lying, and a fabricated
 * transaction id is as easy to write as a real one.
 *
 * So: ask a node what is sitting at YOUR address, and look for a coin from the
 * transaction the buyer named, worth exactly what you quoted.
 *
 * ## Three things this deliberately does not accept
 *
 * A coin at the right address from a DIFFERENT transaction. Somebody else's
 * payment, or an earlier one of this buyer's, is not this purchase.
 *
 * A coin from the right transaction for a different amount. `exact` is the
 * scheme's name and its meaning; underpayment is not a discount and
 * overpayment is not a tip, because a vendor that rounds is a vendor whose
 * price is a suggestion.
 *
 * A transaction that exists in a mempool somewhere. Only a UTXO counts. A
 * payment in flight is indistinguishable, from here, from one that will never
 * confirm — and the caller is told to come back rather than refused, because
 * it has already spent the money.
 */
import type { NodeClient } from "@warda_protocol/kaspa";
import { toHex } from "@warda_protocol/kaspa";

export interface PaymentClaim {
  /** The transaction the buyer says paid you. */
  txid: string;
  /** The address you quoted. */
  payTo: string;
  /** The exact amount you quoted, in sompi. */
  sompi: bigint;
}

export type PaymentCheck =
  | { paid: true; txid: string }
  /**
   * Not visible. `retry` is the whole reason this is one shape rather than a
   * boolean: a buyer whose payment has not landed yet must be told to
   * re-present the SAME proof, and a buyer whose payment is wrong must not be.
   * Collapsing those two into "no" is how a client ends up paying twice.
   */
  | { paid: false; retry: boolean; reason: string };

export async function checkPayment(
  client: Pick<NodeClient, "getUtxosByAddresses">,
  claim: PaymentClaim,
): Promise<PaymentCheck> {
  const utxos = await client.getUtxosByAddresses([claim.payTo]);

  const wanted = claim.txid.toLowerCase();
  const fromThatTx = utxos.filter((u) => toHex(u.outpoint.transactionId).toLowerCase() === wanted);

  if (fromThatTx.length === 0) {
    return {
      paid: false,
      retry: true,
      reason: "payment not yet visible on chain",
    };
  }

  const exact = fromThatTx.find((u) => u.entry.value === claim.sompi);
  if (!exact) {
    /* The transaction IS there and pays this address the wrong amount. Not a
       retry: waiting will not change what it paid, and telling a buyer to wait
       for a payment that can never be accepted is how money gets spent twice
       chasing a purchase that was refused the first time. Name both figures —
       the buyer cannot see its own transaction from inside this refusal. */
    const paid = fromThatTx.map((u) => u.entry.value.toString()).join(", ");
    return {
      paid: false,
      retry: false,
      reason:
        `transaction ${claim.txid} pays this address ${paid} sompi, and the quote was ` +
        `${claim.sompi}. The scheme is "exact": this is not underpayment or overpayment, ` +
        `it is a different purchase.`,
    };
  }

  return { paid: true, txid: claim.txid };
}
