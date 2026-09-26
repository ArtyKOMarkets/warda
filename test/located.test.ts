/**
 * The detector for the outage, tested against the outage.
 *
 * `ops/check-located.ts` exists because on 25 September every agent derived a v5
 * address for a v4 grant, found nothing at it, and reported the grant missing.
 * Its whole value is telling that apart from a grant that really moved — so a
 * green run of it proves nothing unless it has been shown the September state
 * and named it correctly.
 *
 * Driven against the fake kaspad, so the three cases are put there deliberately
 * rather than waited for:
 *
 *   the coin at the address the manifest's own covenant derives  -> ok
 *   the coin at the address ANOTHER covenant derives             -> names it
 *   the coin nowhere                                             -> moved or ended
 *
 * The middle one is the test. If it ever reports "not where its manifest says"
 * without saying which covenant holds the money, this file has stopped being
 * worth running: that sentence sends a person looking on chain for coin that was
 * never lost.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  EMPTY_RESERVE, fromHex, payToScriptHashScript, scriptHashFor, scriptHashToAddress,
  scriptPublicKeyToWire, templateFingerprint, templateIdFor, type CovenantTemplate,
} from "@warda_protocol/kaspa";
import { loadTemplates } from "@warda_protocol/kaspa/templates";
import { startFakeNode, type FakeNode } from "./harness/fake-node.ts";

const repo = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));
const MANIFEST = JSON.parse(readFileSync(repo("growth/listener-grant.json"), "utf8"));

const TEMPLATES = loadTemplates();
const byFingerprint = (fp: string): CovenantTemplate => {
  const t = TEMPLATES.find((x) => templateFingerprint(x) === fp);
  assert.ok(t, `template ${fp} is loadable`);
  return t;
};
const V4 = byFingerprint("b3e5eeefacf2021f");
const V5 = byFingerprint("157b64e3eeea9c01");

function addressUnder(m: Record<string, unknown>, tpl: CovenantTemplate): string {
  const authority = { principalKey: m.principal as string, revocationKey: (m.revocation ?? m.principal) as string };
  const state = {
    agentKey: m.agent as string, budgetTotal: BigInt(m.budget as number),
    maxPerSpend: BigInt(m.max_per_spend as number), epochLimit: BigInt(m.epoch_limit as number),
    epochLength: BigInt(m.epoch_length as number), recipientsRoot: m.recipients_root as string,
    notBefore: BigInt(m.not_before as number), expiresAt: BigInt(m.expires_at as number),
    delegationDepth: BigInt((m.delegation_depth as number) ?? 0), templateId: templateIdFor(tpl, authority),
    spentTotal: BigInt((m.spent_total as number) ?? 0), reserved: BigInt((m.reserved as number) ?? 0),
    epochIndex: BigInt((m.epoch_index as number) ?? 0), epochSpent: BigInt((m.epoch_spent as number) ?? 0),
    reserveRoot: (m.reserve_root as string) ?? EMPTY_RESERVE,
  };
  return scriptHashToAddress(scriptHashFor(tpl, { authority, state }), "kaspatest");
}

/** Put the grant's coin at one covenant's address, and say which one. */
function put(node: FakeNode, tpl: CovenantTemplate, m: Record<string, unknown>) {
  const address = addressUnder(m, tpl);
  const authority = { principalKey: m.principal as string, revocationKey: (m.revocation ?? m.principal) as string };
  const sh = scriptHashFor(tpl, {
    authority,
    state: {
      agentKey: m.agent as string, budgetTotal: BigInt(m.budget as number),
      maxPerSpend: BigInt(m.max_per_spend as number), epochLimit: BigInt(m.epoch_limit as number),
      epochLength: BigInt(m.epoch_length as number), recipientsRoot: m.recipients_root as string,
      notBefore: BigInt(m.not_before as number), expiresAt: BigInt(m.expires_at as number),
      delegationDepth: BigInt((m.delegation_depth as number) ?? 0), templateId: templateIdFor(tpl, authority),
      spentTotal: BigInt((m.spent_total as number) ?? 0), reserved: BigInt((m.reserved as number) ?? 0),
      epochIndex: BigInt((m.epoch_index as number) ?? 0), epochSpent: BigInt((m.epoch_spent as number) ?? 0),
      reserveRoot: (m.reserve_root as string) ?? EMPTY_RESERVE,
    },
  });
  node.utxos = [{
    address, transactionId: "aa".repeat(32), index: 0,
    amount: BigInt(m.grant_value as number),
    scriptPublicKey: scriptPublicKeyToWire(payToScriptHashScript(fromHex(sh))),
    blockDaaScore: 1n, covenantId: m.covenant_id as string,
  }];
  /* Before expiry, so "nothing there" is never explained away as a term that
     ended — which would make every case below pass for the wrong reason. */
  node.daaScore = BigInt(m.not_before as number) + 1n;
}

/**
 * A checkout whose WATCHED list holds exactly this one manifest.
 *
 * `ops/check-located.ts` names the fleet in a constant, and the fleet's other
 * grants are real ones whose coin this fake node knows nothing about — so run
 * unchanged it would report six failures around the one case being tested. The
 * copy edits that constant and nothing else.
 */
const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers) await c(); });

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "warda-located-"));
  mkdirSync(join(dir, "ops"));
  mkdirSync(join(dir, "growth"), { recursive: true });
  /* SYMLINKED, not copied. node_modules here is hundreds of megabytes and the
     first version of this spent sixteen seconds per case duplicating it; the
     directories are read-only to the thing under test. `sdk` is linked because
     check-located.ts imports ../sdk/tools/network.ts by relative path. */
  symlinkSync(repo("node_modules"), join(dir, "node_modules"));
  symlinkSync(repo("sdk"), join(dir, "sdk"));
  writeFileSync(join(dir, "growth/listener-grant.json"), JSON.stringify(MANIFEST, null, 1));
  const src = readFileSync(repo("ops/check-located.ts"), "utf8");
  const one = src.replace(
    /const WATCHED: \[string, string\]\[\] = \[[\s\S]*?\n\];/,
    'const WATCHED: [string, string][] = [["listener", "growth/listener-grant.json"]];',
  );
  assert.notEqual(one, src, "the WATCHED list is still shaped the way this test edits it");
  writeFileSync(join(dir, "ops/check-located.ts"), one);
  return dir;
}

/**
 * Spawned ASYNCHRONOUSLY, and that is not a style preference.
 *
 * The fake node's WebSocket server lives in THIS process. `spawnSync` blocks
 * this process's event loop until the child exits — so the server can never
 * accept the child's connection, and the child times out dialling a node that
 * is listening and cannot answer. The first run of this file failed with "timed
 * out connecting to ws://127.0.0.1:35767", which reads as a broken probe and
 * was a blocked parent. `test/buy-e2e.test.ts` carries the same comment for the
 * same reason, which is how this was diagnosed in a minute instead of an hour.
 */
function run(dir: string, url: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn("node", ["--experimental-strip-types", "ops/check-located.ts"], {
      cwd: dir,
      env: { ...process.env, WARDA_RPC_JSON: url, WARDA_NETWORK: "testnet-10" },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    child.on("close", (code) => done({ code, out }));
  });
}

test("a grant at the address its own covenant derives is reported located", async () => {
  const node = await startFakeNode();
  closers.push(() => node.close());
  const dir = checkout();
  put(node, V4, MANIFEST);
  const { code, out } = await run(dir, node.url);
  assert.equal(code, 0, out);
  assert.match(out, /ok\s+listener\s+b3e5eeefacf2021f/);
});

test("the September state: the coin is under another covenant, and it says which", async () => {
  const node = await startFakeNode();
  closers.push(() => node.close());
  const dir = checkout();
  /* Exactly what was true on 25 September, inverted: the manifest says v4 and
     the coin is where v5 derives. Whichever side is wrong, the finding is the
     same and it is not "the grant is missing". */
  put(node, V5, MANIFEST);
  const { code, out } = await run(dir, node.url);
  assert.equal(code, 1, out);
  assert.match(out, /NOT where their manifests say/);
  assert.match(out, /157b64e3eeea9c01/, "names the covenant that actually holds the coin");
  assert.match(out, /reading the wrong template/, "says what kind of problem this is");
  assert.doesNotMatch(out, /moved and the record did not follow/, "does not offer the wrong explanation too");
});

test("a grant that is nowhere says moved-or-ended, and does not invent a covenant", async () => {
  const node = await startFakeNode();
  closers.push(() => node.close());
  const dir = checkout();
  node.utxos = [];
  node.daaScore = BigInt(MANIFEST.not_before) + 1n;
  const { code, out } = await run(dir, node.url);
  assert.equal(code, 1, out);
  assert.match(out, /no other covenant on disk holds it either/);
  assert.match(out, /follow-grant/, "points at the tool that walks it forward");
});

test("a manifest still at genesis is not reported as a grant that moved", async () => {
  const node = await startFakeNode();
  closers.push(() => node.close());
  const dir = checkout();
  /* The first real run of check-located had exactly one failure, and it was this
     shape: runner/agents/first-hosted-grant.json is a snapshot of genesis that
     nothing advances, and the message offered the two explanations that both
     require a spend to have been recorded — "it moved and the record did not
     follow", "it was revoked". Neither can be true of counters that have never
     moved, and following the chain forward from a genesis state finds nothing
     however far it walks. */
  const fresh = { ...MANIFEST, spent_total: 0, epoch_index: 0, epoch_spent: 0 };
  writeFileSync(join(dir, "growth/listener-grant.json"), JSON.stringify(fresh, null, 1));
  node.utxos = [];
  node.daaScore = BigInt(MANIFEST.not_before) + 1n;
  const { code, out } = await run(dir, node.url);
  assert.equal(code, 1, out);
  assert.match(out, /still AT GENESIS/);
  assert.match(out, /never funded|not what advances/);
  assert.doesNotMatch(out, /follow-grant\.ts walks it forward/, "does not send a person walking the chain");
});

test("watching a manifest that nothing advances is refused, not reported", async () => {
  const dir = checkout();
  /* The guard on my own mistake. Putting the hosted grant back in WATCHED would
     restore a permanent failure — an alert that is always there teaches a person
     to skim the one day it matters — so the file refuses to run at all rather
     than producing it. Exit 2: it cannot check, which is not the same as an
     answer. */
  const src = readFileSync(join(dir, "ops/check-located.ts"), "utf8");
  writeFileSync(join(dir, "ops/check-located.ts"), src.replace(
    'const WATCHED: [string, string][] = [["listener", "growth/listener-grant.json"]];',
    'const WATCHED: [string, string][] = [["hosted", "runner/agents/first-hosted-grant.json"]];',
  ));
  const { code, out } = await run(dir, "ws://127.0.0.1:1");
  assert.equal(code, 2, out);
  assert.match(out, /NOT_ADVANCED says is a genesis/);
});

test("a node that cannot be reached exits 2, and concludes nothing", async () => {
  const dir = checkout();
  /* 2, not 1. ops/monitor.sh reads it as "the CHECK cannot run" and says so
     instead of naming an endpoint — the distinction ops/check-node.sh spent a
     day and a half on the wrong side of. */
  const { code, out } = await run(dir, "ws://127.0.0.1:1");
  assert.equal(code, 2, out);
  assert.match(out, /NOTHING is concluded/);
});
