/**
 * The four ways a node ruins a day, each one produced on demand.
 *
 * `inspect` exists because every one of these returns a PLAUSIBLE WRONG
 * ANSWER rather than an error, and the wrong answer always reads as a problem
 * with the grant. Until now the only way to see one was to find a node in
 * that state — so the checks were written from reasoning and never watched
 * working.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { NodeClient, inspect } from "../sdk/src/index.ts";
import { startFakeNode } from "./harness/fake-node.ts";

const GRANT = "kaspatest:prw9hklems02v8apxlx5m6y0d90e0j6657ztr3c3cjqf0wsnwsxz2fs9n0jxr";

async function withNode<T>(fn: (n: Awaited<ReturnType<typeof startFakeNode>>) => Promise<T>): Promise<T> {
  const n = await startFakeNode();
  try { return await fn(n); } finally { await n.close(); }
}

test("a healthy node passes every check, against a real client", async () => {
  await withNode(async (n) => {
    n.utxos = [{
      address: GRANT, transactionId: "aa".repeat(32), index: 0,
      amount: 490_000_000n, scriptPublicKey: "0000" + "20" + "bb".repeat(32) + "ac",
      blockDaaScore: 567_599_000n, covenantId: "cc".repeat(32),
    }];
    const client = await NodeClient.connect({ url: n.url });
    const health = await inspect(client, { networkId: "testnet-10", grantAddress: GRANT });
    assert.equal(health.usable, true);
    assert.equal(health.checks.covenants.ok, true);
    client.close();
  });
});

test("a node with no utxo index answers with silence, and is refused for it", async () => {
  await withNode(async (n) => {
    n.mood = "noIndex";
    const client = await NodeClient.connect({ url: n.url });
    const health = await inspect(client, { networkId: "testnet-10", tolerate: true });
    assert.equal(health.checks.utxoIndexed.ok, false);
    assert.equal(health.usable, false);
    // The dangerous part: the address query succeeds and returns nothing.
    assert.deepEqual(await client.getUtxosByAddresses([GRANT]), []);
    client.close();
  });
});

test("a node on the wrong network finds nothing, and says which chain it is on", async () => {
  await withNode(async (n) => {
    n.mood = "wrongNetwork";
    const client = await NodeClient.connect({ url: n.url });
    const health = await inspect(client, { networkId: "testnet-10", tolerate: true });
    assert.equal(health.checks.network.ok, false);
    assert.match(health.checks.network.detail, /well-formed and absent/);
    client.close();
  });
});

test("an unsynced node is refused, because its DAA score sets the epoch", async () => {
  await withNode(async (n) => {
    n.mood = "unsynced";
    const client = await NodeClient.connect({ url: n.url });
    const health = await inspect(client, { networkId: "testnet-10", tolerate: true });
    assert.equal(health.checks.synced.ok, false);
    client.close();
  });
});

/**
 * The one whose failure produces a signed transaction instead of an error.
 * A pre-covenant node drops covenantId, the spend built from it carries no
 * binding, and it is refused by the network for reasons that read as a
 * covenant bug.
 */
test("a pre-covenant node drops the binding, and the covenant check catches it", async () => {
  await withNode(async (n) => {
    n.mood = "preCovenant";
    n.utxos = [{
      address: GRANT, transactionId: "aa".repeat(32), index: 0,
      amount: 490_000_000n, scriptPublicKey: "0000" + "20" + "bb".repeat(32) + "ac",
      blockDaaScore: 567_599_000n, covenantId: "cc".repeat(32),
    }];
    const client = await NodeClient.connect({ url: n.url });
    const health = await inspect(client, { networkId: "testnet-10", grantAddress: GRANT, tolerate: true });
    assert.equal(health.checks.covenants.ok, false);
    assert.equal(health.usable, false);
    // And the entry really does come back covenant-free, which is the trap.
    const [utxo] = await client.getUtxosByAddresses([GRANT]);
    assert.equal(utxo!.entry.covenantId, undefined);
    client.close();
  });
});

test("an empty address is UNKNOWN, not a failed node — a spend moves a grant", async () => {
  await withNode(async (n) => {
    const client = await NodeClient.connect({ url: n.url });
    const health = await inspect(client, { networkId: "testnet-10", grantAddress: GRANT, tolerate: true });
    assert.equal(health.checks.covenants.ok, true, "unknown must not make a good node unusable");
    assert.match(health.checks.covenants.detail, /UNKNOWN/);
    assert.equal(health.usable, true);
    client.close();
  });
});

test("a rejected submit reports the node's own words", async () => {
  await withNode(async (n) => {
    n.mood = "rejectSubmit";
    const client = await NodeClient.connect({ url: n.url });
    await assert.rejects(
      () => client.submitTransaction({
        version: 0, inputs: [], outputs: [], lockTime: 0n,
        subnetworkId: new Uint8Array(20), gas: 0n, payload: new Uint8Array(0),
      } as never),
      /under the required amount of 974600/,
    );
    client.close();
  });
});
