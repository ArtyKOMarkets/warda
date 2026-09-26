/**
 * A principal key may not be made on a machine that runs agents.
 *
 * Written on 26 September 2026, an hour after it happened. `ops/PRINCIPAL.md` is
 * four pages on generating this key somewhere that has never run an agent, a
 * runner or a node; `ops/principal-bundle.sh` builds and verifies the thing to
 * carry. Both existed. The key was made in the repository root on the machine
 * that runs all three, because a `cd` into the bundle failed and the next line of
 * a pasted block ran anyway.
 *
 * Nothing checked. That is the whole finding: a procedure that is right, written
 * down, and read is still a procedure a failed `cd` walks straight past.
 *
 * The three cases below are the ones that matter — it refuses where it must, it
 * ALLOWS the offline bundle (refusing that would refuse the correct case), and it
 * allows the second run the bundle's own instructions ask for.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = (p: string) => fileURLToPath(new URL("../../" + p, import.meta.url));

/** A bundle-shaped directory: the SDK and its two dependencies, nothing else. */
function bundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "warda-pg-"));
  mkdirSync(join(dir, "node_modules/@noble"), { recursive: true });
  mkdirSync(join(dir, "node_modules/@warda_protocol"), { recursive: true });
  symlinkSync(repo("sdk"), join(dir, "sdk"));
  symlinkSync(repo("node_modules/@noble/curves"), join(dir, "node_modules/@noble/curves"));
  symlinkSync(repo("node_modules/@noble/hashes"), join(dir, "node_modules/@noble/hashes"));
  symlinkSync(join(dir, "sdk"), join(dir, "node_modules/@warda_protocol/kaspa"));
  return dir;
}

const run = (cwd: string, label: string) => {
  const r = spawnSync("node", [
    "--experimental-strip-types", join(cwd, "sdk/tools/new-key.ts"),
    "--label", label, "--network", "testnet-10",
  ], { cwd, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

test("a principal key is refused where an agent machine's markers are", () => {
  const dir = bundle();
  /* One marker is enough, and this is the cheapest of the six to fake: the
     runner's environment. On the real machine all six were present. */
  mkdirSync(join(dir, "runner"), { recursive: true });
  writeFileSync(join(dir, "runner/.env"), "DATABASE_URL=nope\n");
  const { code, out } = run(dir, "principal");
  assert.equal(code, 2, out);
  assert.match(out, /Refusing to generate a PRINCIPAL key here/);
  assert.match(out, /runner\/\.env/, "says which marker it found");
  assert.match(out, /no --force/, "and that there is no way round it");
  assert.doesNotMatch(out, /secret/, "and prints no key material whatsoever");
});

test("another party's key in the directory is enough on its own", () => {
  const dir = bundle();
  writeFileSync(join(dir, "agent-009.key"), "00".repeat(32) + "\n");
  const { code, out } = run(dir, "principal");
  assert.equal(code, 2, out);
  assert.match(out, /\*\.key file/);
});

test("the offline bundle itself is ALLOWED — refusing it would refuse the right case", () => {
  const dir = bundle();
  const { code, out } = run(dir, "principal");
  assert.equal(code, 0, out);
  assert.match(out, /public  : [0-9a-f]{64}/);
});

test("and so is the second run the bundle's own instructions ask for", () => {
  const dir = bundle();
  /* MAKE-THE-KEY.txt says: generate it, then run again and check the public half
     DIFFERS, because two identical keys would mean a constant. The first version
     of this guard counted the principal.key it had just written as evidence of an
     agent machine and refused — so the guard against making the key in the wrong
     place made the check that it is random impossible to perform. */
  writeFileSync(join(dir, "principal.key"), "11".repeat(32) + "\n");
  const first = run(dir, "principal");
  assert.equal(first.code, 0, first.out);
  const second = run(dir, "principal");
  assert.equal(second.code, 0, second.out);
  const key = (s: string) => /public  : ([0-9a-f]{64})/.exec(s)?.[1];
  assert.ok(key(first.out) && key(second.out));
  assert.notEqual(key(first.out), key(second.out), "two runs, two keys");
});

test("a key that is not a principal is not governed by any of this", () => {
  const dir = bundle();
  mkdirSync(join(dir, "runner"), { recursive: true });
  writeFileSync(join(dir, "runner/.env"), "DATABASE_URL=nope\n");
  /* Agent keys are MEANT to be made on the machine that runs the agent, and one
     of them is published on purpose on /attack. Only the principal is special. */
  const { code, out } = run(dir, "demo-agent");
  assert.equal(code, 0, out);
});
