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

/**
 * The shape the real thing actually sends.
 *
 * Every test above this line used a fake built from kaspad's JSON shape —
 * `{address, outpoint, utxoEntry:{amount}}` — which is what the shared parser
 * reads. The WASM client flattens it: `amount` sits at the top of the entry.
 * So the fakes checked an assumption against itself, and the first live
 * resolver answered with `entry[0].amount: expected a number, got undefined`
 * in the middle of a vendor trying to confirm a payment.
 *
 * The spike written before this package hedged on exactly this. The hedge was
 * the evidence and it was not read.
 */
const FLAT = {
  address: ENTRY.address,
  outpoint: { transactionId: "cc".repeat(32), index: 0 },
  amount: 2_000_000n,
  scriptPublicKey: { version: 0, script: "20" + "dd".repeat(32) + "ac" },
  blockDaaScore: 91_234_567n,
  isCoinbase: false,
};

test("the WASM client's FLATTENED entry parses to the same shape", async () => {
  const r = await BorshReader.open({ client: fake({}, { entries: [FLAT] }) });
  const utxos = await r.getUtxosByAddresses([ENTRY.address]);
  assert.equal(utxos.length, 1);
  assert.equal(utxos[0]!.entry.value, 2_000_000n);
  assert.equal(utxos[0]!.entry.blockDaaScore, 91_234_567n);
  assert.equal(utxos[0]!.outpoint.index, 0);
  assert.equal(utxos[0]!.address, ENTRY.address);
});

test("both shapes land on identical output, which is the whole point", async () => {
  const nested = await (await BorshReader.open({ client: fake() })).getUtxosByAddresses(["x"]);
  const flat = await (await BorshReader.open({
    client: fake({}, { entries: [{ ...FLAT, outpoint: ENTRY.outpoint, scriptPublicKey: ENTRY.utxoEntry.scriptPublicKey }] }),
  })).getUtxosByAddresses(["x"]);
  assert.equal(flat[0]!.entry.value, nested[0]!.entry.value);
  assert.deepEqual(flat[0]!.outpoint.transactionId, nested[0]!.outpoint.transactionId);
});

test("an unknown shape reports what was probed, not what was missing", async () => {
  const r = await BorshReader.open({ client: fake({}, { entries: [{ nonsense: 1, other: 2 }] }) });
  await assert.rejects(() => r.getUtxosByAddresses(["x"]), (e: Error) => {
    assert.match(e.message, /shape this reader does not know/);
    // Listing Object.keys was the first instinct and is useless here: the
    // objects that actually break this report none.
    assert.match(e.message, /amount=undefined/);
    assert.match(e.message, /scriptPublicKey=undefined/);
    return true;
  });
});

/**
 * A wasm-bindgen object, which is what the real client actually returns.
 *
 * Its fields are getters on the PROTOTYPE, not own enumerable properties. The
 * first normaliser used object spread — which copies own enumerable
 * properties only — so it produced `{}` and every field came back undefined.
 * All eleven tests above passed, because they used object literals, which do
 * have own properties. The bug reached a live vendor and cost a redeploy
 * cycle to see.
 *
 * This fake is the shape that matters: nothing is an own property.
 */
function wasmLike(fields: Record<string, unknown>): object {
  const proto = {};
  for (const [k, v] of Object.entries(fields)) {
    Object.defineProperty(proto, k, { get: () => v, enumerable: false, configurable: true });
  }
  return Object.create(proto);
}

test("an entry whose fields are prototype getters still parses", async () => {
  const entry = wasmLike({
    address: ENTRY.address,
    outpoint: wasmLike({ transactionId: "ee".repeat(32), index: 3 }),
    amount: 2_000_000n,
    scriptPublicKey: { version: 0, script: "20" + "ff".repeat(32) + "ac" },
    blockDaaScore: 91_234_567n,
    isCoinbase: false,
  });
  // The property the old code lost: spreading this gives {}.
  assert.deepEqual({ ...(entry as object) }, {}, "precondition: nothing is an own property");

  const r = await BorshReader.open({ client: fake({}, { entries: [entry] }) });
  const utxos = await r.getUtxosByAddresses([ENTRY.address]);
  assert.equal(utxos[0]!.entry.value, 2_000_000n);
  assert.equal(utxos[0]!.entry.blockDaaScore, 91_234_567n);
  assert.equal(utxos[0]!.outpoint.index, 3);
});

test("the diagnosis lists what was probed, since a wasm object reports no keys", async () => {
  const r = await BorshReader.open({ client: fake({}, { entries: [wasmLike({ nothing: 1 })] }) });
  await assert.rejects(() => r.getUtxosByAddresses(["x"]), (e: Error) => {
    assert.match(e.message, /amount=undefined/);
    assert.match(e.message, /prototype getters/);
    return true;
  });
});

// ---- the recorded thing --------------------------------------------------
//
// Everything above is a fake, and every fake above was written by the same
// hand that wrote the reader — which is how a normaliser built on object
// spread passed eleven tests and then failed on the first live resolver. The
// fake agreed with the assumption because it was made from it.
//
// `test/fixtures/borsh-utxo.json` was captured from
// wss://electron-10.kaspa.blue/kaspa/testnet-10/wrpc/borsh, and it records the
// SHAPE, not just the values: constructor names, own keys, prototype keys, and
// what a spread of the object actually yields. `capturedEntry()` rebuilds it
// with that same own/prototype split, so this is the one test here that is not
// a paraphrase of what the reader already believes.
//
// It found a second bug the hand-written fakes could not: `.address` is an
// `Address` object, not a string.
import { capture, capturedEntry, capturedEntryNestedOnly } from "../../test/harness/borsh-fixture.ts";

test("the recorded resolver reply is shaped the way the bug required", () => {
  // If these ever stop holding, the fixture has been re-captured against
  // something that is no longer wasm-bindgen, and the tests below are then
  // checking a different question than the one they were written for.
  assert.equal(capture.entry.constructor, "UtxoEntryReference");
  assert.deepEqual(capture.entry.spreadYields, ["__wbg_ptr"]);
  assert.deepEqual(Object.keys({ ...capturedEntry() }), ["__wbg_ptr"]);
  assert.match(capture.resolver, /wrpc\/borsh$/);
});

test("a UTXO recorded from a live resolver parses", async () => {
  const r = await BorshReader.open({ client: fake({}, { entries: [capturedEntry()] }) });
  const utxos = await r.getUtxosByAddresses([capture.address]);
  assert.equal(utxos.length, 1);
  assert.equal(utxos[0]!.entry.value, 3_000_000n);
  assert.equal(utxos[0]!.entry.blockDaaScore, 567_634_976n);
  assert.equal(utxos[0]!.entry.isCoinbase, false);
  assert.equal(utxos[0]!.outpoint.index, 1);
  assert.equal(utxos[0]!.entry.scriptPublicKey.version, 0);
  assert.equal(utxos[0]!.entry.scriptPublicKey.script.length, 34); // OP_DATA_32 <key> OP_CHECKSIG
});

/**
 * The bug the capture found.
 *
 * `AddressUtxo.address` is typed `string | null`, and the JSON transport sends
 * a string there. The WASM client sends an `Address` instance — an object with
 * `prefix` and `payload` getters — and the reader passed it straight through.
 * Nothing broke, because a vendor matches a payment on amount and transaction
 * id and never looks at this field. It would have broken the first time
 * someone compared it to an address, or serialized it into a report, where it
 * writes itself as `{}`.
 */
test("an Address object becomes the address string, not an object", async () => {
  const r = await BorshReader.open({ client: fake({}, { entries: [capturedEntry()] }) });
  const [u] = await r.getUtxosByAddresses([capture.address]);
  assert.equal(typeof u!.address, "string");
  assert.equal(u!.address, capture.address);
  // The failure this replaces: JSON.stringify of an Address is "{}".
  assert.equal(JSON.parse(JSON.stringify({ a: u!.address })).a, capture.address);
});

test("the same entry read through its nested `entry`, if the flattening ever goes", async () => {
  const entry = capturedEntryNestedOnly() as Record<string, unknown>;
  assert.equal(entry.amount, undefined, "precondition: nothing is flattened here");
  const r = await BorshReader.open({ client: fake({}, { entries: [entry] }) });
  const [u] = await r.getUtxosByAddresses([capture.address]);
  assert.equal(u!.entry.value, 3_000_000n);
  assert.equal(u!.entry.blockDaaScore, 567_634_976n);
  assert.equal(u!.outpoint.index, 1);
  assert.equal(u!.address, capture.address);
});
