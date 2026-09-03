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
}

export type WardaFetchV2Event =
  | { type: "quote"; amountSompi: bigint; payTo: string }
  | { type: "signed"; pending: PendingPayment }
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

  const paid = await doFetch(url as never, {
    ...init,
    method,
    headers: { ...(init?.headers as Record<string, string>), [PAYMENT_SIGNATURE_HEADER]: pending.header },
  } as never);

  if (!paid.ok) {
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
    const out = opts.payer.abandonedV2(
      `the vendor answered ${paid.status} to the paid request.`,
    );
    const why = out.status === "unresolved" ? out.why : "";
    emit({ type: "unresolved", why, status: paid.status, vendorSaid });

    throw new X402Error(
      `the vendor was handed a signed payment of ${amountSompi} sompi and answered ` +
        `${paid.status}.\n\n` +
        (vendorSaid ? `They said:\n  ${vendorSaid.replace(/\n/g, "\n  ")}\n\n` : "") +
        (rejected
          ? `402 means they do not consider themselves paid, so the transaction was very ` +
            `likely never broadcast — a facilitator that had verified and submitted it would ` +
            `not ask for payment again. Confirm against the chain before reusing this grant.`
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
