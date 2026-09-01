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
   * Refuse to pay more than this for a single call, regardless of what the
   * grant would permit. A belt-and-braces limit that lives in the process —
   * useful, but note that it is exactly the kind of limit Warda exists to
   * replace: it protects against a mis-typed price, not against a compromise.
   */
  maxAmountSompi?: bigint;
}

export type WardaFetchEvent =
  | { type: "quote"; requirement: PaymentRequirement }
  | { type: "paid"; result: PaymentResult }
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
  emit({ type: "paid", result });

  const proof: PaymentProof = {
    scheme: requirement.scheme,
    network: requirement.network,
    payer: result.payer,
    txid: result.txid,
    amountSompi: result.amountSompi.toString(),
    nonce: requirement.nonce,
  };
  const header = encodeProof(proof);

  const attempts = opts.maxSettleAttempts ?? DEFAULT_SETTLE_ATTEMPTS;
  let last: Response | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const withProof: RequestInit = {
      ...base,
      headers: { ...(base.headers as Record<string, string> | undefined), [PAYMENT_HEADER]: header },
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
    `payment ${proof.txid} was broadcast and accepted by the network, but the server still ` +
      `reported 402 after ${attempts} attempts. The money is spent; this did NOT pay again. ` +
      `Re-present the same X-PAYMENT header rather than repeating the call, or the nonce is ` +
      `stale and the vendor should be asked about the payment by txid.`,
    last?.status ?? 402,
  );
}
