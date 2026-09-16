import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyListingSignature, listingDigestHex, checkOrigin, LISTING_TAG } from "../src/index.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The encoding is a WIRE FORMAT, and this is the test that says so.
 *
 * A listing lives on somebody else's server, signed once, possibly years ago,
 * by an operator who has no reason to ever look at it again. Change
 * `encodeListing` — reorder a field, stop sorting capabilities, switch a length
 * prefix — and every listing published anywhere stops verifying at once, with
 * no error on their side and no notification. They would find out by quietly
 * disappearing from the registry.
 *
 * So the bytes are frozen here against a real signature made by a real key: the
 * Warda demo vendor's, which is the address warda-demo-api.vercel.app is
 * actually paid at. If this test fails, the change is not a refactor — it is a
 * new version, and version 1 has to keep verifying.
 */
const PUBLISHED = JSON.parse(
  readFileSync(here("../examples/warda-fact.signed.json"), "utf8"),
);

test("a listing signed against version 1 still verifies", () => {
  const v = verifyListingSignature(PUBLISHED);
  assert.equal(v.ok, true, `version-1 listings stopped verifying: ${v.failures.join(", ")}`);
});

test("the digest for that listing has not moved", () => {
  /* Pinned literally. The signature check above would catch a change too, but
     this names WHICH half moved — the encoding or the signature scheme — and
     the difference is the difference between a bug and a break. */
  assert.equal(
    listingDigestHex(PUBLISHED),
    "2b59b708d650141dee04373deb10be467fc57ceb5add39b6745b1b141d5822bb",
  );
});

test("the domain tag is part of the format and cannot drift", () => {
  assert.equal(LISTING_TAG, "warda:service:v1");
});

test("the published example is servable from the endpoint it names", () => {
  assert.deepEqual(
    checkOrigin(PUBLISHED, "https://warda-demo-api.vercel.app/.well-known/warda-service.json"),
    [],
  );
});

/**
 * A vector with capabilities OUT of order, because the example above has one
 * capability and therefore cannot tell a sorted encoding from an unsorted one.
 *
 * That gap was real: deleting the `.sort()` in `encodeListing` left every test
 * in this file passing. A frozen fixture only freezes what it exercises.
 */
const UNSORTED = {
  version: 1 as const,
  name: "Many things",
  description: "several capabilities, deliberately unsorted",
  endpoint: "https://example.com/api",
  capabilities: ["zeta.last", "alpha.first", "mid.middle"],
  pricing: { asset: "KAS", amount: "0.02", unit: "request" },
  payment: { protocol: "x402", network: "kaspa:testnet-10", warda: true },
  payee: "11".repeat(32),
};

test("capability order does not change the digest, and the digest is pinned", () => {
  const sorted = { ...UNSORTED, capabilities: [...UNSORTED.capabilities].sort() };
  assert.equal(listingDigestHex(UNSORTED), listingDigestHex(sorted));
  assert.equal(
    listingDigestHex(UNSORTED),
    "329bc45f0752eff595395ae629d170117db6b499c2377a273853d939d6abc5d4",
  );
});
