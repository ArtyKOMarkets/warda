/**
 * The HTTP layer: routing, limits, and the error contract.
 *
 * A verifier is called by people who cannot tell a typo from a lie, so the
 * shape of a rejection is part of what the service is FOR. These tests assert
 * that every failure names a field or says whose fault it was — and that the
 * one failure which is not the caller's fault, a node that cannot be believed,
 * comes back as 503 rather than as a confident 200.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import type { AddressUtxo, DagInfo, NodeHealth } from "@warda_protocol/kaspa";
import { NodeUnusable, type ChainSource, type Live } from "../src/node.ts";
import { handler } from "../src/server.ts";

const HEALTH: NodeHealth = {
  url: "ws://recorded",
  serverVersion: "1.0.0-test",
  network: "kaspa-testnet-10",
  virtualDaaScore: 1_005_010n,
  checks: {
    synced: { ok: true, detail: "synced" },
    utxoIndexed: { ok: true, detail: "indexed" },
    network: { ok: true, detail: "kaspa-testnet-10" },
    covenants: { ok: true, detail: "covenant ids present" },
  },
  usable: true,
};

const DAG: DagInfo = {
  network: "kaspa-testnet-10",
  virtualDaaScore: 1_005_010n,
  blockCount: 1n,
  sink: "00".repeat(32),
  pruningPointHash: "00".repeat(32),
  tipHashes: [],
};

const empty: ChainSource = {
  acquire: async (): Promise<Live> => ({
    health: HEALTH,
    checkedAt: Date.now(),
    client: {
      async getUtxosByAddresses(): Promise<AddressUtxo[]> {
        return [];
      },
      async getBlockDagInfo() {
        return DAG;
      },
    },
  }),
};

const unusable: ChainSource = {
  acquire: async () => {
    throw new NodeUnusable("the node at ws://bad cannot be trusted with a grant", null);
  },
};

async function listen(source: ChainSource): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    void handler(source)(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { base: `http://127.0.0.1:${port}`, server };
}

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

async function open(source: ChainSource = empty): Promise<string> {
  const { base, server } = await listen(source);
  servers.push(server);
  return base;
}

test("the index names every route rather than 404ing the root", async () => {
  const base = await open();
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { endpoints: Record<string, string> };
  assert.ok(Object.keys(body.endpoints).length >= 5);
});

test("an unknown route lists the real ones", async () => {
  const base = await open();
  const res = await fetch(`${base}/v2/whatever`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; endpoints: Record<string, string> };
  assert.equal(body.error, "no_such_route");
  assert.ok(body.endpoints["POST /v1/verify"]);
});

test("the service is callable from a page", async () => {
  const base = await open();
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const pre = await fetch(`${base}/v1/verify`, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
});

test("answers are never cached, because a grant moves", async () => {
  const base = await open();
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a malformed body is a 400 that says what was wrong with it", async () => {
  const base = await open();
  const res = await fetch(`${base}/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; message: string };
  assert.equal(body.error, "invalid_request");
  assert.match(body.message, /not valid JSON/);
});

test("a bad manifest is a 400 that names the field", async () => {
  const base = await open();
  const res = await fetch(`${base}/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      manifest: {
        agent: "too short",
        principal: "21".repeat(32),
        revocation: "23".repeat(32),
        recipients_root: "13".repeat(32),
        not_before: "1000000",
        expires_at: "1007000",
        budget: "1000000000",
        max_per_spend: "200000000",
        epoch_limit: "500000000",
        epoch_length: "1000",
        delegation_depth: "2",
      },
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; field: string };
  assert.equal(body.error, "invalid_manifest");
  assert.equal(body.field, "agent");
});

test("an oversized body is refused before it is parsed", async () => {
  const base = await open();
  const res = await fetch(`${base}/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(1_100_000) }),
  });
  assert.equal(res.status, 413);
});

test("a node that cannot be believed is a 503, not a confident answer", async () => {
  const base = await open(unusable);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.equal(body.error, "node_unusable");
});

test("an address lookup works without a body at all", async () => {
  const base = await open();
  const res = await fetch(`${base}/v1/grant/kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { termsKnowable: boolean } };
  assert.equal(body.result.termsKnowable, false);
});

test("something that is not an address is refused as such", async () => {
  const base = await open();
  const res = await fetch(`${base}/v1/grant/not-an-address`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { field: string };
  assert.equal(body.field, "address");
});

test("a trailing slash is the same route", async () => {
  const base = await open();
  const res = await fetch(`${base}/health/`);
  assert.equal(res.status, 200);
});
