/**
 * The orchestrator, driven as a process, against a manifest in the real shape.
 *
 * Field names were guessed once while writing this and were wrong — `budget`,
 * not `budget_total`; no member list at all, only a root. Both would have
 * surfaced as a confusing failure in front of a live grant. So the fixture
 * here is written with the field names a real manifest uses, and the CLI is
 * spawned rather than imported, because argument parsing and `process.exit`
 * codes are half of what a tool is.
 *
 * Nothing here touches a chain: every case is one the rules refuse BEFORE a
 * transaction would be built, which is the whole reason those rules are a
 * module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { RecipientSet, agentPublicKey, blake2b256, toHex } from "@warda_protocol/kaspa";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../tools/batch.ts", import.meta.url));

const key = (s: string) => toHex(agentPublicKey(blake2b256(new TextEncoder().encode(s))));
const SEARCH = key("growth-search");
const INFERENCE = key("growth-inference");
const STRANGER = key("not-on-the-list");
const MEMBERS = [SEARCH, INFERENCE];

/** A manifest with the field names `build-delegation.ts` actually reads. */
function fixture(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "growth-"));
  const manifest = join(dir, "grant.json");
  const payees = join(dir, "payees.txt");
  writeFileSync(manifest, JSON.stringify({
    covenant: "b3e5eeefacf2021f",
    covenant_id: "aa".repeat(32),
    agent: key("orchestrator"),
    principal: key("principal"),
    revocation: key("principal"),
    recipients_root: toHex(new RecipientSet(MEMBERS).root),
    not_before: "569000000",
    expires_at: "569100000",
    budget: "500000000",
    max_per_spend: "20000000",
    epoch_limit: "100000000",
    epoch_length: "1000",
    delegation_depth: "2",
    grant_value: "500000000",
    spent_total: "0",
    reserved: "0",
    epoch_index: "0",
    epoch_spent: "0",
    ...over,
  }, null, 2));
  writeFileSync(payees, `# the grant's members\n${MEMBERS.join("\n")}\n`);
  return { dir, manifest, payees, batch: join(dir, "batch.json") };
}

async function cli(args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", CLI, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("open reads a real-shaped manifest and reports what can be committed", async () => {
  const f = fixture();
  const r = await cli(["open", "--manifest", f.manifest, "--batch", f.batch, "--name", "w38", "--payees", f.payees]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /can commit : 5 KAS/);
  // Depth is stated as what a CHILD may be, because that is the number a
  // person is about to need.
  assert.match(r.stderr, /children may be 1/);
});

test("hiring to pay someone off the allowlist is refused before anything is built", async () => {
  const f = fixture();
  await cli(["open", "--manifest", f.manifest, "--batch", f.batch, "--payees", f.payees]);
  const r = await cli(["hire", "scout", "--batch", f.batch, "--payees", f.payees,
    "--agent-key", key("scout"), "--payee", STRANGER, "--budget", "0.5", "--max-per-spend", "0.05"]);
  assert.equal(r.code, 2, "a refusal is exit 2, not a crash");
  assert.match(r.stderr, /not-in-allowlist/);
  assert.match(r.stderr, /fixed at genesis/);
});

test("a payees list that does not rebuild the root stops everything", async () => {
  const f = fixture();
  await cli(["open", "--manifest", f.manifest, "--batch", f.batch, "--payees", f.payees]);
  const r = await cli(["hire", "scout", "--batch", f.batch, "--payees", `${SEARCH},${STRANGER}`,
    "--agent-key", key("scout"), "--payee", SEARCH, "--budget", "0.5", "--max-per-spend", "0.05"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not rebuild this grant's root/);
  assert.match(r.stderr, /belongs to a different grant/);
});

test("hiring without the payees file says why a root is not enough", async () => {
  const f = fixture();
  await cli(["open", "--manifest", f.manifest, "--batch", f.batch, "--payees", f.payees]);
  const r = await cli(["hire", "scout", "--batch", f.batch,
    "--agent-key", key("scout"), "--payee", SEARCH, "--budget", "0.5", "--max-per-spend", "0.05"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /records the allowlist's ROOT/);
});

test("a budget beyond what is uncommitted is refused with the arithmetic", async () => {
  const f = fixture({ spent_total: "100000000", reserved: "300000000" });
  await cli(["open", "--manifest", f.manifest, "--batch", f.batch, "--payees", f.payees]);
  const r = await cli(["hire", "scout", "--batch", f.batch, "--payees", f.payees,
    "--agent-key", key("scout"), "--payee", SEARCH, "--budget", "2", "--max-per-spend", "0.05"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /over-uncommitted/);
  assert.match(r.stderr, /already reserved in outstanding children/);
});

test("settling a child that was never hired says so instead of building one", async () => {
  const f = fixture();
  await cli(["open", "--manifest", f.manifest, "--batch", f.batch, "--payees", f.payees]);
  const r = await cli(["settle", "scout", "--batch", f.batch]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no outstanding child called scout/);
});

test("a KAS amount with nine decimals is refused rather than truncated", async () => {
  const f = fixture();
  await cli(["open", "--manifest", f.manifest, "--batch", f.batch, "--payees", f.payees]);
  const r = await cli(["hire", "scout", "--batch", f.batch, "--payees", f.payees,
    "--agent-key", key("scout"), "--payee", SEARCH, "--budget", "0.123456789", "--max-per-spend", "0.05"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /eight decimal places/);
});

/**
 * The flag that was missing, against a live grant, on the first delegation.
 *
 * `build-delegation` needs BOTH lists: the child commits to a node of the
 * parent's tree, and the delegation carries the path from that node up to the
 * parent's root — which only the parent's full member set can produce. Passing
 * the subset alone looked complete and was refused by the tool, which is the
 * only reason it cost nothing.
 *
 * A dry run exists so this is readable rather than inferred, and so this test
 * can check the invocation instead of checking that a chain said no.
 */
test("the delegation carries the child's subset AND the parent's whole list", async () => {
  const f = fixture();
  await cli(["open", "--manifest", f.manifest, "--batch", f.batch, "--payees", f.payees]);
  const r = await cli(["hire", "scout", "--batch", f.batch, "--payees", f.payees, "--dry-run",
    "--agent-key", key("scout"), "--payee", SEARCH, "--budget", "0.5", "--max-per-spend", "0.05"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`--child-recipients ${SEARCH}`));
  assert.match(r.stderr, new RegExp(`--recipients ${f.payees.replace(/[/\\.]/g, "\\$&")}`));
  // And the attenuation, so a refactor cannot quietly widen a child.
  assert.match(r.stderr, /--depth 1/);
  assert.match(r.stderr, /--budget 50000000/);
});
