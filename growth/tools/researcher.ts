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
import { createServer } from "node:http";
import { inMemorySpent, openNode } from "@warda_protocol/vendor";
import { FLOOR_SOMPI, githubFetcher, research, type ResearcherConfig } from "../src/service.ts";

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
if (PRICE < FLOOR_SOMPI) {
  console.error(`--price ${PRICE} is below Kaspa's ~${FLOOR_SOMPI} sompi storage-mass floor; no buyer could pay it.`);
  process.exit(2);
}

/* One store for the process: in memory, so a restart forgets which payments
   were spent. Fine for a laptop; the hosted Researcher (growth/deploy) keeps
   them in Postgres. */
const cfg: ResearcherConfig = {
  payTo: PAY_TO,
  sompi: PRICE,
  network: NETWORK,
  secret: SECRET,
  spent: inMemorySpent(),
  fetcher: githubFetcher(process.env.GITHUB_TOKEN),
  openNode: () => openNode({ rpc: process.env.WARDA_RPC_JSON, network: NETWORK }),
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://researcher");
  const header = req.headers["x-payment"];
  research(url, header === undefined ? null : String(header), cfg)
    .then((r) => {
      res.writeHead(r.status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(r.body, null, 2));
    })
    .catch((e: Error) => {
      console.error(e);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
}).listen(PORT, "127.0.0.1", () => {
  console.error(`researcher selling /verify at ${Number(PRICE) / 1e8} KAS on 127.0.0.1:${PORT}, paid to ${PAY_TO}`);
});
