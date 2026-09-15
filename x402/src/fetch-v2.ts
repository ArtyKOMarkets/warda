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
import { DEFAULT_SETTLE_ATTEMPTS, X402Error, settleDelayMs } from "./protocol.ts";
import type { ExactPaymentRequirements } from "@kaspa-x402/core";
import {
  dialect,
  readPaymentRequired,
  selectRequirement,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
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

  /**
   * How many times to present the SAME payment while the vendor reports it
   * cannot see it yet. Default 6.
   *
   * v1 has always done this and v2 did not, which was an omission rather than
   * a decision. Their verifier resolves the payment against its own node and
   * requires the finality the quote names; ours is submitted through whichever
   * public resolver answered and presented the instant that resolver reports
   * it accepted. Those are two different nodes and there is no reason the
   * second should have heard about it yet — so the first presentation raced
   * propagation with nothing behind it, and a lost race was reported as a
   * vendor refusing a payment plainly on chain.
   *
   * Re-presenting cannot pay again: no path in this function reaches the payer
   * a second time, and the payload is the identical bytes. It is also what the
   * payment identifier is FOR — the transaction id, stable across
   * presentations, so their idempotency cache reads a retry as one purchase.
   */
  maxSettleAttempts?: number;

  /**
   * Omit `payerAddress` from the payload. Optional in their schema.
   *
   * Their own client fills it from a funding wallet's identity, so every
   * payment their verifier has ever seen carries a pay-to-pubkey address
   * there. A grant's address is pay-to-script-hash, and a verifier that
   * decodes it expecting a wallet is one plausible reading of the refusal we
   * cannot see inside.
   */
  omitPayerAddress?: boolean;

  /**
   * Declare the SUCCESSOR grant's address as `payerAddress`, rather than the
   * address the coin was spent from.
   *
   * A wallet's change returns to the address it paid from, so for a wallet
   * those two are the same and nothing distinguishes them. A covenant spend
   * relocates: output 0 is a successor at a NEW address. If the check we
   * cannot see is "every output that is not the payment returns to the payer",
   * then the successor address is the one that satisfies it and the spent-from
   * address never will.
   *
   * Mutually exclusive with `omitPayerAddress`, which wins if both are set.
   */
  payerIsSuccessor?: boolean;
  /**
   * Pay through a relay hop, which is what an x402 `exact` vendor requires.
   *
   * Their scheme takes only a version-0 transaction with a key-controlled
   * input and no covenant, so the covenant spend cannot be the payment: the
   * grant pays the agent's own key and an ordinary transaction goes from there
   * to the vendor. Needs a grant created with `--relay`, and costs the
   * allowlist for that one hop. See `x402/RELAY.md`.
   */
  relay?: boolean;
  /** The fee for the relayed transaction. See `BuildV2Input.relayFeeSompi`. */
  relayFeeSompi?: bigint;
}

export type WardaFetchV2Event =
  /* `accepted` rides along because a caller needs more than the price: the
     network it settles on is the one check that must happen BEFORE anything
     is signed, and a payment built for the wrong chain broadcasts, confirms,
     and is never seen by the vendor. */
  | { type: "quote"; amountSompi: bigint; payTo: string; accepted: ExactPaymentRequirements }
  | { type: "signed"; pending: PendingPayment }
  | { type: "broadcast"; txid: string; accepted: boolean }
  /* Between presentations of one payment. `vendorSaid` is included because a
     retry loop that prints only "attempt 3" hides the reason it is retrying,
     and the reason is the finding. */
  | { type: "settling"; attempt: number; delayMs: number; status: number; vendorSaid: string }
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
  emit({ type: "quote", amountSompi, payTo: accepted.payTo, accepted });

  if (opts.maxAmountSompi !== undefined && amountSompi > opts.maxAmountSompi) {
    throw new X402Error(
      `this call is quoted at ${amountSompi} sompi and the caller's per-call ceiling is ` +
        `${opts.maxAmountSompi}. Nothing was signed.`,
    );
  }

  /**
   * Refused BEFORE anything is signed, because we now know the answer.
   *
   * This flow used to build the payment, broadcast it, present it, and be told
   * `invalid_transaction_state`. Eight times, across two independently hosted
   * vendors, for money that was really spent. The cause was not knowable from
   * outside until kaspa-x402 v1.0.0-rc.1 published the verifier, and it is
   * three lines of their envelope check: version must be 0, an input may not
   * carry a compute budget, and no output may carry a covenant. A grant spend
   * fails all three before anything about the payment is examined, and the
   * `additive` profile rejects covenants identically.
   *
   * So there is no covenant spend that satisfies this scheme. Building one is
   * not an attempt; it is a payment we know will be refused after it settles.
   * Refusing here costs nothing — refusing there cost 0.2 KAS a go.
   *
   * The check lives in THIS function and not in `buildPaymentV2`, because that
   * is the general v2 builder and this is the flow that says "pay this
   * vendor". A caller probing whether the rule still holds can assemble the
   * payload through `buildPayment` directly, which is the right layer for it.
   */
  if (!opts.relay) {
    throw new X402Error(
      `x402 exact cannot accept a covenant spend, so this payment would settle on chain ` +
        `and be refused off it.\n\n` +
        `Their verifier requires the payer's input to be a bare pay-to-pubkey coin unlocked ` +
        `by one signature, and no output to carry a covenant. A grant spend is neither, under ` +
        `any version — output 0 IS the successor grant, and it is a covenant output.\n\n` +
        `The way through is a relay hop: the grant pays the agent's own key, and an ordinary ` +
        `transaction goes from there to the vendor. It costs the allowlist for that one hop ` +
        `and nothing else — budget, per-payment cap, epoch limit and window all still bind.\n\n` +
        `  warda grant --payees payees.txt --relay     when the grant is created\n` +
        `  warda pay <url> --relay                     when it is spent\n\n` +
        `See x402/RELAY.md for what that trade is, exactly.`,
    );
  }

  // The binding must describe the request that is actually sent next, so it is
  // built from the same values used to send it rather than from the first
  // attempt's response.
  const request: PaidRequest = { method, url, body: bodyForBinding(init, opts.body) };
  const pending = await opts.payer.buildPaymentV2({
    accepted,
    request,
    omitPayerAddress: opts.omitPayerAddress,
    payerIsSuccessor: opts.payerIsSuccessor,
    relay: opts.relay,
    relayFeeSompi: opts.relayFeeSompi,
  });
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

  /**
   * Read a refusal completely, without consuming the response.
   *
   * Hoisted out of the failure branch because the settle loop needs it too:
   * deciding whether to retry means reading what they said, and a loop that
   * read the body on the last attempt only would be choosing blind on every
   * attempt before it.
   */
  const decodeHeader = (r: Response, name: string): string => {
    const raw = r.headers.get(name);
    if (!raw) return "";
    try {
      return `${name}: ${JSON.stringify(JSON.parse(Buffer.from(raw, "base64").toString("utf8")))}`;
    } catch {
      /* A header we cannot parse is still evidence. */
      return `${name}: ${raw.slice(0, 2_000)}`;
    }
  };
  const whatTheySaid = async (r: Response): Promise<string> => {
    const text = await r
      .clone()
      .text()
      .then((t) => t.slice(0, 2_000).trim())
      .catch(() => "");
    return [text, decodeHeader(r, PAYMENT_RESPONSE_HEADER), decodeHeader(r, PAYMENT_REQUIRED_HEADER)]
      .filter(Boolean)
      .join("\n");
  };

  const present = (): Promise<Response> =>
    doFetch(url as never, {
      ...init,
      method,
      headers: { ...(init?.headers as Record<string, string>), [PAYMENT_SIGNATURE_HEADER]: pending.header },
    } as never);

  /**
   * Present until they see it, or until patience runs out.
   *
   * Only a 402 is retried. It is the one status that means "as far as I can
   * tell you have not paid", which is exactly the claim a node that has not
   * yet heard about an accepted transaction would make. A 4xx that is not 402
   * is a complaint about the payload, and a 5xx is theirs; neither improves by
   * asking again with identical bytes.
   *
   * Guarded on `confirmedOnChain`, so a client that chose not to broadcast is
   * not put in a loop waiting for a transaction nobody sent.
   */
  const attempts = Math.max(1, opts.maxSettleAttempts ?? DEFAULT_SETTLE_ATTEMPTS);
  let paid = await present();
  for (let attempt = 1; attempt < attempts && confirmedOnChain && paid.status === 402; attempt++) {
    const delayMs = settleDelayMs(attempt - 1);
    emit({
      type: "settling",
      attempt,
      delayMs,
      status: paid.status,
      vendorSaid: await whatTheySaid(paid),
    });
    await new Promise((r) => setTimeout(r, delayMs));
    paid = await present();
  }

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
     * What the vendor said, verbatim — body and both headers.
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
    /* Body and both headers, read by the helper above. A refusal arrives as
       one or the other: `PAYMENT-RESPONSE` means they ran their verifier and
       are naming the check that failed; `PAYMENT-REQUIRED` means they did not
       consider a payment present at all and are quoting again. Reading only
       the body left "it did not work" as the entire finding from a payment
       that cost a real signature, twice. */
    const vendorSaid = await whatTheySaid(paid);

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
