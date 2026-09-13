import test from "node:test";
import assert from "node:assert/strict";

import { openNode } from "../src/index.ts";

/**
 * The fallback that could not work.
 *
 * `openNode` resolved a node and dialled it over JSON, and the public
 * resolvers do not serve JSON. So the fallback was dead from the day it was
 * written, and it failed in the language of a transient network fault --
 * "resolver did not answer: fetch failed" -- which is why it misled the
 * people who wrote it, twice, while a real payment sat unserved.
 *
 * There is no network here. What is pinned is the FAILURE: when a vendor has
 * nothing it can read, the message names the reason and the fix rather than
 * blaming the connection.
 */
test("a vendor with no node it can read says what to install", async () => {
  await assert.rejects(
    () => openNode({ network: "testnet-10", fallback: "none" }),
    (e: Error) => {
      assert.match(e.message, /no node it can read/);
      // The fact that makes the fix obvious rather than arbitrary.
      assert.match(e.message, /never submits a transaction/);
      assert.match(e.message, /serve borsh and not JSON/);
      assert.match(e.message, /@warda_protocol\/borsh/);
      return true;
    },
  );
});

test("a seller may refuse a node it does not control, and get a 503 instead", async () => {
  // The trade is the seller's to make. Refusing it is not an error state.
  await assert.rejects(
    () => openNode({ network: "testnet-10", fallback: "none" }),
    /no node it can read/,
  );
});

test("an unreachable named node is reported before the advice", async () => {
  await assert.rejects(
    () => openNode({ network: "testnet-10", rpc: "ws://127.0.0.1:9", fallback: "none" }),
    (e: Error) => {
      // The operator's own node failing is the first thing they need to know;
      // what to install is the second.
      assert.ok(e.message.indexOf("no node it can read") > 0, "the node failure comes first");
      return true;
    },
  );
});
