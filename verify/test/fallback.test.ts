/**
 * The fall-through, which is the only behaviour a fallback has.
 *
 * Every other test in this package injects a `ChainSource` and never touches
 * `NodeSource`, which meant the connection logic — the part that decides WHOSE
 * node answers — was the one piece of this service with no test at all. The
 * vendor package learned this the expensive way: its borsh fallback was
 * written, deployed, and did nothing for days, because the step above it threw
 * and the throw left the function before the fallback was ever consulted. A
 * chain you cannot make fail on purpose is a chain you have not tested.
 *
 * `ws://127.0.0.1:1` is the forced failure. Nothing listens there, the refusal
 * is immediate, and it needs no network — which matters, because a test that
 * reaches for a resolver is a test that fails on an aeroplane.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressUtxo, DagInfo, NodeInfo } from "@warda_protocol/kaspa";
import { NodeSource, NodeUnusable, type FallbackReader, type Readable } from "../src/node.ts";

const DEAD = "ws://127.0.0.1:1";

class FakeBorsh implements Readable {
  readonly url = "ws://a-strangers-node/borsh";
  closed = false;
  /* Written out rather than a parameter property: node's strip-only TypeScript
     refuses those, and `tsc --noEmit` does not, so the typecheck was green and
     the runtime was not. The same seam as everything else in this repo. */
  readonly carriesCovenants: boolean;
  constructor(carriesCovenants: boolean) {
    this.carriesCovenants = carriesCovenants;
  }
  async getInfo(): Promise<NodeInfo> {
    return {
      serverVersion: "2.0.1",
      isSynced: true,
      isUtxoIndexed: true,
      mempoolSize: 0n,
      p2pId: "fake",
    };
  }
  async getBlockDagInfo(): Promise<DagInfo> {
    return {
      network: "kaspa-testnet-10",
      virtualDaaScore: 1_005_010n,
      blockCount: 1n,
      sink: "00".repeat(32),
      pruningPointHash: "00".repeat(32),
      tipHashes: [],
    };
  }
  async assertCovenantAware(): Promise<void> {}
  async getUtxosByAddresses(): Promise<AddressUtxo[]> {
    return [];
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function serving(reader: FakeBorsh): FallbackReader {
  return { BorshReader: { open: async () => reader } };
}

test("with no borsh installed it names the install rather than the stack trace", async () => {
  const source = new NodeSource({
    url: DEAD,
    networkId: "testnet-10",
    loadFallbackReader: async () => null,
  });
  const e = await source.acquire().then(
    () => null,
    (err: unknown) => err as Error,
  );
  assert.ok(e instanceof NodeUnusable);
  assert.match(e.message, /npm install @warda_protocol\/borsh/);
});

test("a covenant-blind wasm build is refused, and the reader is closed", async () => {
  const reader = new FakeBorsh(false);
  const source = new NodeSource({
    url: DEAD,
    networkId: "testnet-10",
    loadFallbackReader: async () => serving(reader),
  });
  const e = await source.acquire().then(
    () => null,
    (err: unknown) => err as Error,
  );
  assert.ok(e instanceof NodeUnusable);
  /* The refusal has to say why a working connection was rejected, or the next
     person "fixes" it by deleting this check. */
  assert.match(e.message, /cannot carry a covenant id/);
  assert.match(e.message, /@kluster\/kaspa-wasm/);
  assert.equal(reader.closed, true, "a refused reader must not be left holding a socket");
});

test("fallback: none refuses without ever asking for a transport", async () => {
  let asked = false;
  const source = new NodeSource({
    url: DEAD,
    networkId: "testnet-10",
    fallback: "none",
    loadFallbackReader: async () => {
      asked = true;
      return null;
    },
  });
  const e = await source.acquire().then(
    () => null,
    (err: unknown) => err as Error,
  );
  assert.ok(e instanceof NodeUnusable);
  assert.match(e.message, /refused by configuration/);
  assert.equal(asked, false);
});

test("a covenant-carrying build serves, and is checked like any other node", async () => {
  const reader = new FakeBorsh(true);
  const source = new NodeSource({
    url: DEAD,
    networkId: "testnet-10",
    loadFallbackReader: async () => serving(reader),
  });
  const live = await source.acquire();
  assert.equal(live.client, reader);
  /* The four checks ran against the borsh reader, not around it — this is the
     whole reason `Inspectable` is an interface. */
  assert.equal(live.health.usable, true);
  assert.equal(live.health.url, "ws://a-strangers-node/borsh");
  assert.equal(live.health.checks.utxoIndexed.ok, true);
  assert.equal(live.health.network, "kaspa-testnet-10");
  source.close();
});

test("an unsynced stranger is refused, the same as an unsynced node of your own", async () => {
  const reader = new FakeBorsh(true);
  reader.getInfo = async () => ({
    serverVersion: "2.0.1",
    isSynced: false,
    isUtxoIndexed: true,
    mempoolSize: 0n,
    p2pId: "fake",
  });
  const source = new NodeSource({
    url: DEAD,
    networkId: "testnet-10",
    loadFallbackReader: async () => serving(reader),
  });
  const e = await source.acquire().then(
    () => null,
    (err: unknown) => err as Error,
  );
  assert.ok(e instanceof NodeUnusable);
  assert.match(e.message, /NOT SYNCED/);
});
