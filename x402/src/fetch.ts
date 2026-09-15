import {
  DEFAULT_SETTLE_ATTEMPTS,
  encodeProof,
  parsePaymentRequired,
  settleDelayMs,
  PAYMENT_HEADER,
  X402Error,
  type PaymentProof,
  type PaymentRequirement,
} from "./protocol.ts";
import type { PaymentResult, WardaPayer } from "./payer.ts";
import { PAYMENT_REQUIRED_HEADER, dialect, readPaymentRequired } from "./v2.ts";
import type { PendingPayment } from "./pay-v2.ts";
import { wardaFetchV2 } from "./fetch-v2.ts";

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
   * Pay a kaspa-x402 v2 vendor through a relay hop.
   *
   * Ignored by a v1 vendor, and REQUIRED by a v2 one: their `exact` scheme
   * takes only a version-0 transaction with a key-controlled input and no
   * covenant, so a covenant spend cannot be the payment. The grant pays the
   * agent's own key and an ordinary transaction goes from there to the vendor.
   *
   * It costs the allowlist for that one hop — the covenant stops constraining
   * who is ultimately paid — which is why it is a flag and not a fallback.
   * Needs a grant created with `--relay`. See `RELAY.md`.
   */
  relay?: boolean;
  /** The fee for the relayed transaction. See `BuildV2Input.relayFeeSompi`. */
  relayFeeSompi?: bigint;
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
    /**
     * Which dialect is this proof from? Read it out of the proof.
     *
     * The resume branch deliberately never fetches first, so the server cannot
     * be asked — and it does not need to be. A v1 proof is a base64 v1
     * `PaymentProof`; a v2 one is a `PaymentPayload` carrying `x402Version`.
     * They also go back in DIFFERENT headers, so presenting a v2 proof down
     * this path sends `X-PAYMENT` to a server watching for
     * `PAYMENT-SIGNATURE`, which reads to the vendor as no payment at all and
     * to the caller as a vendor refusing a payment that is plainly on chain.
     */
    if (looksLikeV2Proof(opts.resume.header)) {
      throw new X402Error(
        `this proof is a kaspa-x402 v2 payload, and there is no cross-call resume for v2 yet.\n\n` +
          `A v1 proof is an X-PAYMENT header that can be presented again at any time. A v2 ` +
          `proof is a PAYMENT-SIGNATURE payload bound to the exact request it paid for, and ` +
          `re-presenting one belongs inside the call that made it — which its settle loop ` +
          `already does.\n\n` +
          `The payment (${opts.resume.txid}) is on chain either way. Ask the vendor about it ` +
          `by transaction id.`,
      );
    }
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

  /**
   * Which dialect is this server speaking?
   *
   * kaspa-x402 v2 is a second dialect, not a superset — and a v2 server's 402
   * BODY parses as a valid v1 quote, because the real document travels in a
   * `PAYMENT-REQUIRED` header and the body is a stub. So this used to read a
   * v2 server as v1, build a v1 payment against a stub, and fail somewhere
   * downstream for reasons that pointed anywhere but here.
   *
   * The detection is the server's own answer, read the way `dialect()` reads
   * it. Nothing about this is a preference: a v2 server cannot be paid by v1
   * rules and never could.
   */
  const spoken = dialect(readPaymentRequired(first.headers.get(PAYMENT_REQUIRED_HEADER), body));
  if (typeof spoken === "object") {
    throw new X402Error(
      `this server speaks x402 version ${spoken.unsupported}, which this client does not.`,
      402,
    );
  }
  if (spoken === "v2") return await payV2(input, init, opts, emit);

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


/**
 * A v2 vendor, paid through the v2 flow, reported in v1's vocabulary.
 *
 * The two flows emit different events because they do different things — v2
 * signs, broadcasts and settles as separate observable steps — but every
 * caller of `wardaFetch` was written against the v1 shape, and the one that
 * matters most is `paid`: it carries the header that is the ONLY artefact
 * which can redeem a purchase that settled and was never delivered. A
 * translation that dropped it would reintroduce the most expensive bug this
 * package has had.
 *
 * So `broadcast` becomes `paid`, carrying the same header and a result shaped
 * like v1's, and callers keep their recovery machinery.
 *
 * ## What does NOT translate
 *
 * `resume`. A v1 resume re-presents an `X-PAYMENT` header; v2's proof is a
 * `PAYMENT-SIGNATURE` payload bound to the request that was paid for, and its
 * settle loop already re-presents it within one call. Recovery ACROSS calls
 * is not built for v2, and pretending otherwise would hand somebody a stale
 * header and a vendor's refusal. It is refused by name instead.
 */
async function payV2(
  input: string | URL | Request,
  init: RequestInit | undefined,
  opts: WardaFetchOptions,
  emit: (e: WardaFetchEvent) => void,
): Promise<Response> {

  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  /* Held from `signed` and released on `broadcast`. v2 separates the two and
     v1 does not — `paid` means the money is on the network, so it fires on the
     broadcast, but the header that can redeem it exists from the signature. */
  let signed: PendingPayment | undefined;

  return await wardaFetchV2(url, init, {
    payer: opts.payer,
    fetchImpl: opts.fetchImpl,
    maxAmountSompi: opts.maxAmountSompi,
    /* Forwarded: v2 re-presents one payment while their node catches up, the
       same way v1 does, and a caller with its own deadline has to be able to
       say so in both dialects. */
    maxSettleAttempts: opts.maxSettleAttempts,
    relay: opts.relay,
    relayFeeSompi: opts.relayFeeSompi,
    onEvent: (e) => {
      if (e.type === "quote") {
        emit({
          type: "quote",
          requirement: {
            scheme: e.accepted.scheme,
            network: e.accepted.network,
            asset: "KAS",
            payTo: e.payTo,
            amountSompi: e.amountSompi,
            /* v2 replaced the per-invoice nonce with the request binding the
               authorization carries. Nothing reads this; empty is the honest
               value rather than a placeholder for one we lost. */
            nonce: "",
            maxTimeoutSeconds: e.accepted.maxTimeoutSeconds,
          },
        });
      }
      if (e.type === "signed") signed = e.pending;
      if (e.type === "broadcast" && signed) {
        emit({
          type: "paid",
          header: signed.header,
          result: {
            txid: e.txid,
            amountSompi: signed.amountSompi,
            payer: signed.payer,
          } as PaymentResult,
          proof: {
            scheme: "exact",
            network: signed.payment.accepted.network,
            payer: signed.payer,
            txid: e.txid,
            amountSompi: signed.amountSompi.toString(),
            nonce: "",
          },
        });
      }
      if (e.type === "settling") emit({ type: "settling", attempt: e.attempt, delayMs: e.delayMs });
      if (e.type === "done") emit({ type: "done", status: e.status });
    },
  });
}

/**
 * Is this base64 header a v2 payload rather than a v1 proof?
 *
 * Structural, not heuristic: a v2 payload announces `x402Version` and carries
 * an `accepted` requirement, and a v1 proof has neither. Anything unreadable
 * is treated as v1 — the v1 path will reject it with its own message, which is
 * better than this function inventing one for a string it cannot parse.
 */
function looksLikeV2Proof(header: string): boolean {
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    return decoded.x402Version !== undefined && decoded.accepted !== undefined;
  } catch {
    return false;
  }
}
