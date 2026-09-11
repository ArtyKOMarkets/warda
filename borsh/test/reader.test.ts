/**
 * The reader, against a recorded WASM reply.
 *
 * Nothing here talks to a resolver. A test that needed one would be a test
 * that fails on a train, and the thing worth pinning is not "borsh works" —
 * that is kaspad's problem — but that a reply coming back through the WASM
 * client lands in the SAME shape the JSON transport produces. Two transports
 * that disagree about what a UTXO is would be found by a vendor, in
 * production, on the one payment that mattered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "@warda_protocol/kaspa";
import { BorshReader, CovenantUnanswerable, WriteNotSupported, type WasmRpc } from "../src/index.ts";

/** Amounts arrive as bigints here and as strings over JSON. Both must parse. */
const ENTRY = {
  address: "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4",
  outpoint: { transactionId: "aa".repeat(32), index: 1 },
  utxoEntry: {
    amount: 2_000_000n,
    scriptPublicKey: { version: 0, script: "20" + "bb".repeat(32) + "ac" },
    blockDaaScore: 91_234_567n,
    isCoinbase: false,
  },
};

function fake(over: Partial<WasmRpc> = {}, reply: unknown = { entries: [ENTRY] }): WasmRpc {
  return {
    connect: async () => {},
    disconnect: async () => {},
    url: "wss://eric.kaspa.stream/v2/kaspa/testnet-10/wrpc/borsh",
    getServerInfo: async () => ({
      serverVersion: "1.0.1",
      isSynced: true,
      isUtxoIndexed: true,
      mempoolSize: 7n,
      p2pId: "abc",
    }),
    getBlockDagInfo: async () => ({
      network: "kaspa-testnet-10",
      virtualDaaScore: 91_234_600n,
      blockCount: 5n,
      sink: "cc".repeat(32),
      pruningPointHash: "dd".repeat(32),
      tipHashes: ["ee".repeat(32)],
    }),
    getUtxosByAddresses: async () => reply,
    ...over,
  };
}

test("a utxo read through borsh parses to the same shape as JSON", async () => {
  const r = await BorshReader.open({ client: fake() });
  const utxos = await r.getUtxosByAddresses([ENTRY.address]);
  assert.equal(utxos.length, 1);
  assert.equal(utxos[0]!.entry.value, 2_000_000n);
  assert.equal(utxos[0]!.entry.blockDaaScore, 91_234_567n);
  assert.equal(utxos[0]!.entry.isCoinbase, false);
  assert.equal(utxos[0]!.outpoint.index, 1);
  assert.equal(utxos[0]!.outpoint.transactionId.length, 32);
  assert.equal(utxos[0]!.entry.scriptPublicKey.version, 0);
  // Absent, not zero-length: a vendor's coin is a plain P2PK output, and a
  // covenant id invented here would be a lie with a type signature.
  assert.equal(utxos[0]!.entry.covenantId, undefined);
});

test("a bare array reply normalises the same way", async () => {
  const r = await BorshReader.open({ client: fake({}, [ENTRY]) });
  const utxos = await r.getUtxosByAddresses([ENTRY.address]);
  assert.equal(utxos.length, 1);
  assert.equal(utxos[0]!.entry.value, 2_000_000n);
});

test("getServerInfo is reported as getInfo", async () => {
  const r = await BorshReader.open({ client: fake() });
  const info = await r.getInfo();
  assert.equal(info.isSynced, true);
  assert.equal(info.isUtxoIndexed, true);
  assert.equal(info.serverVersion, "1.0.1");
});

test("submitTransaction refuses, and says what would have been lost", async () => {
  const r = await BorshReader.open({ client: fake() });
  await assert.rejects(() => (r as any).submitTransaction(), (e: Error) => {
    assert.ok(e instanceof WriteNotSupported);
    assert.match(e.message, /covenant/);
    assert.match(e.message, /WARDA_RPC_JSON/);
    return true;
  });
});

test("the covenant question is unanswerable here, not answered wrongly", async () => {
  const r = await BorshReader.open({ client: fake() });
  await assert.rejects(
    () => r.assertCovenantAware("kaspatest:prw9hklems02v8apxlx5m6y0d90e0j6657ztr3c3cjqf0wsnwsxz2fs9n0jxr"),
    (e: Error) => e instanceof CovenantUnanswerable,
  );
});

/**
 * The point of implementing `Inspectable` rather than inventing a second
 * health check. A stranger's node is where these checks earn their keep.
 */
test("inspect runs against a borsh reader, and the covenant check is unknown", async () => {
  const r = await BorshReader.open({ client: fake() });
  const h = await inspect(r, {
    networkId: "testnet-10",
    grantAddress: "kaspatest:prw9hklems02v8apxlx5m6y0d90e0j6657ztr3c3cjqf0wsnwsxz2fs9n0jxr",
    tolerate: true,
  });
  assert.equal(h.checks.synced.ok, true);
  assert.equal(h.checks.utxoIndexed.ok, true);
  assert.equal(h.checks.network.ok, true);
  assert.equal(h.checks.covenants.ok, false);
  assert.match(h.checks.covenants.detail, /cannot say|unanswerable|three/i);
  assert.match(h.url, /kaspa\.stream/);
});

test("a node that is not utxo-indexed is caught before it answers with silence", async () => {
  const client = fake({
    getServerInfo: async () => ({
      serverVersion: "1.0.1",
      isSynced: true,
      isUtxoIndexed: false,
      mempoolSize: 0n,
      p2pId: "abc",
    }),
  });
  const r = await BorshReader.open({ client });
  const h = await inspect(r, { tolerate: true });
  assert.equal(h.checks.utxoIndexed.ok, false);
  assert.equal(h.usable, false);
});

test("the wrong network is caught, where every address is well-formed and absent", async () => {
  const r = await BorshReader.open({ client: fake() });
  const h = await inspect(r, { networkId: "mainnet", tolerate: true });
  assert.equal(h.checks.network.ok, false);
  assert.equal(h.usable, false);
});
