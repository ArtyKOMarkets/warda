/**
 * The README's example, compiled.
 *
 * A README is documentation until it stops matching the code, at which point
 * it is a bug report written in advance by the person who will hit it. This
 * file is the same five lines the README opens with; it does not run them —
 * that needs a chain — but it will not TYPECHECK if the shape drifts, which is
 * how a published example goes wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, fileStore, memoryStore, type Store } from "../src/index.ts";

test("the README's opening example has the shape the package exports", () => {
  const options = {
    store: fileStore("grant.json"),
    recipients: ["kaspatest:qq7xj0mpl0p46875mnkzhwatdy478pjkum745srhaey44l9jx566zefjaam3e"],
    sign: new Uint8Array(32),
    borsh: true,
  };
  /* Typed, not called: Agent.open dials a node. */
  const open: (o: typeof options) => Promise<Agent> = Agent.open;
  assert.equal(typeof open, "function");
});

test("a Store is anything with load and save, as the README claims", () => {
  const custom: Store = {
    async load() {
      return (await memoryStore({} as never).load()) as never;
    },
    async save() {},
  };
  assert.equal(typeof custom.load, "function");
  assert.equal(typeof custom.save, "function");
});
