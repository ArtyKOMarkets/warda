/**
 * A quote you can verify without having remembered issuing it.
 *
 * The obvious implementation keeps the nonce it just handed out in a variable
 * and compares on the way back. That works for one caller on localhost and
 * fails for everything else, in a way worth spelling out because it is the
 * failure this file exists to prevent: two agents overlapping means the second
 * quote overwrites the first, and the first agent's perfectly good payment is
 * then rejected for a nonce mismatch it did nothing to cause — AFTER it has
 * spent the money. On a serverless host it is worse still, because two
 * requests need not share a process at all, so the variable is empty for
 * almost everyone.
 *
 * An HMAC over the fields being quoted, plus an expiry, needs no memory: the
 * server can tell its own quote from a made-up one by recomputing it. That is
 * what lets this run as a lambda, and it is why the nonce carries its own
 * expiry in the clear — there is nowhere else to keep it.
 *
 * What this does NOT do is stop a quote being used twice. See `spent.ts`: a
 * signature proves the vendor issued the price, not that the buyer has only
 * arrived once.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** What a quote commits to. Change any of it and the signature stops matching. */
export interface QuoteTerms {
  /** The resource being sold — usually the request path. */
  resource: string;
  /** The exact price. `exact` means exact: over- and under-payment both fail. */
  sompi: bigint;
  /** Unix ms after which this quote is refused. */
  expiresAt: number;
}

export interface QuoteOptions {
  /** The signing secret. Anyone holding it can mint quotes in your name. */
  secret: string;
  /** How long a quote stays good. Default two minutes. */
  ttlMs?: number;
}

const mac = (secret: string, t: QuoteTerms): string =>
  createHmac("sha256", secret)
    .update(`${t.resource}:${t.sompi}:${t.expiresAt}`)
    .digest("hex")
    .slice(0, 32);

/** Mint a nonce for these terms: `<expiry>.<mac>`. */
export function issueQuote(terms: QuoteTerms, options: QuoteOptions): string {
  return `${terms.expiresAt}.${mac(options.secret, terms)}`;
}

/**
 * Check a nonce against the terms it claims to be for.
 *
 * Returns a reason, or null when it is good. A reason rather than a boolean
 * because the three ways this fails are three different conversations with the
 * buyer: a malformed nonce is a client bug, an expired one means ask again,
 * and a mismatch means the quote came from somewhere else.
 */
export function checkQuote(
  nonce: string,
  terms: Omit<QuoteTerms, "expiresAt">,
  options: QuoteOptions,
  now: number = Date.now(),
): string | null {
  const [expiryText, presented] = String(nonce).split(".");
  const expiresAt = Number(expiryText);
  if (!expiryText || !presented || !Number.isFinite(expiresAt)) return "malformed quote";
  if (now > expiresAt) return "the quote has expired; ask again";

  const expected = mac(options.secret, { ...terms, expiresAt });
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  /* Length first: timingSafeEqual throws on a mismatch rather than returning
     false, and a thrown comparison is a 500 where a 400 was meant. */
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "this quote was not issued here";
  return null;
}
