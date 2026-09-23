/**
 * The X-reads seller. These pin the parts that decide whether a buyer is
 * charged, and the one that decides whether WE are.
 *
 * The second is new in this fleet. Researcher's upstream is free, so a wasted
 * probe costs nothing; here every call to X is metered, so "how many times
 * does one purchase read the upstream" is a number with a dollar sign on it
 * and it belongs in a test rather than in a monthly invoice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayAllowed } from "@warda_protocol/vendor";
import { xsearch, describe as describeX, USD_PER_READ, type XSearchConfig } from "../src/xsearch.ts";

const PAY_TO = "kaspatest:qqj58pd2qw47lg2wn97srt27dwxp8jj2hfasxrt8tjjeytpelzh5sa2mpucwy";

function xBody(n: number) {
  return JSON.stringify({
    data: Array.from({ length: n }, (_, i) => ({
      id: `${i + 1}`, text: `post ${i + 1} about x402`, created_at: new Date().toISOString(),
      author_id: `u${i + 1}`, public_metrics: { like_count: 1, reply_count: 2, retweet_count: 0 },
    })),
    includes: { users: Array.from({ length: n }, (_, i) => ({
      id: `u${i + 1}`, username: `dev${i + 1}`, name: `Dev ${i + 1}`, public_metrics: { followers_count: 1000 },
    })) },
  });
}

function cfg(over: Partial<XSearchConfig> = {}, calls?: string[]): XSearchConfig {
  return {
    payTo: PAY_TO, sompi: 5_000_000n, network: "testnet-10", secret: "test-secret",
    spent: replayAllowed(),
    fetcher: async (url) => { calls?.push(url); return { status: 200, body: xBody(3) }; },
    openNode: async () => { throw new Error("no node in a test"); },
    maxResults: 10,
    ...over,
  };
}
const u = (s: string) => new URL(s, "https://xreads.example");

test("the index states the price, the dollar cost behind it, and who runs it", async () => {
  const body = JSON.stringify(describeX(cfg()));
  assert.match(body, /0\.05 KAS per search/);
  assert.match(body, /\$0\.005 per post read/);
  assert.match(body, /not an independent vendor/);
});

test("the index does not let the both-ends-ours part be missed", async () => {
  const body = JSON.stringify(describeX(cfg()));
  assert.match(body, /Both ends of this are Warda/);
  assert.match(body, /worth nothing/);
  assert.match(body, /not that a market exists/);
});

test("a request that cannot be served is refused before any quote", async () => {
  assert.equal((await xsearch(u("/search"), null, cfg())).status, 400);
  assert.equal((await xsearch(u("/search?q=  "), null, cfg())).status, 400);
  assert.equal((await xsearch(u(`/search?q=${"x".repeat(600)}`), null, cfg())).status, 400);
  assert.equal((await xsearch(u("/search?q=x402&since=yesterday"), null, cfg())).status, 400);
  assert.equal((await xsearch(u("/other"), null, cfg())).status, 404);
});

test("a malformed request costs no upstream read", async () => {
  const calls: string[] = [];
  await xsearch(u("/search"), null, cfg({}, calls));
  assert.deepEqual(calls, [], "X must not be called for a request we already know is bad");
});

test("when X refuses, there is no quote and nothing is charged", async () => {
  const r = await xsearch(u("/search?q=x402"), null, cfg({ fetcher: async () => ({ status: 429, body: "" }) }));
  assert.equal(r.status, 503);
  const b = r.body as { charged: boolean; x: number };
  assert.equal(b.charged, false);
  assert.equal(b.x, 429);
});

test("a servable search is quoted with the price and the address", async () => {
  const r = await xsearch(u("/search?q=x402"), null, cfg());
  assert.equal(r.status, 402);
  const a = (r.body as { accepts: { payTo: string; amountSompi: string }[] }).accepts[0]!;
  assert.equal(a.amountSompi, "5000000");
  assert.equal(a.payTo, PAY_TO);
});

test("one purchase reads the upstream once, quote and delivery together", async () => {
  /* The seller probes to find out whether it can deliver, then delivers what
     it already has. Fetching again after payment would double a metered bill
     and could serve a different answer than the one it checked. */
  const calls: string[] = [];
  await xsearch(u("/search?q=x402"), null, cfg({}, calls));
  assert.equal(calls.length, 1, `one search, one read — got ${calls.length}`);
});

test("the price covers what the reads cost us", () => {
  const max = 10;
  const kas = Number(cfg().sompi) / 1e8;
  assert.ok(kas > 0, "priced");
  assert.equal(Number((USD_PER_READ * max).toFixed(3)), 0.05);
});

test("the search sent to X carries the caller's query and window", async () => {
  const calls: string[] = [];
  await xsearch(u("/search?q=x402%20-is%3Aretweet&since=2026-09-23T00%3A00%3A00Z"), null, cfg({}, calls));
  /* Parsed rather than matched as a string: URLSearchParams writes a space
     as `+` and encodeURIComponent writes `%20`, both correct, and a test that
     picks one is testing the encoder rather than the request. */
  const sent = new URL(calls[0]!);
  assert.equal(sent.origin + sent.pathname, "https://api.x.com/2/tweets/search/recent");
  assert.equal(sent.searchParams.get("query"), "x402 -is:retweet");
  assert.equal(sent.searchParams.get("start_time"), "2026-09-23T00:00:00Z");
  assert.equal(sent.searchParams.get("max_results"), "10");
  assert.equal(sent.searchParams.get("expansions"), "author_id");
});

test("a price under Kaspa's floor is refused rather than quoted", async () => {
  const r = await xsearch(u("/search?q=x402"), null, cfg({ sompi: 1_000n }));
  assert.equal(r.status, 500);
  assert.match(JSON.stringify(r.body), /floor/);
});

test("the seller reads the names the buyer sends", async () => {
  /* The buyer builds a real X URL — `query`, `start_time` — and the seller's
     contract is `q` and `since`. They disagreed, and only the paid path could
     show it: three 400s on the first run against the grant, refused before
     any quote so nothing was charged. This pins the translation from the
     seller's side: given what tools/listen.ts now sends, it serves. */
  const calls: string[] = [];
  const sent = new URLSearchParams();
  sent.set("q", "x402 -is:retweet lang:en");
  sent.set("since", "2026-09-22T12:48:17.110Z");
  const r = await xsearch(u(`/search?${sent}`), null, cfg({}, calls));
  assert.equal(r.status, 402, `expected a quote, got ${r.status}: ${JSON.stringify(r.body)}`);
  const upstream = new URL(calls[0]!);
  assert.equal(upstream.searchParams.get("query"), "x402 -is:retweet lang:en");
  assert.equal(upstream.searchParams.get("start_time"), "2026-09-22T12:48:17.110Z");
});

test("X's own parameter names are not what this sells", async () => {
  /* The failing shape, kept: forwarding X's names gets a 400 and no quote,
     which is the correct refusal and the one that cost nothing. */
  const r = await xsearch(u("/search?query=x402&start_time=2026-09-22T12:48:17.110Z"), null, cfg());
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.body), /\?q=/);
});
