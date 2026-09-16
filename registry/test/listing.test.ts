import { test } from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { toHex, fromHex } from "@warda_protocol/core";
import {
  signListing, verifyListingSignature, listingDigestHex, encodeListing,
  checkOrigin, fetchListing, search, wellKnownFor,
  type ServiceManifest,
} from "../src/index.ts";

const SK = fromHex("11".repeat(32));
const PAYEE = toHex(schnorr.getPublicKey(SK));
const OTHER_SK = fromHex("22".repeat(32));

function manifest(over: Partial<ServiceManifest> = {}): ServiceManifest {
  return {
    version: 1,
    name: "Weather Agent",
    description: "Current weather and forecasts",
    endpoint: "https://example.com/api",
    capabilities: ["weather.current", "weather.forecast"],
    pricing: { asset: "KAS", amount: "0.02", unit: "request" },
    payment: { protocol: "x402", network: "kaspa:testnet-10", warda: true },
    payee: PAYEE,
    ...over,
  };
}

test("a listing signed by its payee verifies", () => {
  const v = verifyListingSignature(signListing(manifest(), SK));
  assert.equal(v.ok, true);
  assert.deepEqual(v.failures, []);
});

test("signing with a key that is not the payee is refused at the signer", () => {
  assert.throws(() => signListing(manifest(), OTHER_SK), /not the payee/);
});

test("a signature by another key does not verify", () => {
  const m = manifest();
  const forged = { ...m, signature: toHex(schnorr.sign(fromHex(listingDigestHex(m)), OTHER_SK)) };
  const v = verifyListingSignature(forged);
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ["SIGNATURE_DOES_NOT_VERIFY"]);
});

test("changing any signed field breaks the signature", () => {
  const signed = signListing(manifest(), SK);
  for (const mutate of [
    (m: any) => { m.name = "Weather Agent "; },
    (m: any) => { m.description = "Current weather"; },
    (m: any) => { m.endpoint = "https://example.com/api2"; },
    (m: any) => { m.capabilities = ["weather.current"]; },
    (m: any) => { m.pricing.amount = "0.01"; },
    (m: any) => { m.pricing.unit = "call"; },
    (m: any) => { m.payment.network = "kaspa:mainnet"; },
    (m: any) => { m.payment.warda = false; },
  ]) {
    const copy = structuredClone(signed);
    mutate(copy);
    assert.equal(verifyListingSignature(copy).ok, false, JSON.stringify(copy).slice(0, 60));
  }
});

test("reordering capabilities does not break the signature", () => {
  const signed = signListing(manifest(), SK);
  const reordered = { ...signed, capabilities: [...signed.capabilities].reverse() };
  assert.equal(verifyListingSignature(reordered).ok, true);
});

/**
 * The delimiter attack, which is why fields are length-prefixed.
 *
 * Joined by a separator, a name of "a|b" with description "c" encodes the same
 * as name "a" with description "b|c" — one signature, two different listings.
 */
test("a field boundary cannot be moved by putting a separator inside a field", () => {
  const a = encodeListing(manifest({ name: "a|b", description: "c" }));
  const b = encodeListing(manifest({ name: "a", description: "b|c" }));
  assert.notEqual(toHex(a), toHex(b));
});

test("an empty capability list still encodes distinctly from one entry", () => {
  const a = encodeListing(manifest({ capabilities: [] }));
  const b = encodeListing(manifest({ capabilities: [""] }));
  assert.notEqual(toHex(a), toHex(b));
});

test("a malformed manifest says which part is wrong, and carries the digest", () => {
  assert.deepEqual(verifyListingSignature(null).failures, ["NOT_JSON"]);
  assert.ok(verifyListingSignature({ ...manifest(), version: 2 }).failures.includes("UNKNOWN_VERSION"));
  assert.ok(verifyListingSignature({ ...manifest(), payee: "nope" }).failures.includes("BAD_PAYEE"));
  assert.ok(verifyListingSignature(manifest()).failures.includes("BAD_SIGNATURE_SHAPE"));
  const v = verifyListingSignature({ ...manifest(), signature: "ab".repeat(64) });
  assert.equal(v.ok, false);
  assert.match(v.digest!, /^[0-9a-f]{64}$/);
});

/* A transaction signature is 65 bytes and a listing signature is 64. Neither
   verifier can be handed the other's and accept it. */
test("a 65-byte Warda spend signature is the wrong shape for a listing", () => {
  const sig65 = toHex(schnorr.sign(fromHex(listingDigestHex(manifest())), SK)) + "01";
  const v = verifyListingSignature({ ...manifest(), signature: sig65 });
  assert.deepEqual(v.failures, ["BAD_SIGNATURE_SHAPE"]);
});

test("a manifest served from a host other than its endpoint's is not a listing", () => {
  const m = manifest();
  assert.deepEqual(checkOrigin(m, "https://example.com/.well-known/warda-service.json"), []);
  assert.deepEqual(checkOrigin(m, "https://attacker.test/.well-known/warda-service.json"), ["HOST_MISMATCH"]);
});

test("http is refused on both sides", () => {
  assert.ok(checkOrigin(manifest({ endpoint: "http://example.com/api" }),
    "https://example.com/.well-known/warda-service.json").includes("ENDPOINT_NOT_HTTPS"));
  assert.ok(checkOrigin(manifest(), "http://example.com/.well-known/warda-service.json")
    .includes("ENDPOINT_NOT_HTTPS"));
});

test("wellKnownFor derives the path from the endpoint", () => {
  assert.equal(wellKnownFor("https://example.com/api/v2"),
    "https://example.com/.well-known/warda-service.json");
});

/* ---- fetching ---------------------------------------------------------- */

function server(body: string, init: ResponseInit = {}) {
  return async () => new Response(body, { status: 200, ...init });
}

test("a good listing fetched from its own domain stands", async () => {
  const signed = signListing(manifest(), SK);
  const v = await fetchListing("https://example.com/.well-known/warda-service.json",
    { fetch: server(JSON.stringify(signed)) as any });
  assert.equal(v.ok, true);
  assert.equal(v.source, "https://example.com/.well-known/warda-service.json");
});

/**
 * Copying somebody else's published manifest is the obvious attack: a
 * signature is public, so it copies perfectly.
 */
test("a stolen manifest served from the thief's domain is refused", async () => {
  const signed = signListing(manifest(), SK);
  const v = await fetchListing("https://attacker.test/.well-known/warda-service.json",
    { fetch: server(JSON.stringify(signed)) as any });
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ["HOST_MISMATCH"]);
});

test("a server that is down, wrong or not JSON is reported as such", async () => {
  const down = async () => new Response("", { status: 503 });
  assert.deepEqual((await fetchListing("https://example.com/x", { fetch: down as any })).failures, ["UNREACHABLE"]);
  const html = server("<html>not json</html>");
  assert.deepEqual((await fetchListing("https://example.com/x", { fetch: html as any })).failures, ["NOT_JSON"]);
  const boom = async () => { throw new Error("dns"); };
  assert.deepEqual((await fetchListing("https://example.com/x", { fetch: boom as any })).failures, ["UNREACHABLE"]);
});

test("an oversized body is refused rather than read", async () => {
  const huge = server(JSON.stringify(signListing(manifest({ description: "x".repeat(200000) }), SK)));
  const v = await fetchListing("https://example.com/x", { fetch: huge as any });
  assert.deepEqual(v.failures, ["UNREACHABLE"]);
});

test("both problems come back together, not one at a time", async () => {
  const m = manifest();
  const bad = { ...m, signature: "ab".repeat(64) };
  const v = await fetchListing("https://attacker.test/.well-known/warda-service.json",
    { fetch: server(JSON.stringify(bad)) as any });
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures.sort(), ["HOST_MISMATCH", "SIGNATURE_DOES_NOT_VERIFY"]);
});

/* ---- matching ----------------------------------------------------------- */

const LISTINGS = [
  manifest({ name: "Weather", capabilities: ["weather.current"], pricing: { asset: "KAS", amount: "0.02", unit: "request" } }),
  manifest({ name: "Digest", capabilities: ["kaspa.digest", "kaspa.network.read"], pricing: { asset: "KAS", amount: "0.04", unit: "request" } }),
  manifest({ name: "Mainnet thing", payment: { protocol: "x402", network: "kaspa:mainnet", warda: true } }),
];

test("an empty query returns everything", () => {
  assert.equal(search(LISTINGS, {}).length, 3);
});

test("capabilities are a conjunction, not a union", () => {
  assert.equal(search(LISTINGS, { capability: ["kaspa.digest", "kaspa.network.read"] }).length, 1);
  assert.equal(search(LISTINGS, { capability: ["kaspa.digest", "weather.current"] }).length, 0);
});

test("maxPrice is a ceiling, and an unparseable price never slips under it", () => {
  assert.equal(search(LISTINGS, { maxPrice: "0.03" }).map((m) => m.name).join(), "Weather,Mainnet thing");
  const weird = [manifest({ name: "Free?", pricing: { asset: "KAS", amount: "ask us", unit: "request" } })];
  assert.equal(search(weird, { maxPrice: "1" }).length, 0);
});

test("network filters, case-insensitively", () => {
  assert.equal(search(LISTINGS, { network: "KASPA:MAINNET" }).length, 1);
});
