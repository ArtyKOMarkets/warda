/**
 * The x402 wire protocol, on its own, with no Warda in it.
 *
 * Kept separate from the payer deliberately. These functions describe what a
 * server said and what a client must send back; everything about grants,
 * covenants and allowlists lives in `payer.ts`. The split means the protocol
 * handling can be tested without a node, a key or a chain — and it means a
 * reader can see exactly how much of this file is "someone else's spec" and
 * how much is ours.
 *
 * Spec: docs/HTTP-402-PROTOCOL.md in kaspahttp402/kaspa-x402.
 */

/** One entry from the server's `accepts` array. */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string;
  /** Where to pay, as a Kaspa address. */
  payTo: string;
  /** Exact amount, in sompi, as a decimal string. */
  amountSompi: bigint;
  /** Single-use, and what binds one payment to one request. */
  nonce: string;
  maxTimeoutSeconds?: number;
  facilitator?: { publicKey?: string; url?: string };
}

/** What goes back in the `X-PAYMENT` header, before base64. */
export interface PaymentProof {
  scheme: string;
  network: string;
  /** The address the payment came FROM. For a Warda spend this is the grant. */
  payer: string;
  txid: string;
  amountSompi: string;
  nonce: string;
}

export const PAYMENT_HEADER = "X-PAYMENT";

/** The only scheme this adapter implements. `exact` means pay precisely
 *  `amountSompi` — underpayment is rejected and overpayment is not refunded. */
export const SCHEME_EXACT = "exact";

export class X402Error extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "X402Error";
    this.status = status;
  }
}

/**
 * Reads a 402 body into the one requirement this client will satisfy.
 *
 * Amounts arrive as decimal STRINGS and are parsed to bigint here rather than
 * carried as numbers. 20,000,000 sompi survives a double fine; a whole-KAS
 * quote does not have to, and a payment that is off by one sompi is rejected
 * outright by an `exact` scheme. There is no reason to let the value pass
 * through a lossy type on the way in.
 */
export function parsePaymentRequired(body: unknown): PaymentRequirement {
  if (typeof body !== "object" || body === null) {
    throw new X402Error("the 402 response body is not an object");
  }
  const b = body as Record<string, unknown>;
  const accepts = b.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new X402Error(
      "the 402 response carries no `accepts` array, so it names no way to pay. " +
        (typeof b.error === "string" ? `The server said: ${b.error}` : ""),
    );
  }

  // The spec says take the first. A server may offer several; this client
  // implements one scheme, so it looks for one it can actually satisfy rather
  // than taking the head and failing later on a scheme it never supported.
  const usable = accepts.find(
    (a) => typeof a === "object" && a !== null && (a as Record<string, unknown>).scheme === SCHEME_EXACT,
  ) as Record<string, unknown> | undefined;
  if (!usable) {
    const offered = accepts
      .map((a) => (typeof a === "object" && a ? String((a as Record<string, unknown>).scheme) : "?"))
      .join(", ");
    throw new X402Error(
      `this server offers only the scheme(s) [${offered}], and this client implements ` +
        `"${SCHEME_EXACT}". A Warda spend pays one exact amount to one allowlisted ` +
        `payee, which is what "exact" means; other schemes would need their own support.`,
    );
  }

  const need = (k: string): string => {
    const v = usable[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new X402Error(`the 402 requirement is missing "${k}"`);
    }
    return v;
  };

  const raw = usable.amountSompi;
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new X402Error("the 402 requirement is missing a numeric `amountSompi`");
  }
  let amountSompi: bigint;
  try {
    amountSompi = BigInt(raw);
  } catch {
    throw new X402Error(`amountSompi ${JSON.stringify(raw)} is not an integer number of sompi`);
  }
  if (amountSompi <= 0n) throw new X402Error(`amountSompi must be positive, got ${amountSompi}`);

  return {
    scheme: SCHEME_EXACT,
    network: need("network"),
    asset: typeof usable.asset === "string" ? usable.asset : "KAS",
    payTo: need("payTo"),
    amountSompi,
    nonce: need("nonce"),
    maxTimeoutSeconds:
      typeof usable.maxTimeoutSeconds === "number" ? usable.maxTimeoutSeconds : undefined,
    facilitator:
      typeof usable.facilitator === "object" && usable.facilitator !== null
        ? (usable.facilitator as PaymentRequirement["facilitator"])
        : undefined,
  };
}

/** base64 of the proof JSON, for the `X-PAYMENT` header. */
export function encodeProof(proof: PaymentProof): string {
  const json = JSON.stringify(proof);
  // Buffer where it exists (Node), btoa elsewhere. The proof is ASCII JSON, so
  // the naive btoa path is safe here — it would not be for arbitrary UTF-8.
  if (typeof Buffer !== "undefined") return Buffer.from(json, "utf8").toString("base64");
  return btoa(json);
}

export function decodeProof(header: string): PaymentProof {
  const json =
    typeof Buffer !== "undefined"
      ? Buffer.from(header, "base64").toString("utf8")
      : atob(header);
  return JSON.parse(json) as PaymentProof;
}

/**
 * The server answers 402 a second time while the payment is still settling.
 * The spec says retry the identical header after 1–8 seconds, several times.
 *
 * Exponential with a cap, and jitter — every client hitting the same endpoint
 * would otherwise retry in lockstep and arrive together.
 */
export function settleDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return Math.round(base * (0.75 + random() * 0.5));
}
