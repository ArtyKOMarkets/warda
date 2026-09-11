import {
  encodeProof,
  parsePaymentRequired,
  settleDelayMs,
  PAYMENT_HEADER,
  X402Error,
  type PaymentProof,
  type PaymentRequirement,
} from "./protocol.ts";
import type { PaymentResult, WardaPayer } from "./payer.ts";

/**
 * `fetch`, with the 402 dance handled out of a Warda grant.
 *
 * The whole adapter exists to make this one function unremarkable: call a paid
 * endpoint exactly as you would call a free one, and the payment happens
 * underneath, bounded by rules the agent cannot exceed even if it wants to.
 *
 *     const res = await wardaFetch("https://vendor/compute", {
 *       method: "POST",
 *       body: JSON.stringify({ prompt: "..." }),
 *     }, { payer });
 *
 * What it does NOT do is retry a *payment*. If a payment is broadcast and the
 * server then refuses the request, the money is spent and this reports that
 * plainly rather than paying again. An adapter that silently re-paid on an
 * ambiguous failure would be the one bug in this design capable of draining a
 * budget through nobody's fault.
 */

export interface WardaFetchOptions {
  payer: WardaPayer;
  /** Injectable for tests and for callers with their own instrumented fetch. */
  fetchImpl?: typeof fetch;
  /**
   * How many times to re-present the same proof while the server reports the
   * payment still settling. The spec suggests several attempts at 1–8s.
   */
  maxSettleAttempts?: number;
  /** Called at each step. Mirrors the reference client's `onEvent`. */
  onEvent?: (e: WardaFetchEvent) => void;
  /**
   * A proof from an EARLIER call that was paid and never delivered.
   *
   * The money is already on chain. This skips the quote and the payment
   * entirely and re-presents the header, which is the only correct response to
   * a purchase that settled and did not arrive — and what the error thrown at
   * the bottom of this file has always told callers to do without giving them
   * any way to do it, because the header was built here and discarded here.
   *
   * It cannot pay. If the vendor still refuses, this throws; it does not fall
   * back to buying again. A fallback would turn the one failure that costs
   * money into the one failure that costs money twice.
   */
  resume?: ResumableProof;
  /**
   * Refuse to pay more than this for a single call, regardless of what the
   * grant would permit. A belt-and-braces limit that lives in the process —
   * useful, but note that it is exactly the kind of limit Warda exists to
   * replace: it protects against a mis-typed price, not against a compromise.
   */
  maxAmountSompi?: bigint;
}

/**
 * Everything needed to present a payment again, and nothing else.
 *
 * `header` is the wire value; the rest is here so that a caller writing this
 * to disk can tell later WHAT was bought and for how much without decoding
 * base64. A record that holds only an opaque blob is a record nobody reads.
 */
export interface ResumableProof {
  header: string;
  txid: string;
  amountSompi: string;
  payTo?: string;
}

export type WardaFetchEvent =
  | { type: "quote"; requirement: PaymentRequirement }
  /**
   * `header` rides along with the result, because this is the only moment it
   * exists and a caller that does not capture it here cannot ever re-present
   * it. Every purchase that settled and was not delivered used to be
   * unrecoverable for exactly this reason.
   */
  | { type: "paid"; result: PaymentResult; header: string; proof: PaymentProof }
  | { type: "resuming"; proof: ResumableProof }
  | { type: "settling"; attempt: number; delayMs: number }
  | { type: "done"; status: number };

const DEFAULT_SETTLE_ATTEMPTS = 6;

/** A request body may be consumed when the first attempt is sent, so it has to
 *  be captured before that and replayed on the retry. */
function replayable(init: RequestInit | undefined): RequestInit {
  const copy: RequestInit = { ...init };
  const body = init?.body;
  if (body && typeof body === "object" && !(typeof body === "string")) {
    if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
      throw new X402Error(
        "a streaming request body cannot be replayed, and the 402 flow has to send the " +
          "request twice: once to learn the price, once with proof of payment. Buffer the " +
          "body into a string, Uint8Array or Blob first.",
      );
    }
  }
  return copy;
}

export async function wardaFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: WardaFetchOptions,
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = replayable(init);
  const emit = opts.onEvent ?? (() => {});

  /**
   * Resuming happens BEFORE the first request.
   *
   * Not after a 402, and not as a fallback: the whole point is that no path
   * through this branch can reach `payer.pay`. A resume that quietly became a
   * purchase when the proof looked stale would be worse than no resume at all,
   * because the caller reaching for it has already paid once.
   */
  if (opts.resume) {
    emit({ type: "resuming", proof: opts.resume });
    return await present(opts.resume.header, opts.resume.txid);
  }

  const first = await doFetch(input as never, base as never);
  if (first.status !== 402) {
    emit({ type: "done", status: first.status });
    return first;
  }

  let body: unknown;
  try {
    body = await first.clone().json();
  } catch {
    throw new X402Error("the server returned 402 with a body that is not JSON", 402);
  }

  const requirement = parsePaymentRequired(body);
  emit({ type: "quote", requirement });

  if (opts.maxAmountSompi !== undefined && requirement.amountSompi > opts.maxAmountSompi) {
    throw new X402Error(
      `this call is quoted at ${requirement.amountSompi} sompi and the caller's per-call ceiling ` +
        `is ${opts.maxAmountSompi}. Nothing was paid.`,
      402,
    );
  }

  // Everything knowable without the network, refused before a key is touched.
  const refusal = opts.payer.refusalFor(requirement);
  if (refusal) throw new X402Error(refusal, 402);

  const result = await opts.payer.pay(requirement);

  /* The `paid` event is emitted BELOW, once the header exists, rather than
     here where the result does. A caller told "paid" without the header it
     would need to re-present cannot record a recoverable purchase, and the
     window between those two lines is precisely where an unrecoverable one
     used to be created. */
  const proof: PaymentProof = {
    scheme: requirement.scheme,
    network: requirement.network,
    payer: result.payer,
    txid: result.txid,
    amountSompi: result.amountSompi.toString(),
    nonce: requirement.nonce,
  };
  const header = encodeProof(proof);
  emit({ type: "paid", result, header, proof });

  return await present(header, proof.txid);

  /**
   * Present a proof until the vendor delivers, or give up saying what is owed.
   *
   * One function for both entrances — the purchase that just paid and the one
   * resuming an older payment — because they are the same act. A vendor cannot
   * tell them apart and neither should this: the retry cadence, the refusal to
   * pay again, and the final error all have to be identical, and two copies of
   * that would be two places to get the second one wrong.
   *
   * A function DECLARATION, so it can be called from the resume branch at the
   * top of this function. Everything it closes over is initialised by then.
   */
  async function present(paymentHeader: string, txid: string): Promise<Response> {
    const attempts = opts.maxSettleAttempts ?? DEFAULT_SETTLE_ATTEMPTS;
    let last: Response | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const withProof: RequestInit = {
        ...base,
        headers: {
          ...(base.headers as Record<string, string> | undefined),
          [PAYMENT_HEADER]: paymentHeader,
        },
      };
      const res = await doFetch(input as never, withProof as never);
      if (res.status !== 402) {
        emit({ type: "done", status: res.status });
        return res;
      }
      last = res;
      // 402 again means "broadcasting, come back" — the same proof, unchanged.
      // Paying a second time here is the one thing that must never happen.
      if (attempt < attempts - 1) {
        const delayMs = settleDelayMs(attempt);
        emit({ type: "settling", attempt, delayMs });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw new X402Error(
      `payment ${txid} was broadcast and accepted by the network, but the server still ` +
        `reported 402 after ${attempts} attempts. The money is spent; this did NOT pay again. ` +
        `Re-present the same X-PAYMENT header rather than repeating the call, or the nonce is ` +
        `stale and the vendor should be asked about the payment by txid.`,
      last?.status ?? 402,
    );
  }
}
