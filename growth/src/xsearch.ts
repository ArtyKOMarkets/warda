/**
 * X reads, sold. The one thing in this fleet that fronts a real bill.
 *
 * Researcher sells a record built from GitHub, which is free, so its price is
 * a number we chose. This sells a search of X, which is not free: X charges
 * **$0.005 per post read**, pay-per-use, no subscription. That makes this the
 * first Warda service whose price mirrors a cost somebody actually invoices
 * us for, and the only one where "the agent pays for the data it needs" is
 * about anything more than bookkeeping.
 *
 * ## Say the quiet part, in the response
 *
 * Both ends are still ours, and the coin is testnet KAS, which is worth
 * nothing. The chain does not show an agent buying data on an open market; it
 * shows an agent spending inside limits the network enforced, against a bill
 * denominated somewhere else. That is a smaller claim than "autonomous
 * economic workflow" and it is the one that survives being checked, so
 * `describe()` states it rather than leaving it to be discovered.
 *
 * ## It will not take money for a search it cannot run
 *
 * Same rule as Researcher, and it matters more here because the upstream is
 * metered: before QUOTING, a request that X would reject — a malformed query,
 * a window X will not serve, a missing credential — is refused with no quote
 * and nothing charged. A buyer whose grant paid for `{"errors":[…]}` has been
 * robbed by an accident, which is indistinguishable from being robbed.
 */
import { settle, type SettleInput, type SpentStore } from "@warda_protocol/vendor";
import { postsFrom, searchUrl, type Fetcher, type Post } from "./listen.ts";

export interface XSearchConfig {
  payTo: string;
  sompi: bigint;
  network: string;
  secret: string;
  spent: SpentStore;
  /** Calls X. Injected, so the tests pin the answers that decide a charge. */
  fetcher: Fetcher;
  openNode: SettleInput["openNode"];
  origin?: string;
  /** Post reads one purchase may cost us. The price is set to cover this. */
  maxResults?: number;
}

export interface Reply { status: number; body: unknown }

/**
 * A price below this cannot be paid by anybody, whatever their grant says:
 * KIP-9 storage mass would refuse the transaction. It is a NECESSARY condition
 * and not a sufficient one — a payment's mass depends on every output the
 * transaction creates, so what decides it is how much the buyer's grant has
 * LEFT afterwards. A 0.04 KAS payment out of a 0.12 KAS grant massed 583,334
 * against a ceiling of 500,000 and was refused on 24 September 2026. The
 * arithmetic is in growth/src/one-job-plan.ts; do not read this constant as
 * "anything above 0.02 KAS goes through".
 */
export const FLOOR_SOMPI = 2_000_000n;

/** What X charges per post read, in USD. The basis for the price below. */
export const USD_PER_READ = 0.005;

export const DEFAULT_MAX_RESULTS = 10;

export function describe(cfg: Pick<XSearchConfig, "payTo" | "sompi" | "network" | "origin" | "maxResults">): unknown {
  const max = cfg.maxResults ?? DEFAULT_MAX_RESULTS;
  return {
    service: "Warda Growth · X reads",
    sells: "/search?q=<x search query>",
    what:
      `Up to ${max} recent posts matching a query, flattened to the fields a ranking needs: ` +
      "text, author handle and follower count, likes, replies, reposts, and when it was posted.",
    price: `${Number(cfg.sompi) / 1e8} KAS per search`,
    costBasis:
      `X charges $${USD_PER_READ} per post read, so one search of ${max} results costs the operator ` +
      `$${(USD_PER_READ * max).toFixed(3)}. The KAS price covers that; it is not derived from a market.`,
    payTo: cfg.payTo,
    network: cfg.network,
    payment: "HTTP 402 (x402 v1). The payment is checked in the UTXO set before anything is served.",
    listing: cfg.origin ? `${cfg.origin}/.well-known/warda-service.json` : undefined,
    operator: "Warda — this is the project's own agent, not an independent vendor.",
    /* The disclosure belongs in the thing itself, not only on a page about
       it. An agent that reads this response is told what it is buying. */
    honestly:
      "Both ends of this are Warda: the buyer is our agent and the seller is us. The coin is testnet " +
      "KAS and is worth nothing. What the chain proves here is that a grant's limits were enforced — " +
      "not that a market exists.",
  };
}

const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function describeHtml(cfg: Pick<XSearchConfig, "payTo" | "sompi" | "network" | "origin" | "maxResults">): string {
  const kas = Number(cfg.sompi) / 1e8;
  const max = cfg.maxResults ?? DEFAULT_MAX_RESULTS;
  const o = cfg.origin ?? "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Warda Growth · X reads</title>
<meta name="description" content="Recent X posts matching a query, sold for ${kas} KAS over HTTP 402. Run by Warda.">
<style>
:root{--void:#06090C;--ground:#0A1014;--edge:#1E2E37;--chrome:#DDE0E2;--dim:#8D989E;--faint:#5D6B73;--teal:#14D7C1}
*{box-sizing:border-box}html,body{margin:0;background:var(--void);color:var(--chrome);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:56px 20px 72px}
.eye{font:12px/1 ui-monospace,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--teal);margin:0}
h1{font-size:clamp(30px,6vw,44px);line-height:1.1;margin:14px 0 12px;letter-spacing:-.02em}
p{color:var(--dim);margin:0 0 14px}p b{color:var(--chrome)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:26px 0}
.grid div{border:1px solid var(--edge);background:var(--ground);border-radius:10px;padding:14px 16px}
.grid i{display:block;font:11px ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);font-style:normal}
.grid b{display:block;margin-top:6px;font:15px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
h2{font-size:20px;margin:34px 0 10px}
pre{background:var(--ground);border:1px solid var(--edge);border-radius:10px;padding:14px 16px;overflow-x:auto;font:13px/1.6 ui-monospace,Menlo,monospace;color:var(--chrome)}
ul{color:var(--dim);padding-left:20px}li{margin:6px 0}
a{color:var(--teal)}.note{border-left:3px solid var(--teal);padding:4px 0 4px 14px;margin-top:30px}
</style></head><body><main>
<p class="eye">Warda Growth · an agent that sells reads</p>
<h1>X reads</h1>
<p>Up to <b>${max} recent posts</b> matching a query, flattened to the fields a ranking needs: text, author handle and follower count, likes, replies, reposts, and when it was posted.</p>
<div class="grid">
<div><i>price</i><b>${kas} KAS / search</b></div>
<div><i>costs us</i><b>$${(USD_PER_READ * max).toFixed(3)}</b></div>
<div><i>payment</i><b>HTTP 402 · x402 v1</b></div>
</div>
<p><b>Why that price.</b> X charges $${USD_PER_READ} per post read, pay-per-use. This is the one service in the fleet whose price covers a bill somebody sends us, rather than a number we picked. When X refuses a query it offers no quote, so nobody pays for an error.</p>
<h2>Buy one</h2>
<pre>curl "${esc(o)}/search?q=x402"
# 402: a quote naming the address and ${kas} KAS

warda pay "${esc(o)}/search?q=x402" --grant grant.json</pre>
<p class="note"><b>Both ends of this are Warda.</b> The buyer is our agent and the seller is us, on testnet, with coin that is worth nothing. What the chain proves is that a grant's limits held — not that a market exists. Run by <a href="https://wardaprotocol.com/agents#gf">Warda's growth fleet</a>. Listed in the <a href="https://wardaprotocol.com/network">Warda registry</a> with a <a href="${esc(o)}/.well-known/warda-service.json">signed listing</a>.</p>
</main></body></html>`;
}

/**
 * Calls X. One definition, because `tools/xreads.ts` sells these reads and
 * `tools/listen.ts --direct` buys them without the covenant in between, and a
 * second copy is where a header or a timeout quietly diverges — which would
 * show up as the seller and the trial disagreeing about what X returned.
 */
export function xFetcher(token: string): Fetcher {
  return async (u) => {
    const res = await fetch(u, {
      headers: { authorization: `Bearer ${token}`, "user-agent": "warda-growth-xreads" },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: await res.text() };
  };
}

/** Longest query X will take, and the longest worth taking from a stranger. */
const MAX_QUERY = 512;

export async function xsearch(url: URL, paymentHeader: string | null, cfg: XSearchConfig): Promise<Reply> {
  if (url.pathname === "/" || url.pathname === "") return { status: 200, body: describe(cfg) };
  if (url.pathname !== "/search") {
    return { status: 404, body: { error: "this agent sells one thing", resource: "/search?q=<x search query>" } };
  }
  if (cfg.sompi < FLOOR_SOMPI) {
    return { status: 500, body: { error: `priced below Kaspa's ~${FLOOR_SOMPI} sompi floor; no buyer could pay it` } };
  }

  const q = url.searchParams.get("q");
  if (!q || !q.trim()) return { status: 400, body: { error: "give me ?q=<an x search query>" } };
  if (q.length > MAX_QUERY) return { status: 400, body: { error: `query longer than ${MAX_QUERY} characters` } };

  const since = url.searchParams.get("since") ?? new Date(Date.now() - 48 * 3_600_000).toISOString();
  if (Number.isNaN(new Date(since).getTime())) {
    return { status: 400, body: { error: `since=${JSON.stringify(since)} is not a timestamp` } };
  }
  const max = cfg.maxResults ?? DEFAULT_MAX_RESULTS;
  const target = searchUrl({ label: "bought", q }, since, max);

  /* The probe, before the quote. It is a real search and it costs us a real
     read, which is the point: the seller pays to find out whether it can
     deliver, rather than charging the buyer to find out that it cannot. */
  const probe = await cfg.fetcher(target).catch(() => ({ status: 0, body: "" }));
  if (probe.status !== 200) {
    return {
      status: 503,
      body: {
        error: "X is not answering this query right now",
        x: probe.status,
        charged: false,
        note: "A search bought now would return X's error, so no quote is offered. Try again later.",
      },
    };
  }

  const posts = postsFrom(probe.body, "bought");

  /* `settle` answers 402 with a quote when there is no payment header, and
     verifies the coin when there is. Either way it is reached only after the
     probe above proved this query can be served. */
  return settleWith(posts, q, since, max, paymentHeader, cfg);
}

/**
 * The payment half, separated so the probe above cannot be skipped.
 *
 * `deliver` returns posts already in hand. Fetching again after payment would
 * double the bill and could return a different answer than the one the seller
 * checked it could serve.
 */
async function settleWith(posts: Post[], q: string, since: string, max: number, paymentHeader: string | null, cfg: XSearchConfig): Promise<Reply> {
  const out = await settle({
    terms: { payTo: cfg.payTo, sompi: cfg.sompi, network: cfg.network, resource: `/search?q=${q}` },
    quote: { secret: cfg.secret },
    spent: cfg.spent,
    paymentHeader,
    openNode: cfg.openNode,
    deliver: () => ({
      query: q, since, maxResults: max,
      reads: posts.length,
      costUsd: Number((posts.length * USD_PER_READ).toFixed(4)),
      posts,
    }),
  });
  return { status: out.status, body: out.body };
}

