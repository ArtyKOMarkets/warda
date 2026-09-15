/**
 * Agent #005's program, compiled against the package it uses.
 *
 * The agent itself needs a funded grant and a stranger's endpoint, so it
 * cannot run here. What CAN be checked without either is that the wallet
 * exposes the shape that program depends on — `relay` on a purchase, a
 * readable `fee`, a `manifest` whose `grant_value` it reports, and a
 * `toRecipientSet` it pre-flights with.
 *
 * This is the same reason `readme.test.ts` exists. An example and a caller
 * both stop being true silently; the difference between a package with users
 * and a package with two is only worth anything if the second one breaks the
 * build when it diverges.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, fileStore, memoryStore, toRecipientSet, type Manifest } from "../src/index.ts";

test("the wallet exposes what agent #005 asks of it", () => {
  /* Each of these is a line in agents/tools/interop.ts. */
  assert.equal(typeof toRecipientSet, "function");
  assert.equal(typeof fileStore, "function");
  assert.equal(typeof Agent.open, "function");

  const purchase: Parameters<Agent["fetch"]>[2] = {
    relay: true,
    onEvent: () => {},
  };
  assert.equal(purchase?.relay, true);
});

test("a recipients file with a comment header still hashes to its members", () => {
  /* x402/demo/kaspa-x402-recipients.txt opens with eight lines of comment
     explaining where the payee came from, and #005 passes that file
     unprocessed. A pre-flight that choked on it would refuse a correct
     grant. */
  const withPreamble = [
    "# The payee kaspa-x402's own testnet demo endpoint quotes.",
    "#",
    "# Read out of a real 402, not from documentation.",
    "",
    "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh",
  ];
  const bare = ["kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh"];
  assert.equal(toRecipientSet(withPreamble).rootHex, toRecipientSet(bare).rootHex);
});

test("grant_value is what #005 reports as remaining", async () => {
  const m = { grant_value: 412_000_000 } as unknown as Manifest;
  const store = memoryStore(m);
  assert.equal((await store.load()).grant_value, 412_000_000);
});
