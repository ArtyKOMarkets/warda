import { test } from "node:test";
import assert from "node:assert/strict";

import { candidateUrls } from "../src/rpc.ts";
import { resolverUrl, resolverFrom } from "../src/resolver.ts";
import { formatHealth, inspect, type NodeHealth } from "../src/node.ts";

/** A NodeClient's shape, without a socket. `inspect` only calls these three. */
function fakeClient(over: {
  synced?: boolean;
  indexed?: boolean;
  network?: string;
  covenantAware?: boolean;
}) {
  return {
    connection: { url: "ws://example:18210" },
    async getInfo() {
      return {
        serverVersion: "1.0.0",
        isSynced: over.synced ?? true,
        isUtxoIndexed: over.indexed ?? true,
        mempoolSize: 0n,
        p2pId: "",
      };
    },
    async getBlockDagInfo() {
      return {
        network: over.network ?? "testnet-10",
        virtualDaaScore: 558_979_403n,
        blockCount: 0n,
        sink: "",
        pruningPointHash: "",
        tipHashes: [],
      };
    },
    async assertCovenantAware() {
      if (over.covenantAware === false) throw new Error("reports no covenant id");
    },
  } as any;
}

const opts = { networkId: "testnet-10", grantAddress: "kaspatest:pq" };

test("a healthy node passes every check", async () => {
  const h: NodeHealth = await inspect(fakeClient({}), opts);
  assert.equal(h.usable, true);
  assert.equal(h.checks.covenants.ok, true);
});

test("a node with no utxo index is refused, because it answers with silence", async () => {
  const h = await inspect(fakeClient({ indexed: false }), opts);
  assert.equal(h.usable, false);
  // The reason matters more than the verdict: an empty UTXO list is what a
  // SPENT grant looks like, so this failure would otherwise be read as loss.
  assert.match(h.checks.utxoIndexed.detail, /your grant is gone/);
});

test("a node on the wrong network is refused", async () => {
  const h = await inspect(fakeClient({ network: "mainnet" }), opts);
  assert.equal(h.usable, false);
  assert.match(h.checks.network.detail, /well-formed and absent/);
});

test("an unsynced node is refused, since its DAA score sets the epoch", async () => {
  const h = await inspect(fakeClient({ synced: false }), opts);
  assert.equal(h.usable, false);
});

test("a pre-covenant node is refused", async () => {
  const h = await inspect(fakeClient({ covenantAware: false }), opts);
  assert.equal(h.usable, false);
});

test("with no grant address the covenant check is loud about not running", async () => {
  const h = await inspect(fakeClient({}), { networkId: "testnet-10" });
  // Not a failure — it cannot be run — but it must not read as a pass either.
  assert.equal(h.usable, true);
  assert.match(h.checks.covenants.detail, /UNCHECKED/);
});

test("a network nobody asked about is reported, not judged", async () => {
  const h = await inspect(fakeClient({ network: "mainnet" }), { grantAddress: "x" });
  assert.equal(h.checks.network.ok, true);
  assert.match(h.checks.network.detail, /nothing was asked/);
});

test("the report names the failing check, not just the verdict", async () => {
  const text = formatHealth(await inspect(fakeClient({ indexed: false }), opts));
  assert.match(text, /FAIL utxoIndexed/);
  assert.match(text, /ok   synced/);
});

// ---- where to look -------------------------------------------------------

test("an explicit url beats a list beats the environment", () => {
  const prev = process.env.WARDA_RPC_JSON;
  process.env.WARDA_RPC_JSON = "ws://env:18210";
  try {
    assert.deepEqual(candidateUrls({ url: "ws://a" }), ["ws://a"]);
    assert.deepEqual(candidateUrls({ urls: ["ws://a", "ws://b"] }), ["ws://a", "ws://b"]);
    assert.deepEqual(candidateUrls({}), ["ws://env:18210"]);
  } finally {
    if (prev === undefined) delete process.env.WARDA_RPC_JSON;
    else process.env.WARDA_RPC_JSON = prev;
  }
});

test("the environment carries a list, so failover needs no code change", () => {
  const prev = process.env.WARDA_RPC_JSON;
  process.env.WARDA_RPC_JSON = "ws://a:18210, ws://b:18210 ,";
  try {
    assert.deepEqual(candidateUrls({}), ["ws://a:18210", "ws://b:18210"]);
  } finally {
    if (prev === undefined) delete process.env.WARDA_RPC_JSON;
    else process.env.WARDA_RPC_JSON = prev;
  }
});

test("with nothing configured it still tries the local node", () => {
  const prev = process.env.WARDA_RPC_JSON;
  delete process.env.WARDA_RPC_JSON;
  try {
    assert.deepEqual(candidateUrls({}), ["ws://127.0.0.1:18210"]);
  } finally {
    if (prev !== undefined) process.env.WARDA_RPC_JSON = prev;
  }
});

// ---- the resolver --------------------------------------------------------

test("the resolver path asks for json, not borsh", () => {
  // Asking for borsh returns a node whose socket never answers a JSON call —
  // a failure that looks like a hung node rather than a wrong request.
  assert.equal(
    resolverUrl("https://r.example", "testnet-10", "any"),
    "https://r.example/v2/kaspa/testnet-10/any/wrpc/json",
  );
  assert.equal(
    resolverUrl("https://r.example/", "mainnet", "tls"),
    "https://r.example/v2/kaspa/mainnet/tls/wrpc/json",
  );
});

test("no resolver host is compiled in", () => {
  const prev = process.env.WARDA_RESOLVER;
  delete process.env.WARDA_RESOLVER;
  try {
    // A default here would be a list of parties this package vouches for, in
    // something installed once and used for years.
    assert.equal(resolverFrom({}), undefined);
    assert.equal(resolverFrom({ resolver: "https://r.example" }), "https://r.example");
  } finally {
    if (prev !== undefined) process.env.WARDA_RESOLVER = prev;
  }
});
