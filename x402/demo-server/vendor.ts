/**
 * A paid API anyone can point an agent at.
 *
 * The demo vendor lived inside `x402/demo/testnet-demo.ts`, listening on
 * 127.0.0.1 and dying with the process. Real, and unreachable: the receipt on
 * the landing page was produced against an endpoint that never existed outside
 * that one run, so nobody could repeat it.
 *
 * ## Two sellers, one deployment
 *
 * `/weather`, `/fact` and `/inference` are sold by the demo vendor. `/digest`
 * is sold by **agent #001**, and the money for it goes to an address the demo
 * vendor does not hold. That is why `payTo` is a property of the endpoint
 * rather than of the server: a buyer's covenant commits to WHO may be paid, so
 * two endpoints on one host that pay two different addresses are two different
 * markets to a Warda grant, and a grant allowlisted for one cannot buy from
 * the other. Collapsing them onto a single vendor address would have made that
 * distinction invisible in exactly the demo built to show it.
 *
 * ## What it does not do
 *
 * It does not decide whether a payment is allowed — the covenant did that
 * before the transaction existed. This only checks that the money arrived:
 * a UTXO at the endpoint's own address, from the claimed transaction, for the
 * quoted amount. A vendor that trusted the header would pass just as happily
 * against a fabricated txid.
 *
 * ## Prices
 *
 * Every endpoint costs less than the published demo grant's per-payment cap of
 * 0.1 KAS, so the key on /attack can actually buy from here. A demo API priced
 * above what the demo grant may spend is a demo nobody can run.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { NodeClient, resolveNode, resolverFrom, toHex } from "@warda_protocol/kaspa";

interface Priced {
  sompi: bigint;
  /**
   * The env var holding the address that must be paid for THIS endpoint. Named
   * rather than read at module load so an unconfigured seller fails loudly on
   * its own route instead of taking the whole server down.
   */
  payToEnv: string;
  /** Who is selling. Printed in the 200 so a buyer knows who it paid. */
  seller: string;
  body: () => unknown | Promise<unknown>;
}

/**
 * Agent #001's digest, fetched live from where the agent publishes it.
 *
 * ## This is not secret, and the page says so
 *
 * The same digest is free at wardaprotocol.com/agent-001.json. Paywalling it
 * would be a lie about the product; what is being demonstrated is not
 * information asymmetry but a payment — one agent's covenant paying another
 * agent's address, on a public chain, with neither end able to pay anyone
 * else. Inventing scarcity to make that look more impressive would have
 * traded the one property here that is checkable for one that is theatre. So
 * the 200 response says where the free copy is.
 *
 * Fetched rather than bundled because a digest bundled at deploy time is stale
 * the hour after, and an agent selling yesterday's measurement of a live
 * network is selling the wrong thing.
 */
const AGENT_001_PUBLIC = process.env.WARDA_AGENT_001_URL ?? "https://wardaprotocol.com/agent-001.json";

async function agent001Digest(): Promise<unknown> {
  const res = await fetch(AGENT_001_PUBLIC, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`agent #001 published nothing readable: HTTP ${res.status}`);
  const published = (await res.json()) as Record<string, unknown>;
  const digest = published.digest;
  if (!digest) throw new Error("agent #001's published state carries no digest");
  return {
    agent: "WARDA-001",
    digest,
    lastRun: published.lastRun ?? null,
    measuredAt: published.checkedAt ?? null,
    network: published.network ?? null,
    alsoPublishedFreeAt: AGENT_001_PUBLIC,
    note:
      "Every figure is a difference between two counters a Kaspa node maintains for its own " +
      "reasons, and both readings are published beside it. This costs money because a payment " +
      "is what is being demonstrated, not because the data is scarce — the free copy is above.",
  };
}

const PRICES: Record<string, Priced> = {
  "/weather": {
    sompi: 5_000_000n, // 0.05 KAS
    payToEnv: "WARDA_DEMO_VENDOR",
    seller: "warda demo vendor",
    body: () => ({ city: "Athens", temperature: 27, unit: "celsius", source: "demo" }),
  },
  "/fact": {
    /* 0.03, not 0.01. Kaspa charges storage mass for small outputs, and a
       0.01 KAS payment massed 1,000,000 against a 500,000 ceiling — refused
       by consensus, nothing to do with the grant. There is a floor under
       micropayments at roughly 0.02 KAS, and an endpoint priced below it is
       one nobody can buy from. */
    sompi: 3_000_000n, // 0.03 KAS
    payToEnv: "WARDA_DEMO_VENDOR",
    seller: "warda demo vendor",
    body: () => ({
      fact:
        "GHOSTDAG orders blocks by how much work references them, so honest blocks converge " +
        "on one order without discarding competing ones.",
    }),
  },
  "/inference": {
    sompi: 10_000_000n, // 0.1 KAS — exactly the demo grant's cap
    payToEnv: "WARDA_DEMO_VENDOR",
    seller: "warda demo vendor",
    body: () => ({
      model: "demo-1",
      completion: "An agent that cannot pay for an API is not autonomous; it is waiting.",
    }),
  },
  "/digest": {
    /* Above the ~0.02 KAS storage-mass floor and below agent #002's 0.1 KAS
       per-payment cap, which is the covenant's limit and not this server's. */
    sompi: 4_000_000n, // 0.04 KAS
    payToEnv: "WARDA_AGENT_001_PAYEE",
    seller: "WARDA-001",
    body: agent001Digest,
  },
};

const SECRET = process.env.WARDA_QUOTE_SECRET ?? "warda-demo-quote";

/* Read per request, like the payee addresses, rather than captured at module
   load. Under a serverless host the two are identical — the environment is
   fixed before the module is imported — but a module-load read makes the
   server's configuration unobservable to anything that imports it, and the
   first test written against these routes failed for that and nothing else. */
const rpc = () => process.env.WARDA_RPC_JSON;

/**
 * A node, preferring the one this vendor was given.
 *
 * ## Why there is a fallback at all
 *
 * `WARDA_RPC_JSON` pointed at a Cloudflare *quick* tunnel, which is handed a
 * new random hostname every time it restarts. It restarted. Every paid request
 * after that failed, including one that had already been paid for, and nothing
 * anywhere said so — the second time in this repository that a public service
 * quietly went dark because it reached a laptop through a hostname that does
 * not survive a reboot.
 *
 * A published endpoint that only works while one machine is up is not
 * published. So a resolver-found public node is tried when the configured one
 * cannot be reached.
 *
 * ## What that costs, said out loud
 *
 * This vendor's entire security is "the money is visibly in the UTXO set", and
 * a node it does not control is the thing answering that question. A dishonest
 * one could report a payment that does not exist and this would hand over the
 * goods. That risk is the VENDOR's — a buyer loses nothing by it — the amounts
 * are testnet, and the alternative on offer is an endpoint that is down. It is
 * still a weaker claim than reading its own node, so which node answered is
 * reported in the response rather than left for someone to discover.
 *
 * The configured node is always tried first, and `NodeClient.open` checks a
 * resolved node is utxo-indexed, synced and on the right network before
 * anything is believed — the three ways a node returns a plausible wrong
 * answer instead of an error.
 */
async function nodeFor(): Promise<{ client: NodeClient; readFrom: string }> {
  const url = rpc();
  let firstFailure: string | null = null;
  if (url) {
    try {
      return { client: await NodeClient.connect({ url }), readFrom: "this vendor's own node" };
    } catch (e) {
      firstFailure = (e as Error).message;
    }
  }
  if (resolverFrom({})) {
    /**
     * `resolveNode` then `open`, not `open` alone.
     *
     * `NodeClient.open` consults a resolver only when NO node is named, and it
     * counts `WARDA_RPC_JSON` as naming one — correctly, for its own purposes.
     * Here that variable holds the very url that just failed, so calling
     * `open()` at this point re-dialled the dead host and threw the same error
     * a second time. The fallback existed, was deployed, and did nothing.
     *
     * Resolving first and passing the url explicitly is what actually gets
     * past a configured-but-unreachable node.
     */
    const found = await resolveNode({ networkId: "testnet-10" });
    const { client, health } = await NodeClient.open({ url: found.url, networkId: "testnet-10" });
    return {
      client,
      readFrom:
        `a public node found by a resolver (kaspad ${health.serverVersion}), because this ` +
        `vendor's own node could not be reached. A node this vendor does not control is ` +
        `answering whether you paid it.`,
    };
  }
  throw new Error(
    firstFailure
      ? `${firstFailure}\n\nNo WARDA_RESOLVER is set, so there was nothing to fall back to.`
      : "no WARDA_RPC_JSON and no WARDA_RESOLVER: this vendor cannot read the chain",
  );
}

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
      sellers:
        "Endpoints do not all pay the same address. A Warda grant commits to its payees, so " +
        "a grant allowlisted for one seller here cannot buy from the other.",
      endpoints: Object.fromEntries(
        Object.entries(PRICES).map(([p, v]) => [
          p,
          {
            price: `${Number(v.sompi) / 1e8} KAS`,
            seller: v.seller,
            payTo: process.env[v.payToEnv] ?? "unconfigured",
          },
        ]),
      ),
      allPricedAbove:
        "0.02 KAS, the point below which Kaspa's storage mass rule refuses a payment outright",
      allPricedBelow: "0.1 KAS, the demo grant's per-payment cap, so the published key can buy here",
    });
  }

  const priced = PRICES[path];
  if (!priced) return send(404, { error: `no such endpoint: ${path}` });

  const payTo = process.env[priced.payToEnv];
  if (!payTo) {
    return send(503, {
      error: `the seller of ${path} is not configured`,
      detail: `${priced.payToEnv} must be set to the address this endpoint is paid at`,
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
          payTo,
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

  /**
   * INSIDE the try, not above it.
   *
   * This connect sat outside, so a node this function could not reach threw
   * before any handler existed and the host answered its own generic 500 —
   * an HTML error page, to a client holding a payment it had just broadcast.
   * Every branch below already answers in JSON with a reason; the one failure
   * most likely to actually happen in production was the one that did not.
   */
  let client: NodeClient;
  let readFrom: string;
  try {
    ({ client, readFrom } = await nodeFor());
  } catch (e) {
    return send(503, {
      error: `could not reach a node: ${(e as Error).message}`,
      detail:
        "the payment may well be on chain; this vendor cannot see it. Re-present the same " +
        "X-PAYMENT header rather than paying again — this vendor has NOT been paid twice " +
        "and a second payment would not help.",
    });
  }

  try {
    const utxos = await client.getUtxosByAddresses([payTo]);
    const paid = utxos.find(
      (u) => toHex(u.outpoint.transactionId) === proof.txid && u.entry.value === priced.sompi,
    );
    if (!paid) {
      /* Not visible yet. Answering 402 here is what makes a well-built client
         re-present the SAME proof rather than pay a second time, and it is the
         case the adapter exists to handle. */
      return send(402, { error: "payment not yet visible on chain", retry: true, readFrom });
    }

    /* The body is produced only AFTER the money is on chain, and it may fail:
       /digest reaches out to where agent #001 publishes. A seller that has
       taken payment and cannot deliver owes the buyer the reason, not a 500
       with no txid in it — the buyer's money is already spent and its own
       records need to say what it bought and from whom. */
    let payload: unknown;
    try {
      payload = await priced.body();
    } catch (e) {
      return send(502, {
        error: `payment settled but ${path} could not be produced: ${(e as Error).message}`,
        settledBy: proof.txid,
        seller: priced.seller,
        paidTo: payTo,
      });
    }

    return send(200, {
      ...(payload as object),
      seller: priced.seller,
      paidTo: payTo,
      settledBy: proof.txid,
      verified: "a UTXO at this endpoint's payee address, from that transaction, for exactly the quoted amount",
      /* WHICH node said so. The sentence above is only as good as the node
         behind it, and this vendor does not always get to use its own. */
      readFrom,
    });
  } catch (e) {
    return send(503, { error: `could not reach a node: ${(e as Error).message}` });
  } finally {
    client.close();
  }
}
