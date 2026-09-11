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

/* A real, decodable address. It was "kaspatest:pq", which is not one — the
   fake client never looked, so the tests passed while asserting behaviour the
   probe could not reach against a live node. */
const GRANT = "kaspatest:pqht28p6rry29l2sjyv6vfywcnsrw9fvfgfv2lp9ezy864sy2crugw8ndur3q";
const opts = { networkId: "testnet-10", grantAddress: GRANT };

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
  /**
   * "Nobody asked" has to mean the environment too.
   *
   * `inspect` falls back to WARDA_NETWORK when no network is passed, which is
   * correct and is why this test cannot simply omit the option: ops/node.env
   * exports that variable, so on any machine set up to talk to a node, somebody
   * HAS asked, the mainnet client below is judged against testnet-10, and this
   * fails. It passed on a clean shell and failed on a working one — backwards,
   * and it failed during `npm publish`, which is the worst moment to learn that
   * a test depends on whoever is running it.
   */
  const prev = process.env.WARDA_NETWORK;
  delete process.env.WARDA_NETWORK;
  try {
    const h = await inspect(fakeClient({ network: "mainnet" }), { grantAddress: "x" });
    assert.equal(h.checks.network.ok, true);
    assert.match(h.checks.network.detail, /nothing was asked/);
  } finally {
    if (prev === undefined) delete process.env.WARDA_NETWORK;
    else process.env.WARDA_NETWORK = prev;
  }
});

test("WARDA_NETWORK is an answer, so a node that disagrees with it is judged", async () => {
  /* The other half, which nothing covered: the fallback is a feature — an
     operator who has said which chain they are on should not have to repeat it
     to every call — and a test that only pins the null case would let it be
     deleted as dead code. */
  const prev = process.env.WARDA_NETWORK;
  process.env.WARDA_NETWORK = "testnet-10";
  try {
    const h = await inspect(fakeClient({ network: "mainnet" }), { grantAddress: "x" });
    assert.equal(h.checks.network.ok, false);
    assert.match(h.checks.network.detail, /well-formed and absent/);
  } finally {
    if (prev === undefined) delete process.env.WARDA_NETWORK;
    else process.env.WARDA_NETWORK = prev;
  }
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

test("a malformed grant address blames the address, not the node", async () => {
  /* Pasting a placeholder produced "this node would give you wrong answers
     rather than errors. Find another." about a healthy node that had not been
     asked a question it could answer. */
  const h = await inspect(fakeClient({}), {
    networkId: "testnet-10",
    grantAddress: "THE-NEW-ADDRESS",
  });
  assert.equal(h.usable, true, "an unusable address must not make the node unusable");
  assert.match(h.checks.covenants.detail, /not a valid Kaspa address/);
  assert.match(h.checks.covenants.detail, /about the address, not the node/);
});
