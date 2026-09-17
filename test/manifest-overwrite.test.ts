/**
 * A manifest is never written over.
 *
 * ## The failure this exists for
 *
 * A grant's address is blake2b of its state, and that state lives in exactly
 * one place: the manifest genesis writes before it broadcasts. The comment
 * above that write has always said so — "losing them strands the coin at an
 * address nobody can reconstruct" — and until 17 September 2026 the write
 * itself was unconditional. Running genesis twice in one directory put the
 * second grant's numbers on top of the first one's, and the first grant became
 * a funded coin that could no longer be revoked, reclaimed, or even named.
 *
 * That was possible for as long as this repository has existed and it never
 * happened, because creating a grant was something a person did by hand, once,
 * while watching. `warda topup` makes it something a schedule does — so the
 * successor's path is computed to be new AND genesis refuses if the
 * computation was ever wrong. The careful path is a habit; this is the rule.
 *
 * ## Spawned, not called
 *
 * The same reasoning as key-separation.test.ts: a unit test of a checker keeps
 * passing when somebody adds a code path that does not call it. Both tools are
 * run the way a person runs them, and the refusal has to come out of the
 * process — before anything is built, and with a non-zero status, because the
 * caller that must not proceed is `warda grant`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const KEY = "11".repeat(32);

const tool = (script: string, args: string[]) =>
  spawnSync("node", ["--experimental-strip-types", script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WARDA_SK: KEY },
  });

/** A manifest that is not this run's, with a value worth not losing. */
function existingManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), "warda-manifest-"));
  const path = join(dir, "grant.json");
  writeFileSync(path, JSON.stringify({ covenant: "do-not-lose-me" }, null, 2) + "\n");
  return path;
}

test("genesis refuses to write over a manifest that already exists", () => {
  const path = existingManifest();
  const r = tool("sdk/tools/genesis.ts", [
    "--agent", "22".repeat(32),
    "--recipients", "33".repeat(32),
    "--out", path,
    "--network", "testnet-10",
  ]);
  assert.notEqual(r.status, 0, "a refusal that exits 0 is not a refusal");
  assert.match(r.stderr, /already exists/);
  assert.match(r.stderr, /nothing is lost/i);
  assert.match(JSON.parse(readFileSync(path, "utf8")).covenant, /do-not-lose-me/);
});

test("--force is the way past it, and it has to be asked for", () => {
  const path = existingManifest();
  const r = tool("sdk/tools/genesis.ts", [
    "--agent", "22".repeat(32),
    "--recipients", "33".repeat(32),
    "--out", path,
    "--network", "testnet-10",
    "--force",
  ]);
  assert.doesNotMatch(r.stderr, /already exists/);
});

/**
 * quickstart checks too, and earlier.
 *
 * genesis is spawned after an agent key has been generated and written, so a
 * check only there costs a stray key file on disk before anything says no.
 */
test("quickstart refuses before it writes an agent key", () => {
  const path = existingManifest();
  const agentOut = path.replace(/grant\.json$/, "agent.key");
  const r = tool("sdk/tools/quickstart.ts", [
    "--recipients", "33".repeat(32),
    "--out", path,
    "--agent-out", agentOut,
    "--network", "testnet-10",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /already exists/);
  assert.equal(existsSync(agentOut), false, "it wrote a key on its way to refusing");
});
