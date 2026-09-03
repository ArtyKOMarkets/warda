/**
 * `fetch` against a kaspa-x402 v2 vendor, paid from a Warda grant.
 *
 * The v1 version of this function pays and then asks. This one signs, hands
 * over, and waits to be told — because in v2 the vendor broadcasts. That makes
 * the failure modes different enough to be worth a separate function rather
 * than a flag, and the difference is visible in exactly one place: what happens
 * when the paid request does not come back 2xx.
 *
 * ## Why a failure here is not a rollback
 *
 * The vendor holds a signed transaction. A 4xx after that could mean they
 * rejected it before broadcasting, or that they broadcast it and then failed
 * to serve the request. From this side those are the same response, and
 * guessing wrong in the optimistic direction means the payer keeps spending
 * from a coin that is already gone.
 *
 * So a failed paid request marks the payer unresolved and says so. That is
 * more disruptive than a rollback and it is the only honest option; the way
 * out is one query per candidate address, which `tools/follow-grant.ts` does.
 *
 * A later version can do better: their protocol has stable error identifiers,
 * and some of them can only be produced before a broadcast. Reading those is a
 * real refinement, and it is not guesswork this file should do by inference.
 */
import { X402Error } from "./protocol.ts";
import {
  dialect,
  readPaymentRequired,
  selectRequirement,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type PaidRequest,
} from "./v2.ts";
import { amountOf, type PendingPayment } from "./pay-v2.ts";
import type { PaymentResult, WardaPayer } from "./payer.ts";

export interface WardaFetchV2Options {
  payer: WardaPayer;
  fetchImpl?: typeof fetch;
  onEvent?: (e: WardaFetchV2Event) => void;
  /**
   * Refuse to pay more than this for one call, whatever the grant permits.
   * A limit that lives in the process — useful against a mistyped price, and
   * exactly the kind of limit a grant exists to replace.
   */
  maxAmountSompi?: bigint;
  /**
   * What the vendor will hash as this request's body.
   *
   * v2 binds a payment to `{method, url, body}`, and the vendor recomputes that
   * binding from the request it receives. `body` is a JSON VALUE there, not the
   * serialized string — so a server that parses `{"prompt":"hi"}` hashes the
   * object, and a client that hashed the string would produce a payment the
   * vendor cannot match to any request it has seen.
   *
   * By default a string body that parses as JSON is used parsed, and anything
   * else becomes null. That is right for the JSON APIs this exists to call and
   * a guess everywhere else, so a caller with a different content type should
   * say what the vendor will see rather than let this infer it.
   */
  body?: unknown;

  /**
   * Put the spend on chain before presenting it. Default true.
   *
   * Their verifier requires the payment to have reached the finality the quote
   * names, so a payment that has not been broadcast is one they refuse with
   * `invalid_transaction_state`. Turn this off only for a vendor that
   * explicitly submits on the client's behalf.
   */
  broadcast?: boolean;

  /** How long to wait for the network to accept it. Default 30s. */
  acceptTimeoutMs?: number;
}

export type WardaFetchV2Event =
  | { type: "quote"; amountSompi: bigint; payTo: string }
  | { type: "signed"; pending: PendingPayment }
  | { type: "broadcast"; txid: string; accepted: boolean }
  | { type: "settled"; result: PaymentResult }
  | { type: "unresolved"; why: string; status: number; vendorSaid: string }
  | { type: "done"; status: number };

/**
 * The body as the vendor will hash it.
 *
 * Undefined and absent bodies are null rather than omitted, because their rule
 * is `request.body ?? null` and a missing key and a null key hash differently
 * under a canonical encoder.
 */
export function bodyForBinding(init: RequestInit | undefined, override?: unknown): unknown {
  if (override !== undefined) return override;
  const raw = init?.body;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function wardaFetchV2(
  input: string | URL,
  init: RequestInit | undefined,
  opts: WardaFetchV2Options,
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const emit = opts.onEvent ?? (() => {});
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";

  const first = await doFetch(url as never, init as never);
  if (first.status !== 402) {
    emit({ type: "done", status: first.status });
    return first;
  }

  // The header first. A v2 server's body is a stub with `content-type:
  // text/plain`, so a body that will not parse is normal rather than an error
  // whenever the header carried the quote.
  const headerValue = first.headers.get(PAYMENT_REQUIRED_HEADER);
  let body: unknown = null;
  try {
    body = await first.clone().json();
  } catch {
    if (!headerValue) {
      throw new X402Error(
        `the server returned 402 with no ${PAYMENT_REQUIRED_HEADER} header and a body that ` +
          `is not JSON, so it named no way to pay.`,
        402,
      );
    }
  }

  const quote_ = readPaymentRequired(headerValue, body);
  const which = dialect(quote_);
  if (which !== "v2") {
    throw new X402Error(
      typeof which === "object"
        ? `this server speaks x402 version ${which.unsupported}, which this client does not.`
        : `this server speaks x402 v1, not v2. Use wardaFetch, which implements that dialect.`,
      402,
    );
  }

  const accepted = selectRequirement(quote_);
  const amountSompi = amountOf(accepted);
  emit({ type: "quote", amountSompi, payTo: accepted.payTo });

  if (opts.maxAmountSompi !== undefined && amountSompi > opts.maxAmountSompi) {
    throw new X402Error(
      `this call is quoted at ${amountSompi} sompi and the caller's per-call ceiling is ` +
        `${opts.maxAmountSompi}. Nothing was signed.`,
    );
  }

  // The binding must describe the request that is actually sent next, so it is
  // built from the same values used to send it rather than from the first
  // attempt's response.
  const request: PaidRequest = { method, url, body: bodyForBinding(init, opts.body) };
  const pending = await opts.payer.buildPaymentV2({ accepted, request });
  emit({ type: "signed", pending });

  let confirmedOnChain = false;
  if (opts.broadcast !== false) {
    const { txid, accepted: onChain } = await opts.payer.broadcastPendingV2({
      timeoutMs: opts.acceptTimeoutMs,
    });
    confirmedOnChain = onChain;
    emit({ type: "broadcast", txid, accepted: onChain });
    if (!onChain) {
      // Presenting anyway would very likely earn the same refusal, and the
      // authorization expires on the quote's own clock. Better to say the
      // spend is on the network and this run ran out of patience than to have
      // the vendor say something less specific.
      opts.payer.abandonedV2(`the spend was submitted but not accepted within the wait.`);
      throw new X402Error(
        `the payment was broadcast as ${txid} but the network had not accepted it before ` +
          `the wait ran out, and this vendor's quote requires accepted finality. The spend ` +
          `is on the network: reconcile the grant against the chain rather than re-paying.`,
      );
    }
  }

  const paid = await doFetch(url as never, {
    ...init,
    method,
    headers: { ...(init?.headers as Record<string, string>), [PAYMENT_SIGNATURE_HEADER]: pending.header },
  } as never);

  if (!paid.ok) {
    /**
     * A spend the chain accepted is final, whatever the vendor thinks.
     *
     * These are two different facts and conflating them was a bug: whether the
     * COIN moved, and whether the SERVICE was delivered. Once the network has
     * accepted the transaction the grant has moved and the manifest must
     * follow, or the next run aims at an address holding nothing — the exact
     * failure `follow-grant` exists to repair, caused here for no reason.
     *
     * So the grant advances and the request still fails. The caller is told it
     * paid and got nothing, which is the truth and is actionable; the
     * alternative was a correct refusal to guess about a spend we had watched
     * land ourselves.
     */
    if (confirmedOnChain) {
      const result = opts.payer.settledV2();
      emit({ type: "settled", result });
    }
    /**
     * What the vendor said, verbatim.
     *
     * The first live run of this against a real vendor came back 402 and this
     * function discarded the body, so the only thing anyone could report was
     * the status code. Their protocol carries stable error identifiers for
     * exactly this situation and we threw them away — leaving "it did not
     * work" as the entire finding from a payment that cost a real signature.
     *
     * Bounded, because an error page can be any size, and included in both the
     * event and the thrown message so a caller that logs either one has it.
     */
    const vendorSaid = await paid
      .clone()
      .text()
      .then((t) => t.slice(0, 2_000).trim())
      .catch(() => "");

    /**
     * A 402 is not the same kind of failure as a 500.
     *
     * 402 means "payment required" — the vendor is saying it does NOT consider
     * itself paid, which a facilitator that had verified and broadcast the
     * transaction would not say. It is strong evidence the spend never left
     * their process. Not proof: they could broadcast and then fail to serve.
     *
     * So the payer still stops, because the difference between "almost
     * certainly not broadcast" and "not broadcast" is a grant that spends from
     * a coin somebody else already moved. But the message says which of the
     * two this is, because the operator's next step differs.
     */
    const rejected = paid.status === 402;
    let why = "";
    if (!confirmedOnChain) {
      const out = opts.payer.abandonedV2(
        `the vendor answered ${paid.status} to the paid request.`,
      );
      why = out.status === "unresolved" ? out.why : "";
    }
    emit({ type: "unresolved", why, status: paid.status, vendorSaid });

    throw new X402Error(
      `the vendor was handed a signed payment of ${amountSompi} sompi and answered ` +
        `${paid.status}.\n\n` +
        (vendorSaid ? `They said:\n  ${vendorSaid.replace(/\n/g, "\n  ")}\n\n` : "") +
        (confirmedOnChain
          ? `The payment IS on chain and accepted, and the grant has been advanced to match — ` +
            `so this is a paid request that was not served, not a lost grant. ` +
            (rejected
              ? `They answered 402, meaning they do not consider themselves paid despite an ` +
                `accepted transaction paying the address they quoted.`
              : ``)
          : `Whether they broadcast it first cannot be told from here, so this payer has ` +
            `stopped rather than assume.`) +
        `\n${why}`,
      paid.status,
    );
  }

  emit({ type: "settled", result: opts.payer.settledV2() });
  emit({ type: "done", status: paid.status });
  return paid;
}
