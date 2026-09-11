/**
 * The network guard, tested by RUNNING the tools rather than the function.
 *
 * `resolveNetwork` exits the process, which is right for a command-line tool
 * and impossible to assert on in-process. Spawning is also the only way to
 * test the thing that actually matters: not that the function returns a
 * verdict, but that a tool invoked with these arguments does not proceed. A
 * unit test of the checker would keep passing on the day someone adds a
 * seventeenth tool and forgets to call it.
 *
 * These are the four states, and three of them are silent failures today
 * without this guard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tool = (name: string) => fileURLToPath(new URL(`../tools/${name}`, import.meta.url));

const run = (name: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["--experimental-strip-types", tool(name), ...args], {
    encoding: "utf8",
    /* Every variable that can decide a chain is cleared, not just the two that
       were known about when this was written. WARDA_NETWORK was missed, and
       ops/node.env exports it — so on a machine configured to talk to a node,
       "testnet needs no ceremony" derived a MAINNET key, the guard correctly
       refused, and the test read that refusal as a bug in the guard.

       A test that sanitizes its environment has to sanitize all of it. The
       ones below that care about a network pass it as a flag, which is the
       only way a test should say so. */
    env: { ...process.env, WARDA_MAINNET: "", WARDA_SK: "", WARDA_NETWORK: "", WARDA_PREFIX: "", ...env },
  });

test("testnet is unchanged: no flags, no ceremony", () => {
  const r = run("new-key.ts", ["--label", "t"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout + r.stderr, /kaspatest:/);
});

test("a prefix and a network that disagree are refused, not silently derived", () => {
  const r = run("new-key.ts", ["--prefix", "kaspa", "--network", "testnet-10"]);
  assert.notEqual(r.status, 0, "it must not proceed");
  assert.match(r.stderr, /disagree/);
  // The reason matters more than the refusal: this failure has no exception
  // anywhere, and an operator who does not understand why will pass the flag
  // that makes it "work".
  assert.match(r.stderr, /well-formed address on the wrong chain/);
  assert.doesNotMatch(r.stdout, /kaspa:/, "no address may be printed");
});

test("mainnet is not reachable by omission", () => {
  const r = run("new-key.ts", ["--prefix", "kaspa", "--network", "mainnet"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MAINNET without being told to/);
  assert.match(r.stderr, /WARDA_MAINNET=1/, "it says how to mean it");
});

test("mainnet proceeds once it is stated", () => {
  const r = run("new-key.ts", ["--prefix", "kaspa", "--network", "mainnet"], {
    WARDA_MAINNET: "1",
  });
  assert.equal(r.status, 0, "the guard is a decision point, not a prohibition");
  assert.match(r.stdout + r.stderr, /kaspa:/);
});

/**
 * The one with no override.
 *
 * `/attack` publishes a working agent key so strangers can try to steal from a
 * live grant. That is the demonstration. The same key on mainnet is a loaded
 * gun aimed at whoever reads the page and follows along with real coin, and
 * WARDA_MAINNET must not be enough to fire it.
 */
test("a published key is refused on mainnet even when mainnet is stated", () => {
  const r = run("wallet.ts", ["--prefix", "kaspa", "--network", "mainnet"], {
    WARDA_MAINNET: "1",
    WARDA_SK: "9fccfb08645b4a5a49f0f461b9ae7209865c234f941e9d4679e8a18da77af2ad",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /that key is PUBLISHED/);
  assert.match(r.stderr, /no flag for this/);
});

test("the same key on testnet is a note, not a refusal", () => {
  const r = run("wallet.ts", [], {
    WARDA_SK: "9fccfb08645b4a5a49f0f461b9ae7209865c234f941e9d4679e8a18da77af2ad",
  });
  assert.match(r.stderr, /PUBLISHED demo key/);
  // It stops for want of a node, which is a different refusal entirely — the
  // point is that the key itself did not stop it.
  assert.doesNotMatch(r.stderr, /no flag for this/);
});
