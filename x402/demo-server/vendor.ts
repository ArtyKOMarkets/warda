/**
 * A paid API anyone can point an agent at.
 *
 * The demo vendor lived inside `x402/demo/testnet-demo.ts`, listening on
 * 127.0.0.1 and dying with the process. Real, and unreachable: the receipt on
 * the landing page was produced against an endpoint that never existed outside
 * that one run, so nobody could repeat it.
 *
 * ## What it does not do
 *
 * It does not decide whether a payment is allowed — the covenant did that
 * before the transaction existed. This only checks that the money arrived:
 * a UTXO at its own address, from the claimed transaction, for the quoted
 * amount. A vendor that trusted the header would pass just as happily against
 * a fabricated txid.
 *
 * ## Prices
 *
 * Every endpoint costs less than the published demo grant's per-payment cap of
 * 0.1 KAS, so the key on /attack can actually buy from here. A demo API priced
 * above what the demo grant may spend is a demo nobody can run.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { NodeClient, toHex } from "@warda_protocol/kaspa";

const PRICES: Record<string, { sompi: bigint; body: () => unknown }> = {
  "/weather": {
    sompi: 5_000_000n, // 0.05 KAS
    body: () => ({ city: "Athens", temperature: 27, unit: "celsius", source: "demo" }),
  },
  "/fact": {
    /* 0.03, not 0.01. Kaspa charges storage mass for small outputs, and a
       0.01 KAS payment massed 1,000,000 against a 500,000 ceiling — refused
       by consensus, nothing to do with the grant. There is a floor under
       micropayments at roughly 0.02 KAS, and an endpoint priced below it is
       one nobody can buy from. */
    sompi: 3_000_000n, // 0.03 KAS
    body: () => ({
      fact:
        "GHOSTDAG orders blocks by how much work references them, so honest blocks converge " +
        "on one order without discarding competing ones.",
    }),
  },
  "/inference": {
    sompi: 10_000_000n, // 0.1 KAS — exactly the demo grant's cap
    body: () => ({
      model: "demo-1",
      completion: "An agent that cannot pay for an API is not autonomous; it is waiting.",
    }),
  },
};

const VENDOR = process.env.WARDA_DEMO_VENDOR;
const RPC = process.env.WARDA_RPC_JSON;
const SECRET = process.env.WARDA_QUOTE_SECRET ?? "warda-demo-quote";

/**
 * The quote, signed rather than remembered.
 *
 * The original held `issuedNonce` in a module variable. One caller at a time
 * on localhost, so it worked. Hosted, two agents overlapping means the second
 * quote overwrites the first, and the first agent's perfectly good payment is
 * rejected for a nonce mismatch it did nothing to cause — after it has already
 * spent the money.
 *
 * An HMAC over the path, the price and an expiry is verifiable with no memory
 * at all, which is also what lets this run as a serverless function where two
 * requests may not share a process.
 */
function quote(path: string, sompi: bigint, expiresAt: number): string {
  const mac = createHmac("sha256", SECRET).update(`${path}:${sompi}:${expiresAt}`).digest("hex");
  return `${expiresAt}.${mac.slice(0, 32)}`;
}
function quoteValid(path: string, sompi: bigint, nonce: string): string | null {
  const [expStr, mac] = String(nonce).split(".");
  const expiresAt = Number(expStr);
  if (!expStr || !mac || !Number.isFinite(expiresAt)) return "malformed quote";
  if (Date.now() > expiresAt) return "the quote has expired; ask again";
  const want = quote(path, sompi, expiresAt).split(".")[1]!;
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "this quote was not issued here";
  return null;
}

export async function serve(
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const send = (code: number, body: unknown) => {
    const s = JSON.stringify(body, null, 2);
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(s);
  };

  if (path === "/") {
    return send(200, {
      service: "Warda demo x402 vendor",
      note:
        "Every endpoint below answers 402 until it can see your payment in the UTXO set. " +
        "It verifies on chain rather than trusting the header, because a vendor that " +
        "trusted the header would accept a fabricated transaction id.",
      vendor: VENDOR ?? "unconfigured",
      endpoints: Object.fromEntries(
        Object.entries(PRICES).map(([p, v]) => [p, `${Number(v.sompi) / 1e8} KAS`]),
      ),
      allPricedAbove:
        "0.02 KAS, the point below which Kaspa's storage mass rule refuses a payment outright",
      allPricedBelow: "0.1 KAS, the demo grant's per-payment cap, so the published key can buy here",
    });
  }

  const priced = PRICES[path];
  if (!priced) return send(404, { error: `no such endpoint: ${path}` });
  if (!VENDOR || !RPC) {
    return send(503, {
      error: "this vendor is not configured",
      detail: "WARDA_DEMO_VENDOR and WARDA_RPC_JSON must both be set",
    });
  }

  const header = req.headers["x-payment"];
  if (!header) {
    const expiresAt = Date.now() + 120_000;
    return send(402, {
      x402Version: 1,
      error: "payment required",
      accepts: [
        {
          scheme: "exact",
          network: "testnet-10",
          asset: "KAS",
          payTo: VENDOR,
          amountSompi: priced.sompi.toString(),
          nonce: quote(path, priced.sompi, expiresAt),
          maxTimeoutSeconds: 60,
        },
      ],
    });
  }

  let proof: { txid?: string; amountSompi?: string; nonce?: string };
  try {
    proof = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
  } catch {
    return send(400, { error: "X-PAYMENT is not base64 JSON" });
  }

  const bad = quoteValid(path, priced.sompi, proof.nonce ?? "");
  if (bad) return send(400, { error: bad });
  if (!proof.txid) return send(400, { error: "no txid in the payment proof" });

  const client = await NodeClient.connect({ url: RPC });
  try {
    const utxos = await client.getUtxosByAddresses([VENDOR]);
    const paid = utxos.find(
      (u) => toHex(u.outpoint.transactionId) === proof.txid && u.entry.value === priced.sompi,
    );
    if (!paid) {
      /* Not visible yet. Answering 402 here is what makes a well-built client
         re-present the SAME proof rather than pay a second time, and it is the
         case the adapter exists to handle. */
      return send(402, { error: "payment not yet visible on chain", retry: true });
    }
    return send(200, {
      ...(priced.body() as object),
      settledBy: proof.txid,
      verified: "a UTXO at this vendor's address, from that transaction, for exactly the quoted amount",
    });
  } catch (e) {
    return send(503, { error: `could not reach a node: ${(e as Error).message}` });
  } finally {
    client.close();
  }
}
