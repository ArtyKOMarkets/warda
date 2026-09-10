/**
 * The whole 402 exchange, with no HTTP in it.
 *
 * Takes what the request carried and returns what to answer. No req, no res,
 * no framework — because the same seven branches are correct on node:http, on
 * a Fetch handler, in a Worker and in a test, and the one place this logic
 * gets copied is the place the copies drift.
 *
 * ## The branches, and why each answers as it does
 *
 * The status codes are not decoration. A buyer that has already broadcast a
 * payment reads them to decide whether to wait, give up, or re-present the
 * same proof — and the difference between those is the difference between one
 * payment and two.
 *
 *   402 no header       here is the price. Nothing has happened yet.
 *   400 bad proof       the buyer's client is wrong. Paying again will not help.
 *   402 not visible     RETRY, with the SAME proof. This is the important one.
 *   409 already served  this payment bought one thing and has had it.
 *   503 no node         the seller is blind, not the buyer wrong. Same proof again.
 *   502 delivery failed paid, and we could not produce it. Says so, with the txid.
 *   200 served          with a receipt naming what was checked and by whom.
 *
 * The 402-with-retry is what stops double payment, so it is deliberately the
 * same status as the initial quote: a client that treats any 402 as "pay" would
 * pay twice, and the adapter on the other side of this exists to get that
 * right. See @warda_protocol/x402.
 */
import { checkQuote, issueQuote, type QuoteOptions } from "./quote.ts";
import { checkPayment } from "./verify.ts";
import type { SpentStore } from "./spent.ts";
import type { NodeClient } from "@warda_protocol/kaspa";

export interface SaleTerms {
  /** What is being sold; goes in the quote's signature. Usually the path. */
  resource: string;
  /** The address that must be paid. */
  payTo: string;
  /** The exact price in sompi. */
  sompi: bigint;
  /** As the buyer's client will read it: `mainnet`, `testnet-10`. */
  network: string;
  /** Optional, for the 402 body. */
  description?: string;
  /** Who is selling — echoed in the receipt so a buyer knows who it paid. */
  seller?: string;
}

export interface SettleInput {
  terms: SaleTerms;
  /** The raw `X-PAYMENT` header, or null when there was none. */
  paymentHeader: string | null;
  quote: QuoteOptions;
  spent: SpentStore;
  /** Opens a node and says which one. Called only once a proof is presented. */
  openNode: () => Promise<{ client: Pick<NodeClient, "getUtxosByAddresses" | "close">; readFrom: string }>;
  /** Produce the goods. Called ONLY after the money is confirmed on chain. */
  deliver: () => unknown | Promise<unknown>;
  now?: () => number;
}

export interface SettleResult {
  status: number;
  body: Record<string, unknown>;
}

const MAX_TIMEOUT_SECONDS = 60;

export async function settle(input: SettleInput): Promise<SettleResult> {
  const { terms, quote: quoteOptions, spent } = input;
  const now = input.now ?? Date.now;

  if (!input.paymentHeader) {
    const expiresAt = now() + (quoteOptions.ttlMs ?? 120_000);
    return {
      status: 402,
      body: {
        x402Version: 1,
        error: "payment required",
        accepts: [
          {
            scheme: "exact",
            network: terms.network,
            asset: "KAS",
            payTo: terms.payTo,
            amountSompi: terms.sompi.toString(),
            nonce: issueQuote({ resource: terms.resource, sompi: terms.sompi, expiresAt }, quoteOptions),
            maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
            ...(terms.description ? { description: terms.description } : {}),
          },
        ],
      },
    };
  }

  let proof: { txid?: unknown; nonce?: unknown };
  try {
    proof = JSON.parse(Buffer.from(input.paymentHeader, "base64").toString("utf8"));
  } catch {
    return { status: 400, body: { error: "X-PAYMENT is not base64 JSON" } };
  }

  const badQuote = checkQuote(
    String(proof.nonce ?? ""),
    { resource: terms.resource, sompi: terms.sompi },
    quoteOptions,
    now(),
  );
  if (badQuote) return { status: 400, body: { error: badQuote } };

  const txid = typeof proof.txid === "string" ? proof.txid : "";
  if (!txid) return { status: 400, body: { error: "no txid in the payment proof" } };

  /* Before the node, not after: a replay is answerable without asking anyone,
     and asking the chain about a payment already served wastes a round trip to
     arrive at the same refusal. */
  if (await spent.has(txid)) {
    return {
      status: 409,
      body: {
        error: "this payment has already been served",
        settledBy: txid,
        detail:
          "One payment buys one delivery. The coin is still in the UTXO set and always will " +
          "be, so presenting it again proves nothing new. Buy again to get another.",
      },
    };
  }

  let opened: Awaited<ReturnType<SettleInput["openNode"]>>;
  try {
    opened = await input.openNode();
  } catch (e) {
    return {
      status: 503,
      body: {
        error: `could not reach a node: ${(e as Error).message}`,
        detail:
          "the payment may well be on chain; this vendor cannot see it. Re-present the same " +
          "X-PAYMENT header rather than paying again — this vendor has NOT been paid twice " +
          "and a second payment would not help.",
      },
    };
  }

  try {
    const check = await checkPayment(opened.client, {
      txid,
      payTo: terms.payTo,
      sompi: terms.sompi,
    });

    if (!check.paid) {
      return {
        status: check.retry ? 402 : 400,
        body: {
          error: check.reason,
          ...(check.retry ? { retry: true } : {}),
          readFrom: opened.readFrom,
        },
      };
    }

    /* Recorded BEFORE delivery. If the seller crashes between the two, a buyer
       loses a purchase it paid for — bad, and recoverable by a human. Recorded
       after, a crash leaves a payment that can be replayed forever, which is
       not recoverable by anyone. Of the two ways to be wrong, this is the one
       that fails towards the seller noticing. */
    await spent.add(txid);

    let payload: unknown;
    try {
      payload = await input.deliver();
    } catch (e) {
      return {
        status: 502,
        body: {
          error: `payment settled but the goods could not be produced: ${(e as Error).message}`,
          settledBy: txid,
          paidTo: terms.payTo,
          ...(terms.seller ? { seller: terms.seller } : {}),
        },
      };
    }

    return {
      status: 200,
      body: {
        ...(payload as object),
        ...(terms.seller ? { seller: terms.seller } : {}),
        paidTo: terms.payTo,
        settledBy: txid,
        verified:
          "a UTXO at this endpoint's payee address, from that transaction, for exactly the quoted amount",
        readFrom: opened.readFrom,
      },
    };
  } catch (e) {
    return { status: 503, body: { error: `could not reach a node: ${(e as Error).message}` } };
  } finally {
    opened.client.close();
  }
}
