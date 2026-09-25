/**
 * `buy.ts`, end to end, with no chain and no money.
 *
 * This is the file all three resume bugs lived in, and none of them could be
 * tested: buying needs a node, a funded grant and a vendor, so every one was
 * found by spending real coin against a live endpoint and reading the
 * wreckage afterwards.
 *
 * The demo grant's manifest is public and derives to the address published on
 * the site, so the fake node can serve its UTXO — covenant id and all — and
 * the real payer builds a real covenant spend against it. Only the submit is
 * imaginary.
 *
 * Each test below is a bug that reached production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import covenantTemplate from "../sdk/covenant-template.json" with { type: "json" };
import covenantV5 from "../sdk/covenant-template-v5.json" with { type: "json" };
import covenantV4 from "../sdk/covenant-template-v4.json" with { type: "json" };
import covenantV3 from "../sdk/covenant-template-v3.json" with { type: "json" };
import {
  EMPTY_RESERVE, payToScriptHashScript, scriptHashFor, scriptHashToAddress,
  scriptPublicKeyToWire, templateForManifest, templateIdFor, fromHex,
  type CovenantTemplate,
} from "../sdk/src/index.ts";
import { startFakeNode, type FakeNode } from "./harness/fake-node.ts";
import { startFakeVendor, type FakeVendor } from "./harness/fake-vendor.ts";

const repo = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));
const MANIFEST = JSON.parse(readFileSync(repo("covenant/deploy/grant-demo.json"), "utf8"));

/* The demo grant is a REAL grant on testnet and runs one specific covenant for
   its whole life — the address commits the bytecode. This derived it from
   whichever template was current, which is the same file until a covenant is
   frozen and a different one afterwards. The manifest records which. */
const TEMPLATES = [covenantTemplate, covenantV5, covenantV4, covenantV3].map(
  (t) => t as unknown as CovenantTemplate,
);

function grantAddress(m: Record<string, unknown>): string {
  const t = templateForManifest(m as { covenant?: string }, TEMPLATES, "the demo manifest") as never;
  const authority = { principalKey: m.principal as string, revocationKey: m.revocation as string };
  const state = {
    agentKey: m.agent as string, budgetTotal: BigInt(m.budget as number),
    maxPerSpend: BigInt(m.max_per_spend as number), epochLimit: BigInt(m.epoch_limit as number),
    epochLength: BigInt(m.epoch_length as number), recipientsRoot: m.recipients_root as string,
    notBefore: BigInt(m.not_before as number), expiresAt: BigInt(m.expires_at as number),
    delegationDepth: BigInt((m.delegation_depth as number) ?? 2),
    templateId: templateIdFor(t, authority),
    spentTotal: BigInt((m.spent_total as number) ?? 0), reserved: BigInt((m.reserved as number) ?? 0),
    epochIndex: BigInt((m.epoch_index as number) ?? 0), epochSpent: BigInt((m.epoch_spent as number) ?? 0),
    reserveRoot: (m.reserve_root as string) ?? EMPTY_RESERVE,
  };
  const hash = scriptHashFor(t, { authority, state });
  return scriptHashToAddress(hash, "kaspatest");
}

/** A workspace whose manifest buy.ts may advance without touching the repo's. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "warda-e2e-"));
  const manifest = join(dir, "grant.json");
  writeFileSync(manifest, JSON.stringify(MANIFEST, null, 1));
  copyFileSync(repo("covenant/deploy/demo-recipients.txt"), join(dir, "payees.txt"));
  const out = join(dir, "purchases");
  mkdirSync(out);
  return { dir, manifest, payees: join(dir, "payees.txt"), out };
}

function fundNode(node: FakeNode, m: Record<string, unknown>) {
  const t = covenantTemplate as never;
  const authority = { principalKey: m.principal as string, revocationKey: m.revocation as string };
  const state = {
    agentKey: m.agent as string, budgetTotal: BigInt(m.budget as number),
    maxPerSpend: BigInt(m.max_per_spend as number), epochLimit: BigInt(m.epoch_limit as number),
    epochLength: BigInt(m.epoch_length as number), recipientsRoot: m.recipients_root as string,
    notBefore: BigInt(m.not_before as number), expiresAt: BigInt(m.expires_at as number),
    delegationDepth: BigInt((m.delegation_depth as number) ?? 2),
    templateId: templateIdFor(t, authority),
    spentTotal: BigInt((m.spent_total as number) ?? 0), reserved: BigInt((m.reserved as number) ?? 0),
    epochIndex: BigInt((m.epoch_index as number) ?? 0), epochSpent: BigInt((m.epoch_spent as number) ?? 0),
    reserveRoot: (m.reserve_root as string) ?? EMPTY_RESERVE,
  };
  const hash = scriptHashFor(t, { authority, state });
  node.utxos = [{
    address: scriptHashToAddress(hash, "kaspatest"),
    transactionId: "aa".repeat(32),
    index: 0,
    amount: BigInt(m.grant_value as number),
    scriptPublicKey: scriptPublicKeyToWire(payToScriptHashScript(fromHex(hash))),
    blockDaaScore: 1n,
    covenantId: m.covenant_id as string,
  }];
  /* Far enough along that the claimed epoch is not BEHIND the one the
     manifest records. The covenant refuses a spend claiming an earlier epoch
     than the grant has already reached — the index only moves forward — and
     this manifest is a real one that has been spending for weeks. */
  node.daaScore =
    BigInt(m.not_before as number) +
    (BigInt((m.epoch_index as number) ?? 0) + 1n) * BigInt(m.epoch_length as number);
}

/**
 * Spawned ASYNCHRONOUSLY, and that is not a style preference.
 *
 * The fake node's WebSocket server lives in THIS process. `spawnSync` blocks
 * this process's event loop until the child exits — so the server can never
 * accept the child's connection, and the child times out dialling a node that
 * is listening and cannot answer. The first run of this file failed with
 * "timed out connecting", which reads as a broken fake and was a blocked
 * parent.
 */
/**
 * The demo agent's secret, inline, because it is PUBLISHED.
 *
 * It is on /attack in 48-point type under an invitation to take the money:
 * the covenant bounds this key, not secrecy, and that is the whole claim the
 * page is making. Four other test files already carry it as a literal.
 *
 * It used to be read from `covenant/deploy/demo-agent.key`, which `.gitignore`
 * matches as `*.key` — so these six tests could pass only on a machine that
 * had run the deploy, and on a fresh checkout they failed with ENOENT before
 * asserting anything. Green here, impossible in CI, for a value anyone can
 * read off the website. The rule that no secret key is committed is worth
 * keeping absolutely; this is not one, and treating it as one cost the suite
 * its six most end-to-end tests.
 */
const DEMO_AGENT_SECRET =
  "9fccfb08645b4a5a49f0f461b9ae7209865c234f941e9d4679e8a18da77af2ad";

function run(
  ws: ReturnType<typeof workspace>,
  node: FakeNode,
  vendor: FakeVendor,
  extra: string[] = [],
): Promise<{ status: number; stderr: string; stdout: string }> {
  const child = spawn(process.execPath, [
    "--experimental-strip-types", repo("agents/tools/buy.ts"), vendor.url,
    "--id", "E2E", "--grant", ws.manifest, "--recipients", ws.payees, "--out", ws.out, ...extra,
  ], {
    env: {
      ...process.env,
      WARDA_SK: DEMO_AGENT_SECRET,
      WARDA_RPC_JSON: node.url,
      WARDA_NETWORK: "testnet-10",
    },
  });
  let stderr = "", stdout = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  child.stdout.on("data", (d) => (stdout += String(d)));
  return new Promise((resolve) =>
    child.on("close", (code) => resolve({ status: code ?? 1, stderr, stdout })));
}

const records = (ws: ReturnType<typeof workspace>) =>
  readdirSync(ws.out).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(ws.out, f), "utf8")) as Record<string, unknown>);

test("the demo manifest derives the address the site publishes", () => {
  assert.equal(grantAddress(MANIFEST), "kaspatest:prw9hklems02v8apxlx5m6y0d90e0j6657ztr3c3cjqf0wsnwsxz2fs9n0jxr");
});

test("a whole purchase: built, signed, submitted, served, recorded", async () => {
  const node = await startFakeNode();
  const vendor = await startFakeVendor();
  try {
    const ws = workspace();
    fundNode(node, MANIFEST);
    const r = await run(ws, node, vendor);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(node.submitted.length, 1, "exactly one transaction reached the node");
    assert.equal(vendor.served.length, 1);
    const [rec] = records(ws);
    assert.equal(rec!.outcome, "bought");
    assert.ok((rec!.proof as Record<string, unknown>).header, "the record carries a redeemable proof");
  } finally { await node.close(); await vendor.close(); }
});

/**
 * Exit 4, and the debt it must leave behind. This is the bug that cost 0.03
 * KAS twice: the record written by the failure path dropped the proof, so the
 * payment was unrecoverable.
 */
test("a vendor that never delivers exits 4 and leaves a proof with a header", async () => {
  const node = await startFakeNode();
  const vendor = await startFakeVendor();
  try {
    const ws = workspace();
    fundNode(node, MANIFEST);
    vendor.mode = "late";
    const r = await run(ws, node, vendor, ["--settle-attempts", "1"]);
    // 4 means "paid, unserved" — distinguishable by a caller from 3 ("refused,
    // nothing spent") and from 1 ("failed"), which is the entire point of
    // having codes rather than a boolean.
    assert.equal(r.status, 4, r.stderr);
    assert.equal(node.submitted.length, 1, "the money moved");
    const [rec] = records(ws);
    assert.match(String(rec!.outcome), /^paid/);
    const proof = rec!.proof as Record<string, unknown>;
    assert.ok(proof?.header, "the failure path must not discard the header");
    assert.equal(proof.txid, rec!.txid);
  } finally { await node.close(); await vendor.close(); }
});

/** The redemption, and the thing that must never happen during it. */
test("re-running redeems the debt and submits nothing", async () => {
  const node = await startFakeNode();
  const vendor = await startFakeVendor();
  try {
    const ws = workspace();
    fundNode(node, MANIFEST);
    vendor.mode = "late";
    assert.equal((await run(ws, node, vendor, ["--settle-attempts", "1"])).status, 4);
    assert.equal(node.submitted.length, 1);

    vendor.mode = "serve";
    const again = await run(ws, node, vendor);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stderr, /resuming/);
    assert.equal(node.submitted.length, 1, "STILL one transaction: it redeemed, it did not buy");
    assert.equal(new Set(vendor.seen).size, 1, "and the same proof throughout");
  } finally { await node.close(); await vendor.close(); }
});

/** A failed resume must not close the debt it failed to collect. */
test("a resume that fails leaves the debt open for the next run", async () => {
  const node = await startFakeNode();
  const vendor = await startFakeVendor();
  try {
    const ws = workspace();
    fundNode(node, MANIFEST);
    vendor.mode = "late";
    assert.equal((await run(ws, node, vendor, ["--settle-attempts", "1"])).status, 4);
    // Still down: the resume cannot collect.
    vendor.mode = "down";
    assert.notEqual((await run(ws, node, vendor)).status, 0);
    // Back up: the debt must still be findable.
    vendor.mode = "serve";
    const third = await run(ws, node, vendor);
    assert.equal(third.status, 0, third.stderr);
    assert.match(third.stderr, /resuming/, "the debt survived a failed resume");
    assert.equal(node.submitted.length, 1, "and was never bought a second time");
  } finally { await node.close(); await vendor.close(); }
});

/** Collecting closes every record of the payment, not just the one read. */
test("collecting closes all records of one payment", async () => {
  const node = await startFakeNode();
  const vendor = await startFakeVendor();
  try {
    const ws = workspace();
    fundNode(node, MANIFEST);
    vendor.mode = "late";
    await run(ws, node, vendor, ["--settle-attempts", "1"]);
    vendor.mode = "down";
    await run(ws, node, vendor);
    await run(ws, node, vendor);
    vendor.mode = "serve";
    assert.equal((await run(ws, node, vendor)).status, 0);

    const open = records(ws).filter(
      (r) => !r.resolvedBy && (r.proof as Record<string, unknown>)?.header && String(r.outcome).startsWith("paid"),
    );
    assert.deepEqual(open, [], "no phantom debts left behind");
  } finally { await node.close(); await vendor.close(); }
});

/** A node that cannot be believed must stop the purchase before a key moves. */
test("an unusable node refuses before anything is signed", async () => {
  const node = await startFakeNode();
  const vendor = await startFakeVendor();
  try {
    const ws = workspace();
    fundNode(node, MANIFEST);
    node.mood = "noIndex";
    const r = await run(ws, node, vendor);
    assert.notEqual(r.status, 0);
    assert.equal(node.submitted.length, 0, "nothing was submitted");
    assert.equal(vendor.served.length, 0);
  } finally { await node.close(); await vendor.close(); }
});
