/**
 * A principal key may not be made on a machine that runs agents.
 *
 * `ops/PRINCIPAL.md` is four pages on generating this key on a machine that has
 * never run an agent, a runner or a node, and `ops/principal-bundle.sh` builds and
 * verifies the thing to carry there. On 26 September 2026 the key was made on the
 * wrong machine TWICE within an hour, and the two failures are different, which is
 * why both are pinned here.
 *
 * **Once in a repository root.** `cd` into the bundle failed — it is in $HOME, not
 * the repo — and the next line of a pasted block ran anyway. A procedure that is
 * right, written down and read is still a procedure a failed `cd` walks past.
 *
 * **Once inside the carried bundle, on the same machine.** The guard written in
 * response to the first failure looked for `runner/.env`, `covenant/deploy` and the
 * rest RELATIVE TO THE CURRENT DIRECTORY — and a bundle is a directory you carry,
 * so it holds none of them wherever it is, including on the machine the document
 * forbids. The check was for the wrong noun: it asked about a directory and the
 * question is about a machine.
 *
 * So the signals below are all things a carried bundle cannot shed, and the test
 * that matters most is the third one — the bundle, on a machine with a checkout —
 * because that is the one that got through.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = (p: string) => fileURLToPath(new URL("../../" + p, import.meta.url));

/** A bundle-shaped directory: the SDK and its two dependencies, nothing else. */
function bundle(under?: string): string {
  const dir = under ? join(under, "warda-principal-offline") : mkdtempSync(join(tmpdir(), "warda-pg-"));
  mkdirSync(join(dir, "node_modules/@noble"), { recursive: true });
  mkdirSync(join(dir, "node_modules/@warda_protocol"), { recursive: true });
  symlinkSync(repo("sdk"), join(dir, "sdk"));
  symlinkSync(repo("node_modules/@noble/curves"), join(dir, "node_modules/@noble/curves"));
  symlinkSync(repo("node_modules/@noble/hashes"), join(dir, "node_modules/@noble/hashes"));
  symlinkSync(join(dir, "sdk"), join(dir, "node_modules/@warda_protocol/kaspa"));
  return dir;
}

/** An empty home, so the machine-level signals are the test's to set. */
const home = () => mkdtempSync(join(tmpdir(), "warda-home-"));

/**
 * Run with HOME and PATH controlled.
 *
 * HOME because every machine-level signal is relative to it, and the real one
 * belongs to whoever is running the suite. PATH without the system directories
 * unless asked, so `crontab` is absent — which is what the offline machine looks
 * like, and what makes a refusal in these cases attributable to the signal the
 * case set rather than to the tester's own crontab.
 */
function run(cwd: string, label: string, env: Record<string, string> = {}) {
  /* `process.execPath`, not "node". PATH is deliberately empty below so that
     `crontab` is absent unless a case provides one — and the first version of that
     spawned "node" by name, which PATH could no longer find, so every case failed
     with a null exit code that read as the guard refusing. */
  const r = spawnSync(process.execPath, [
    "--experimental-strip-types", join(cwd, "sdk/tools/new-key.ts"),
    "--label", label, "--network", "testnet-10",
  ], { cwd, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent", ...env } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("a clean machine is ALLOWED — refusing it would refuse the only correct case", () => {
  const h = home();
  const dir = bundle(h);
  const { code, out } = run(dir, "principal", { HOME: h });
  assert.equal(code, 0, out);
  assert.match(out, /public  : [0-9a-f]{64}/);
});

test("standing IN the repository is refused, and it names what is in front of you", () => {
  const h = home();
  const dir = bundle(h);
  mkdirSync(join(dir, "runner"), { recursive: true });
  writeFileSync(join(dir, "runner/.env"), "DATABASE_URL=nope\n");
  const { code, out } = run(dir, "principal", { HOME: h });
  assert.equal(code, 2, out);
  assert.match(out, /Refusing to generate a PRINCIPAL key on this machine/);
  assert.match(out, /this directory/);
  assert.match(out, /runner\/\.env/);
  assert.doesNotMatch(out, /secret/, "and prints no key material whatsoever");
});

test("THE ONE THAT GOT THROUGH: a carried bundle on a machine that has a checkout", () => {
  /* The bundle holds no markers — it never does, that is what carrying it means.
     The evidence is elsewhere on the machine, which is where this now looks. */
  const h = home();
  const dir = bundle(h);
  const checkout = join(h, "Desktop", "warda");
  mkdirSync(join(checkout, "covenant", "deploy"), { recursive: true });
  const { code, out } = run(dir, "principal", { HOME: h });
  assert.equal(code, 2, out);
  assert.match(out, /a checkout on this machine/);
  assert.match(out, /covenant\/deploy/);
});

test("a crontab that runs Warda is enough on its own", () => {
  const h = home();
  const dir = bundle(h);
  /* The strongest signal and the one a bundle cannot carry: this machine has a
     schedule. Nineteen entries on the machine the key was made on. */
  const bin = mkdtempSync(join(tmpdir(), "warda-bin-"));
  writeFileSync(join(bin, "crontab"), "#!/bin/sh\necho '13 8,20 * * * /Users/x/Desktop/warda/ops/listener-pass.sh'\n", { mode: 0o755 });
  const { code, out } = run(dir, "principal", { HOME: h, PATH: `${bin}:/usr/bin:/bin` });
  assert.equal(code, 2, out);
  assert.match(out, /the crontab/);
  assert.match(out, /1 scheduled Warda job/);
});

test("~/.warda is enough on its own", () => {
  const h = home();
  const dir = bundle(h);
  mkdirSync(join(h, ".warda"), { recursive: true });
  const { code, out } = run(dir, "principal", { HOME: h });
  assert.equal(code, 2, out);
  assert.match(out, /~\/\.warda/);
});

test("another party's key in the directory is enough on its own", () => {
  const h = home();
  const dir = bundle(h);
  writeFileSync(join(dir, "agent-009.key"), "00".repeat(32) + "\n");
  const { code, out } = run(dir, "principal", { HOME: h });
  assert.equal(code, 2, out);
  assert.match(out, /other \*\.key file/);
});

test("the second run the bundle's own instructions ask for is still allowed", () => {
  const h = home();
  const dir = bundle(h);
  /* MAKE-THE-KEY.txt says: generate it, then run again and check the public half
     DIFFERS, because two identical keys would mean a constant. An early version
     counted the principal.key it had just written as evidence of an agent machine
     and refused — so the guard against making the key in the wrong place made the
     check that it is random impossible to perform. */
  writeFileSync(join(dir, "principal.key"), "11".repeat(32) + "\n");
  const first = run(dir, "principal", { HOME: h });
  const second = run(dir, "principal", { HOME: h });
  assert.equal(first.code, 0, first.out);
  assert.equal(second.code, 0, second.out);
  const key = (s: string) => /public  : ([0-9a-f]{64})/.exec(s)?.[1];
  assert.ok(key(first.out) && key(second.out));
  assert.notEqual(key(first.out), key(second.out), "two runs, two keys");
});

test("a key that is not a principal is not governed by any of this", () => {
  const h = home();
  const dir = bundle(h);
  mkdirSync(join(h, ".warda"), { recursive: true });
  mkdirSync(join(dir, "runner"), { recursive: true });
  writeFileSync(join(dir, "runner/.env"), "DATABASE_URL=nope\n");
  /* Agent keys are MEANT to be made on the machine that runs the agent, and one of
     them is published on purpose on /attack. Only the principal is special. */
  const { code, out } = run(dir, "demo-agent", { HOME: h });
  assert.equal(code, 0, out);
});
