/**
 * The ordering rule, which is the only thing here that can lose money.
 *
 * A record advanced past a payment that was never delivered loses the proof
 * needed to collect it. A record left stale after a delivered payment is
 * recoverable by following the chain. Of the two ways to be wrong, only one is
 * reversible — so these tests are about which one this package chooses.
 *
 * Driven against a real HTTP server rather than a mocked fetch, because the
 * thing being checked is the interaction between a response arriving and a
 * write happening, and a mock that resolves instantly cannot fail in the
 * order that matters.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { templateFor } from "@warda_protocol/kaspa/templates";
import type { Chain, CovenantTemplate } from "@warda_protocol/kaspa";
import { Agent } from "../src/agent.ts";
import { memoryStore, type Manifest } from "../src/store.ts";

const PAYEE = "16e6af2030f7e4510d1a417391a7ff7ccad21864f17eef7ee035f0453e21a033";

const MANIFEST: Manifest = {
  covenant: "b3e5eeefacf2021f",
  covenant_id: "cfb69da048e363e9907e926cd48332f134fea854900fd75d88db89faa12976e6",
  agent: "b7c837bbf1d6e2d974594a8c0b91bcd193226176e57cbbee663f8538b16f914e",
  principal: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  revocation: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  recipients_root: "ba9e576ed159db9347d3f137e449cb31fbb802dcb77784dae6bea270e7ca92b2",
  not_before: 559742731,
  expires_at: 585662731,
  budget: 5_000_000_000,
  max_per_spend: 10_000_000,
  epoch_limit: 50_000_000,
  epoch_length: 1000,
  delegation_depth: 2,
  grant_value: 4_957_000_000,
  spent_total: 33_000_000,
  reserved: 0,
  epoch_index: 212,
  epoch_spent: 3_000_000,
  reserve_root: "803b111f3c3952f7b7c9cb2bd240759e755a85ab2c6223614d08f216dd6a3bd1",
};

/* Resolved from the FIXTURE, not pinned to the packaged template.
   `const TEMPLATE = covenantTemplate` is what let this file assert
   `covenant: "b3e5eeefacf2021f"` in its manifest while loading v5 — the two
   halves never met, so the pair could disagree for a day without a single test
   going red. Resolving makes the fixture's `covenant` field load-bearing: the
   next freeze moves the packaged template and this stays where the manifest
   says it is. */
const TEMPLATE = templateFor(MANIFEST, "the fixture manifest");

/* The agent key is DELIBERATELY public — it is the one published on /attack,
   for a grant whose limits are enforced by the covenant rather than by
   secrecy. Nothing here signs anything anyway. */
const SECRET = Uint8Array.from(
  Buffer.from("9fccfb08645b4a5a49f0f461b9ae7209865c234f941e9d4679e8a18da77af2ad", "hex"),
);

/**
 * A chain that answers nothing.
 *
 * Every test below stops before the chain is reached: a free endpoint never
 * pays, and a refused one never gets that far. Any call landing here is a test
 * that is not testing what it claims, so it throws rather than returning a
 * plausible empty answer — which is the same reason the covenant's own health
 * checks exist.
 */
const unreachable = new Proxy({ url: "test://unreachable", close: async () => {} } as unknown as Chain, {
  get(target, prop) {
    if (prop === "url" || prop === "close") return Reflect.get(target, prop);
    return () => {
      throw new Error(`the chain was reached (${String(prop)}), and this test should not have`);
    };
  },
});

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serving(handler: (url: string) => { status: number; body: string }): Promise<string> {
  const server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "/");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function agentFor(store = memoryStore(MANIFEST)) {
  const agent = await Agent.open({
    store,
    recipients: [PAYEE],
    sign: SECRET,
    chain: unreachable,
    template: TEMPLATE,
  });
  return { agent, store };
}

test("a free endpoint costs nothing and moves nothing", async () => {
  const base = await serving(() => ({ status: 200, body: '{"ok":true}' }));
  const { agent, store } = await agentFor();

  const out = await agent.fetch(`${base}/free`);
  assert.equal(out.response.status, 200);
  assert.equal(out.paid, undefined, "nothing was bought, so nothing may be reported as bought");

  /* And the record is untouched. A wallet that rewrites a manifest because a
     GET succeeded would move the grant's address for free. */
  assert.deepEqual(store.current(), MANIFEST);
});

test("a failed purchase leaves the record where it was", async () => {
  /* A 402 whose body is not a quote: wardaFetch cannot pay it, so this fails
     after the request and before any payment — the window in which a wallet
     that advances eagerly would corrupt the record. */
  const base = await serving(() => ({ status: 402, body: '{"nonsense":true}' }));
  const { agent, store } = await agentFor();

  await assert.rejects(() => agent.fetch(`${base}/paid`));
  assert.deepEqual(store.current(), MANIFEST, "an un-delivered purchase is a debt, not a spend");
});

test("state and manifest are readable, and the manifest is a copy", async () => {
  const { agent } = await agentFor();
  assert.equal(agent.state.spentTotal, 33_000_000n);
  assert.equal(agent.manifest.spent_total, 33_000_000);

  const m = agent.manifest;
  m.spent_total = 1;
  assert.equal(agent.manifest.spent_total, 33_000_000, "handing out the live record invites edits");
});

test("close does not shut a connection it was handed", async () => {
  let closed = false;
  const borrowed = new Proxy(unreachable, {
    get(t, p) {
      if (p === "close") return async () => { closed = true; };
      return Reflect.get(t, p);
    },
  }) as Chain;

  const agent = await Agent.open({
    store: memoryStore(MANIFEST),
    recipients: [PAYEE],
    sign: SECRET,
    chain: borrowed,
    template: TEMPLATE,
  });
  await agent.close();
  /* A long-lived agent shares one connection across many purchases. Closing a
     socket this package did not open is how the second purchase fails. */
  assert.equal(closed, false);
});
