/**
 * Researcher: an agent that sells verification, and is paid in KAS.
 *
 *   WARDA_RPC_JSON=wss://…  QUOTE_SECRET=… \
 *     node --experimental-strip-types tools/researcher.ts --port 8790
 *
 *   curl "localhost:8790/verify?url=https://github.com/kaspanet/rusty-kaspa"
 *     -> 402, with a quote naming an address and an amount
 *   … pay it, then present the same request with X-PAYMENT
 *     -> 200, with the record
 *
 * This is the other half of "agents hiring agents". Scout holds a grant that
 * may pay exactly one address — this one — and Researcher does work that the
 * buyer can check, for money that moved on a public chain. Neither of them can
 * do the other's job, and neither can spend outside what the covenant allows.
 *
 * ## Why `settle` rather than `priced`
 *
 * `priced` is the ten-line wrapper and hands `deliver` only a transaction id.
 * Researcher is paid to look at something, so it needs the request — and
 * constructing a `priced` per request would give each one its own replay
 * store, which is not replay protection at all. So: `settle` directly, with
 * one store for the process.
 *
 * ## What it is honest about
 *
 * The store is in memory, which means a restart forgets which payments were
 * spent. For a single process selling small records that is a stated
 * limitation rather than a hidden one; a seller taking real money wants a
 * durable `SpentStore`, and the interface exists for that.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { inMemorySpent, openNode, settle } from "@warda_protocol/vendor";
import { verifyProject, type Fetcher } from "../src/verify-project.ts";

const flag = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const PORT = Number(flag("port", "8790"));
const NETWORK = flag("network", process.env.WARDA_NETWORK ?? "testnet-10")!;
const PRICE = BigInt(flag("price", "5000000")!); // 0.05 KAS
const PAY_TO = flag("pay-to", process.env.RESEARCHER_ADDRESS);
const SECRET = process.env.QUOTE_SECRET;

if (!PAY_TO) {
  console.error(
    "researcher needs --pay-to <address>, or RESEARCHER_ADDRESS.\n" +
      "It is the address this agent is paid at, and the ONE address a Scout's grant may pay.",
  );
  process.exit(2);
}
if (!SECRET) {
  console.error(
    "researcher needs QUOTE_SECRET, and will not invent one.\n\n" +
      "It signs quotes, so every instance must use the SAME value. A per-process secret makes " +
      "each quote unverifiable by the next process — the failure is intermittent, looks like a " +
      "buyer problem, and lands after the money is spent.",
  );
  process.exit(2);
}

/* KIP-9 storage mass puts a floor of roughly 0.02 KAS under any payment, so a
   price below it is not cheap, it is unpayable. Checked at startup rather than
   discovered by the first buyer. */
const FLOOR = 2_000_000n;
if (PRICE < FLOOR) {
  console.error(`--price ${PRICE} is below Kaspa's ~${FLOOR} sompi storage-mass floor; no buyer could pay it.`);
  process.exit(2);
}

/** One store for the process. See the header for why this is not per request. */
const spent = inMemorySpent();

const fetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: {
      // GitHub refuses anonymous requests without one, and an agent that does
      // not say what it is deserves the rate limit it gets.
      "user-agent": "warda-growth-researcher",
      accept: url.includes("api.github.com") ? "application/vnd.github+json" : "text/html",
    },
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text() };
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://researcher");
  if (url.pathname !== "/verify") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: "this agent sells one thing",
      resource: "/verify?url=<a project url>",
      price_sompi: PRICE.toString(),
      pay_to: PAY_TO,
      network: NETWORK,
    }, null, 2));
    return;
  }

  const project = url.searchParams.get("url");
  if (!project) {
    /* Refused BEFORE a quote. Quoting for a request that cannot be served
       takes money for nothing, and the buyer's grant would have spent it. */
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "give me ?url=<a project url> to verify" }, null, 2));
    return;
  }

  const header = req.headers["x-payment"];
  const result = await settle({
    /* The resource is the PATH, not the path plus the query: one price, any
       project. A resource that varied per project would quote separately for
       every url and a buyer could never reuse a quote it had already paid. */
    terms: { payTo: PAY_TO!, sompi: PRICE, network: NETWORK, resource: "/verify" },
    paymentHeader: header === undefined ? null : String(header),
    quote: { secret: SECRET! },
    spent,
    openNode: () => openNode({ rpc: process.env.WARDA_RPC_JSON, network: NETWORK }),
    deliver: async () => {
      const record = await verifyProject(project, fetcher);
      console.error(
        `sold: ${project} — ${record.findings.length} findings, ` +
          `${record.unverified.length} unverified, ${record.signals.length} signals`,
      );
      return record;
    },
  });

  res.writeHead(result.status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(result.body, null, 2));
}

createServer((req, res) => {
  handle(req, res).catch((e: Error) => {
    console.error(`researcher: ${e.message}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the researcher failed while working", detail: e.message }, null, 2));
  });
}).listen(PORT, () => {
  console.error(`researcher selling /verify at ${PRICE} sompi on ${NETWORK}`);
  console.error(`  paid at : ${PAY_TO}`);
  console.error(`  listening on http://127.0.0.1:${PORT}`);
});
