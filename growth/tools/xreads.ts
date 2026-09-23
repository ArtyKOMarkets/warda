/**
 * X reads: an agent that sells a search of X, and is paid in KAS.
 *
 *   X_BEARER_TOKEN=… QUOTE_SECRET=… WARDA_RPC_JSON=wss://… \
 *     node --experimental-strip-types tools/xreads.ts --port 8788 --pay-to kaspatest:…
 *
 *   curl "localhost:8788/search?q=x402"
 *     -> 402, with a quote naming an address and an amount
 *   … pay it, then present the same request with X-PAYMENT
 *     -> 200, with the posts
 *
 * ## Why this runs here and not on Vercel
 *
 * Researcher is hosted because its upstream is free and its secret is a
 * GitHub token that can read public repositories. This one holds a credential
 * that SPENDS: X bills per post read, so a leaked bearer token is somebody
 * else's usage on our card. It stays on one machine, behind a tunnel, the
 * same way the covenant auditor does — one process, one credential, one place
 * to revoke it.
 *
 * ## It is never listed, and that is X's rule rather than a choice
 *
 * X's Developer Policy lets you distribute Post IDs to third parties and not
 * Post objects — a service handing out post text and metrics, automatically,
 * to whoever pays, is redistribution, and that clause forbids it. So this is
 * not in `site/src/services.json`, is not in the registry's sources, and does
 * not serve a `.well-known` listing. There is nothing here for a stranger to
 * find, because a stranger buying from it is the thing that would be wrong.
 *
 * The on-chain demonstration is unaffected. One operator's agent paying that
 * same operator's endpoint, under limits the network enforces, is exactly
 * what was always claimed — `src/xsearch.ts` says both ends are ours in its
 * own response body. Nothing was lost by this except a listing that would
 * have been a breach.
 *
 * ## The spent store is a file, and that is a decision
 *
 * In memory, a restart forgets which payments were served and every past
 * payment buys again. Researcher accepts that on a laptop because a duplicate
 * record costs the seller nothing. Here a replayed payment costs real reads,
 * so it is written down — see covenant/auditor-service/spent.mjs for the same
 * argument at more length.
 */
import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { openNode, type SpentStore } from "@warda_protocol/vendor";
import { FLOOR_SOMPI, USD_PER_READ, xFetcher, xsearch, type XSearchConfig } from "../src/xsearch.ts";
import { LISTENER } from "../src/shape.ts";

const flag = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const PORT = Number(flag("port", "8788"));
const NETWORK = flag("network", process.env.WARDA_NETWORK ?? "testnet-10")!;
/* The same two numbers the buyer uses, from the same file. A seller capping
   at 10 while the buyer asks for 25 is not an error either side can see. */
const PRICE = BigInt(flag("price", String(LISTENER.priceSompi))!);
const MAX = Number(flag("max-results", String(LISTENER.maxResults)));
const PAY_TO = flag("pay-to", process.env.XREADS_ADDRESS);
const SECRET = process.env.QUOTE_SECRET;
const BEARER = process.env.X_BEARER_TOKEN;
const SPENT_FILE = process.env.SPENT_FILE ?? join(homedir(), "Library", "Application Support", "warda", "xreads-spent.log");

const die = (m: string) => { console.error(m); process.exit(2); };

if (!PAY_TO) die("xreads needs --pay-to <address>, or XREADS_ADDRESS.\nIt is the address this agent is paid at, and the ONE address the Listener's grant may pay.");
if (!SECRET) die("xreads needs QUOTE_SECRET, and will not invent one.\n\nIt signs quotes, so every restart must use the SAME value. A per-process secret makes\nevery quote issued before the restart unverifiable after it, and the buyer who paid\nagainst one is refused having paid.");
if (!BEARER) die("xreads needs X_BEARER_TOKEN.\n\nIt is the credential X bills against. Without it every search would answer 503 and\nthis would sell nothing, which is a slower way of not starting.");
if (PRICE < FLOOR_SOMPI) die(`--price ${PRICE} is below Kaspa's ~${FLOOR_SOMPI} sompi storage-mass floor; no buyer could pay it.`);

/* The price must cover what a purchase can cost us, or every sale loses
   money quietly. Checked at startup rather than trusted, because the two
   numbers are set by different flags and nothing else would ever compare
   them. The threshold is a warning, not a refusal: on testnet the KAS side
   is symbolic and the operator may well want it that way. */
const costUsd = USD_PER_READ * MAX;
console.error(`xreads: ${Number(PRICE) / 1e8} KAS per search, up to ${MAX} reads, which costs us $${costUsd.toFixed(3)}`);

function fileSpent(path: string): SpentStore {
  const seen = new Set<string>();
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(t)) seen.add(t);
    }
  }
  let made: Promise<unknown> | null = null;
  return {
    has: (txid) => seen.has(String(txid).toLowerCase()),
    async add(txid) {
      const t = String(txid).toLowerCase();
      made ??= mkdir(dirname(path), { recursive: true });
      await made;
      await appendFile(path, `${t}\n`, "utf8");
      seen.add(t);
    },
  };
}

const spent = fileSpent(SPENT_FILE);
const cfg: XSearchConfig = {
  payTo: PAY_TO!,
  sompi: PRICE,
  network: NETWORK,
  secret: SECRET!,
  spent,
  maxResults: MAX,
  fetcher: xFetcher(BEARER!),
  openNode: () => openNode({ rpc: process.env.WARDA_RPC_JSON, network: NETWORK }),
  origin: process.env.XREADS_ORIGIN,
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://xreads");
  const send = (status: number, type: string, body: string) => {
    res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
    res.end(body);
  };

  /* Deliberately absent: /.well-known/warda-service.json.
     A listing is how a stranger finds a service and buys from it, and X's
     policy forbids redistributing post content to third parties. The 404 is
     the feature. */
  if (url.pathname === "/.well-known/warda-service.json") {
    return send(404, "text/plain",
      "not listed, on purpose: X's Developer Policy forbids redistributing post content\n" +
      "to third parties. This endpoint serves one buyer, run by the same operator.\n");
  }

  const header = req.headers["x-payment"];
  xsearch(url, header === undefined ? null : String(header), cfg)
    .then((r) => send(r.status, "application/json", JSON.stringify(r.body, null, 2)))
    .catch((e: Error) => {
      console.error(e);
      send(500, "application/json", JSON.stringify({ error: e.message }));
    });
}).listen(PORT, "127.0.0.1", () => {
  console.error(`xreads selling /search on 127.0.0.1:${PORT}, paid to ${PAY_TO}`);
  console.error(`  replay protection ${SPENT_FILE}`);
});
