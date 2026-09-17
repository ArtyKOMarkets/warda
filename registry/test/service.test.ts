import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { toHex, fromHex } from "@warda_protocol/core";
import { signListing, handle, readIndex, type ServiceManifest } from "../src/index.ts";

const SK = fromHex("11".repeat(32));
const PAYEE = toHex(schnorr.getPublicKey(SK));

function manifest(over: Partial<ServiceManifest> = {}): ServiceManifest {
  return {
    version: 1, name: "Weather Agent", description: "Current weather and forecasts",
    endpoint: "https://weather.test/api", capabilities: ["weather.current", "weather.forecast"],
    pricing: { asset: "KAS", amount: "0.02", unit: "request" },
    payment: { protocol: "x402", network: "kaspa:testnet-10", warda: true },
    payee: PAYEE, ...over,
  };
}

/** A web of well-known URLs, so nothing here reaches the network. */
function web(pages: Record<string, unknown>) {
  return (async (u: string) => {
    const body = pages[String(u)];
    if (body === undefined) return new Response("", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const WEATHER = "https://weather.test/.well-known/warda-service.json";
const DIGEST = "https://digest.test/.well-known/warda-service.json";

const pages = {
  [WEATHER]: signListing(manifest(), SK),
  [DIGEST]: signListing(manifest({
    name: "Kaspa digest", description: "hourly reading of the DAG",
    endpoint: "https://digest.test/digest", capabilities: ["kaspa.digest"],
    pricing: { asset: "KAS", amount: "0.04", unit: "request" },
  }), SK),
};

const config = (sources: string[], extra: Record<string, unknown> = {}) => ({
  sources,
  fetchOptions: { fetch: web({ ...pages, ...extra }) },
});

async function get(path: string, cfg: any) {
  const res = await handle(new Request("https://registry.test" + path), cfg);
  return { res, body: await res.json() };
}

test("browse returns every source that still verifies", async () => {
  const { res, body } = await get("/", config([WEATHER, DIGEST]));
  assert.equal(res.status, 200);
  assert.equal(body.count, 2);
  assert.deepEqual(body.dropped, []);
  assert.ok(body.services[0]._verifiedAt);
  assert.equal(body.services[0]._source, WEATHER);
});

test("a source that no longer verifies is dropped AND reported", async () => {
  const gone = "https://vanished.test/.well-known/warda-service.json";
  const { body } = await get("/", config([WEATHER, gone]));
  assert.equal(body.count, 1);
  assert.deepEqual(body.dropped, [{ source: gone, failures: ["UNREACHABLE"] }]);
});

/* The whole trust model, as one test: a hostile entry in the registry's own
   index cannot make a bad listing appear, because the manifest is re-read from
   the host it claims and checked there. */
test("a poisoned index entry cannot list a service", async () => {
  const stolen = "https://attacker.test/.well-known/warda-service.json";
  const { body } = await get("/", config([WEATHER, stolen], { [stolen]: pages[WEATHER] }));
  assert.equal(body.count, 1);
  assert.equal(body.services[0].endpoint, "https://weather.test/api");
  assert.deepEqual(body.dropped, [{ source: stolen, failures: ["HOST_MISMATCH"] }]);
});

test("filters compose, and an empty query is everything", async () => {
  const cfg = config([WEATHER, DIGEST]);
  assert.equal((await get("/", cfg)).body.count, 2);
  assert.equal((await get("/?capability=kaspa.digest", cfg)).body.count, 1);
  assert.equal((await get("/?maxPrice=0.03", cfg)).body.count, 1);
  assert.equal((await get("/?capability=kaspa.digest&maxPrice=0.01", cfg)).body.count, 0);
  assert.equal((await get("/?network=kaspa:testnet-10", cfg)).body.count, 2);
  assert.equal((await get("/?q=weather", cfg)).body.count, 1);
});

test("several capabilities can arrive as repeats or as one comma list", async () => {
  const cfg = config([WEATHER, DIGEST]);
  const a = await get("/?capability=weather.current&capability=weather.forecast", cfg);
  const b = await get("/?capability=weather.current,weather.forecast", cfg);
  assert.equal(a.body.count, 1);
  assert.deepEqual(b.body.query.capability, a.body.query.capability);
});

test("/services is the same route as /", async () => {
  const cfg = config([WEATHER]);
  assert.equal((await get("/services", cfg)).body.count, (await get("/", cfg)).body.count);
});

test("/verify checks one listing and needs no index at all", async () => {
  const cfg = config([]);
  const good = await get("/verify?url=" + encodeURIComponent(WEATHER), cfg);
  assert.equal(good.res.status, 200);
  assert.equal(good.body.ok, true);
  assert.equal(good.res.headers.get("cache-control"), "no-store");

  const bad = await get("/verify?url=" + encodeURIComponent("https://vanished.test/x.json"), cfg);
  assert.equal(bad.res.status, 422);
  assert.equal(bad.body.ok, false);
});

test("/verify refuses what it cannot check, and says why", async () => {
  const cfg = config([]);
  assert.equal((await get("/verify", cfg)).res.status, 400);
  assert.equal((await get("/verify?url=not-a-url", cfg)).body.error, "not_a_url");
  const http = await get("/verify?url=" + encodeURIComponent("http://weather.test/x.json"), cfg);
  assert.equal(http.body.error, "not_https");
  assert.match(http.body.why, /money goes to/);
});

test("writes are refused and unknown routes list the real ones", async () => {
  const cfg = config([]);
  const post = await handle(new Request("https://registry.test/", { method: "POST" }), cfg);
  assert.equal(post.status, 405);
  const nope = await get("/anything", cfg);
  assert.equal(nope.res.status, 404);
  assert.deepEqual(nope.body.routes, ["/", "/services", "/verify?url="]);
});

test("browse is cacheable and briefly; verifying is not cached", async () => {
  const { res } = await get("/", config([WEATHER]));
  assert.match(res.headers.get("cache-control")!, /max-age=60/);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("readIndex is usable on its own, for a build step or a cron", async () => {
  const r = await readIndex(config([WEATHER, DIGEST]));
  assert.equal(r.listings.length, 2);
  assert.equal(r.dropped.length, 0);
});

/* ---- one host, several services ----------------------------------------
   The well-known path is per HOST, and a host can sell more than one thing.
   warda-demo-api.vercel.app is the real case: /fact at 0.03 to one payee and
   /digest at 0.04 to another. */

import { schnorr as _s } from "@noble/curves/secp256k1.js";
const SK2 = fromHex("22".repeat(32));
const PAYEE2 = toHex(_s.getPublicKey(SK2));

const MULTI = "https://shop.test/.well-known/warda-service.json";
const multiDoc = {
  version: 1,
  services: [
    signListing(manifest({ name: "Fact", endpoint: "https://shop.test/fact",
      capabilities: ["demo.fact"], pricing: { asset: "KAS", amount: "0.03", unit: "request" } }), SK),
    signListing(manifest({ name: "Digest", endpoint: "https://shop.test/digest",
      capabilities: ["kaspa.digest"], pricing: { asset: "KAS", amount: "0.04", unit: "request" },
      payee: PAYEE2 }), SK2),
  ],
};

test("one host can list several services, each signed by its own payee", async () => {
  const { body } = await get("/", config([MULTI], { [MULTI]: multiDoc }));
  assert.equal(body.count, 2);
  assert.deepEqual(body.services.map((s: any) => s.name).sort(), ["Digest", "Fact"]);
  assert.notEqual(body.services[0].payee, body.services[1].payee);
});

test("one bad entry does not take its neighbours down", async () => {
  const doc = { version: 1, services: [multiDoc.services[0], { ...multiDoc.services[1], signature: "ab".repeat(64) }] };
  const { body } = await get("/", config([MULTI], { [MULTI]: doc }));
  assert.equal(body.count, 1);
  assert.equal(body.services[0].name, "Fact");
  assert.deepEqual(body.dropped, [{ source: MULTI, failures: ["SIGNATURE_DOES_NOT_VERIFY"] }]);
});

test("a host selling one thing need not wrap it in a list", async () => {
  const { body } = await get("/", config([WEATHER]));
  assert.equal(body.count, 1);
});

test("filters apply across a multi-service document", async () => {
  const cfg = config([MULTI], { [MULTI]: multiDoc });
  assert.equal((await get("/?maxPrice=0.035", cfg)).body.count, 1);
  assert.equal((await get("/?capability=kaspa.digest", cfg)).body.count, 1);
});

test("the service reports each listing's derived tier, and can filter on it", async () => {
  const relayed = signListing(
    manifest({ payment: { protocol: "kaspa-x402-v2", network: "kaspa:testnet-10", warda: true } }),
    SK,
  );
  const settled = signListing(
    manifest({
      name: "Direct Agent",
      endpoint: "https://direct.test/api",
      payment: { protocol: "warda", network: "kaspa:testnet-10", warda: true },
    }),
    SK,
  );
  const DIRECT = "https://direct.test/.well-known/warda-service.json";
  const cfg = {
    sources: [WEATHER, DIRECT],
    fetchOptions: {
      fetch: web({ [WEATHER]: { services: [relayed] }, [DIRECT]: { services: [settled] } }),
    },
  };

  const all = await (await handle(new Request("https://reg.test/services"), cfg as never)).json();
  assert.equal(all.count, 2);
  const tiers = all.services.map((s: { name: string; settlement: string }) => [s.name, s.settlement]).sort();
  assert.deepEqual(tiers, [["Direct Agent", "settled"], ["Weather Agent", "relayed"]]);
  assert.equal(
    all.services.find((s: { name: string }) => s.name === "Direct Agent").authorisedToPayMe,
    "yes",
  );

  const only = await (
    await handle(new Request("https://reg.test/services?settlement=settled"), cfg as never)
  ).json();
  assert.equal(only.count, 1);
  assert.equal(only.services[0].name, "Direct Agent");

  /* A typo must not widen the result set. */
  const typo = await (
    await handle(new Request("https://reg.test/services?settlement=setled"), cfg as never)
  ).json();
  assert.equal(typo.count, 2, "an unrecognised tier is ignored as a filter, not treated as a match");
});
