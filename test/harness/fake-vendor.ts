/**
 * A vendor you can break on purpose.
 *
 * Everything that went wrong with the payment path in the last two days went
 * wrong in a branch that only runs when something ELSE has already failed:
 * a vendor down, a vendor late, a vendor answering in a shape nobody expected.
 * Those are the branches carrying the most responsibility and getting the
 * least exercise, and every one of them was found by a real payment against a
 * live endpoint — seven of them, at a fifth of a cent each plus a deploy
 * cycle to see the next one.
 *
 * This is the thing that should have existed first. It speaks real HTTP 402,
 * issues real quotes, and can be told to fail in each of the ways that
 * actually happened:
 *
 *   serve      quote, then deliver on a valid proof
 *   down       503 with no node, the way a vendor with a dead tunnel behaves
 *   late       accept the payment but answer 402-retry forever, so the buyer
 *              settles and never collects — this is how a debt is created
 *   expired    issue quotes that are already stale
 *   garbage    deliver something that is not JSON
 *
 * No chain, no keys, no deploy. `mode` is a mutable field: set it mid-test and
 * the next request behaves differently, which is the one thing a recorded
 * fixture can never do.
 */
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";

export type VendorMode = "serve" | "down" | "late" | "expired" | "garbage";

export interface FakeVendor {
  url: string;
  /** Change it between requests. That is the whole point. */
  mode: VendorMode;
  /** Every request it has received, paid or not. Zero is a real assertion:
   *  it is how a test says a client refused BEFORE asking for a price. */
  requests: number;
  /** Every X-PAYMENT header this vendor has been shown, in order. */
  seen: string[];
  /** Transaction ids it has delivered against. */
  served: string[];
  close(): Promise<void>;
}

const SECRET = "fake-vendor-secret";
const PRICE = 3_000_000n;

const nonceFor = (resource: string, sompi: bigint, expiresAt: number) =>
  `${expiresAt}.${createHmac("sha256", SECRET).update(`${resource}:${sompi}:${expiresAt}`).digest("hex")}`;

export async function startFakeVendor(): Promise<FakeVendor> {
  const state = {
    mode: "serve" as VendorMode,
    requests: 0,
    seen: [] as string[],
    served: [] as string[],
  };

  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const text = state.mode === "garbage" && status === 200 ? "<html>not json</html>" : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };

    // Node gives a repeated header as an array. One string is the only form
    // this vendor accepts; anything else is treated as absent rather than
    // silently joined into a proof nobody sent.
    state.requests++;

    const raw = req.headers["x-payment"];
    const header = typeof raw === "string" ? raw : undefined;
    if (typeof header === "string") state.seen.push(header);

    if (state.mode === "down") {
      /* The shape a vendor takes when its node is gone: it has the payment
         header and cannot check the chain, so it must not deliver and must
         not tell the buyer to pay again. */
      return send(503, {
        error: "could not reach a node",
        detail: "the payment may well be on chain; this vendor cannot see it. Re-present the same X-PAYMENT header rather than paying again.",
      });
    }

    if (!header) {
      const expiresAt = state.mode === "expired" ? Date.now() - 60_000 : Date.now() + 120_000;
      return send(402, {
        x402Version: 1,
        accepts: [{
          scheme: "exact",
          network: "testnet-10",
          amountSompi: PRICE.toString(),
          payTo: "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4",
          resource: "/fact",
          nonce: nonceFor("/fact", PRICE, expiresAt),
        }],
      });
    }

    let proof: { txid?: string } = {};
    try { proof = JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { /* below */ }

    if (state.mode === "late") {
      /* Paid, and never served. The 402-with-retry is deliberately the same
         status as the quote: a client that treats any 402 as "pay" pays
         twice, and not doing that is the adapter's whole job. */
      return send(402, { retry: true, error: "still settling; present the same proof" });
    }

    if (!proof.txid) return send(400, { error: "no txid in the payment proof" });
    state.served.push(proof.txid);
    return send(200, { fact: "a fact", settledBy: proof.txid, readFrom: "a fake vendor" });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/fact`,
    get mode() { return state.mode; },
    set mode(m: VendorMode) { state.mode = m; },
    get requests() { return state.requests; },
    seen: state.seen,
    served: state.served,
    /* `closeAllConnections` first, and it is not belt-and-braces.
       `server.close()` stops accepting and then WAITS for open sockets to
       drain. A client in the same process — an in-process agent rather than a
       spawned CLI — holds a keep-alive socket by default, so the callback
       never fires and the whole suite hangs after every test has passed. The
       first wallet e2e printed three greens and then sat until it was
       killed. */
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
