/**
 * The demo vendor sells for two parties, and which address a route quotes is
 * the whole difference.
 *
 * Worth a test rather than a comment because the failure is silent and
 * expensive: collapse `payTo` back onto one server-wide address and every
 * route still answers 402, still verifies a payment, still returns a body.
 * What breaks is invisible from the outside — agent #002's grant commits to
 * agent #001's address, so a /digest quote naming the demo vendor is a quote
 * #002 must refuse, and the demonstration that a grant's payee list binds
 * turns into a demonstration that it does not.
 *
 * Neither path here touches the network: the quote is issued before any
 * payment exists, and an unconfigured seller is refused before a node is
 * dialled.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { serve } from "../demo-server/vendor.ts";

const DEMO = "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";
const AGENT_001 = "kaspatest:qq7xj0mpl0p46875mnkzhwatdy478pjkum745srhaey44l9jx566zefjaam3e";

/** The two objects `serve` actually uses, and nothing else. */
function exchange(headers: Record<string, string> = {}) {
  const res = {
    code: 0,
    body: "",
    writeHead(code: number) { this.code = code; return this; },
    end(s: string) { this.body = s; },
  };
  return { req: { headers } as never, res: res as never, out: res };
}

async function quoteFor(path: string) {
  const { req, res, out } = exchange();
  await serve(path, req, res);
  return { status: out.code, body: JSON.parse(out.body) };
}

test("each route quotes its own seller's address", async () => {
  process.env.WARDA_DEMO_VENDOR = DEMO;
  process.env.WARDA_AGENT_001_PAYEE = AGENT_001;
  process.env.WARDA_RPC_JSON = "ws://127.0.0.1:18210"; // never dialled on this path

  const fact = await quoteFor("/fact");
  assert.equal(fact.status, 402);
  assert.equal(fact.body.accepts[0].payTo, DEMO);

  const digest = await quoteFor("/digest");
  assert.equal(digest.status, 402);
  assert.equal(
    digest.body.accepts[0].payTo,
    AGENT_001,
    "/digest is sold by agent #001 and must quote agent #001's address, not the vendor's",
  );

  assert.notEqual(
    fact.body.accepts[0].payTo,
    digest.body.accepts[0].payTo,
    "if these are ever equal the second seller has been collapsed into the first",
  );
});

test("an unconfigured seller answers 503 on its own route only", async () => {
  process.env.WARDA_DEMO_VENDOR = DEMO;
  process.env.WARDA_RPC_JSON = "ws://127.0.0.1:18210";
  delete process.env.WARDA_AGENT_001_PAYEE;

  const digest = await quoteFor("/digest");
  assert.equal(digest.status, 503);
  assert.match(digest.body.detail, /WARDA_AGENT_001_PAYEE/);

  // The other seller is unaffected. A misconfigured second seller must not
  // cost the first one its traffic.
  const fact = await quoteFor("/fact");
  assert.equal(fact.status, 402);
  assert.equal(fact.body.accepts[0].payTo, DEMO);
});

test("the index lists who is paid for what", async () => {
  process.env.WARDA_DEMO_VENDOR = DEMO;
  process.env.WARDA_AGENT_001_PAYEE = AGENT_001;

  const { body } = await quoteFor("/");
  assert.equal(body.endpoints["/digest"].seller, "WARDA-001");
  assert.equal(body.endpoints["/digest"].payTo, AGENT_001);
  assert.equal(body.endpoints["/fact"].payTo, DEMO);
});

test("every price clears the storage-mass floor", async () => {
  process.env.WARDA_DEMO_VENDOR = DEMO;
  process.env.WARDA_AGENT_001_PAYEE = AGENT_001;

  /* Kaspa charges storage mass for small outputs and refuses a payment that
     exceeds the ceiling, which puts a floor at roughly 0.02 KAS under any
     payment at all. An endpoint priced below it is one nobody can buy from —
     and the failure arrives from consensus, at broadcast, after the buyer has
     built and signed a transaction. */
  const { body } = await quoteFor("/");
  for (const [path, v] of Object.entries(body.endpoints as Record<string, { price: string }>)) {
    const kas = Number(v.price.replace(" KAS", ""));
    assert.ok(kas >= 0.02, `${path} is priced at ${kas} KAS, below the ~0.02 storage-mass floor`);
  }
});
