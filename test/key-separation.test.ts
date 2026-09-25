/**
 * The three powers a grant names, and which of them share a secret.
 *
 * ## What this asserts, and what it deliberately does not
 *
 * It does NOT assert that principal and revocation are different keys. Today
 * they are the same on all fifteen grants in this repository, and a test that
 * failed for that would be a test somebody deletes. The separation cannot be
 * retrofitted either: a grant's keys are hashed into its address, so every
 * grant that exists has the keys it was born with, forever.
 *
 * What it asserts is the line that must never be crossed AGAIN:
 *
 *   the agent key is never the principal key
 *
 * That collapse is not a weakening, it is a removal. An agent that is its own
 * principal can reclaim its own grant and take the balance, so no limit in the
 * grant binds it — the budget, the cap, the epoch and the allowlist all still
 * compile, still run on chain, and all mean nothing. It is the one shape where
 * a Warda grant enforces nothing while looking exactly like one that does.
 *
 * And it records the count of principal/revocation collapses as a NUMBER, so
 * that adding a sixteenth grant with the same shape is a visible decision
 * rather than a default nobody notices.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const report = JSON.parse(
  execFileSync(
    "node",
    ["--experimental-strip-types", "sdk/tools/keys.ts", "--json"],
    { cwd: root, encoding: "utf8" },
  ),
);

test("no grant makes its agent the principal", () => {
  const fatal = report.findings.filter((f: string) => f.includes("AGENT is the principal"));
  assert.deepEqual(
    fatal,
    [],
    "an agent that is its own principal can reclaim its own grant: every limit in it is decorative",
  );
});

/**
 * A number, on purpose. Raising it is allowed and takes a commit that says so.
 *
 * The count is every grant this repository has ever published, including ones
 * that are revoked, settled or spent — a manifest is a historical record and
 * they are not removed.
 *
 * 16 since growth/batches/2026-W39/grant.json: the growth fleet's first week,
 * issued before tools/week.ts passed --revocation. Genesis warned, the week
 * ran, and the runner was fixed the same hour — every later week names
 * growth/keys/growth.key as its revocation key, so this should not move again.
 *
 * 17 since growth/listener-grant.json, 23 September: agent #012, issued by
 * first-listener-grant.sh, which did not pass --revocation and said in its own
 * preconditions that the funder becoming both was simply how it worked. It was
 * not — it is what every grant since #006 exists to avoid, and the script has
 * been fixed to name ops/warda-revocation.key like the rest of the fleet.
 *
 * The grant itself cannot be repaired: a revocation key is fixed at genesis,
 * so the only remedies are to revoke and reissue, or to let its seven-day term
 * run out. It is testnet, it holds 2.1 KAS, and it is on the before-mainnet
 * list — `MAINNET.md` §2.2, which when this line was first written did not
 * exist, though the line said it did. It does now.
 *
 * **When it expires this number should fall back to 16** — if a later reader
 * finds it stuck at 17 with the Listener long gone, that is a new collapse
 * wearing this one's allowance.
 *
 * `ops/grants.ts` — the by-hand issuer and the unattended one — passes
 * --revocation on every path, so nothing issued from /grant can add to this.
 */
test("the principal/revocation collapse has not spread further", () => {
  const collapsed = report.findings.filter((f: string) =>
    f.includes("principal and revocation are one key"),
  );
  assert.equal(
    collapsed.length,
    17,
    `${collapsed.length} grants share a principal and revocation key, and this test knew about 17.\n` +
      "If you added a grant, it inherited the collapse — genesis defaults --revocation to the\n" +
      "principal. Pass a separate key, or raise this number in a commit that explains why.",
  );
});

/**
 * The collapse that is BIGGER than the one above, and newer as a measurement.
 *
 * `--principal` defaults to the funder, who is paying for the genesis — the
 * most comfortable default in the tool, because it is what happens when nobody
 * types anything. Twenty-nine grants here carry it, against seventeen for the
 * principal/revocation collapse: that one had its default fixed in September
 * and this one never did.
 *
 * It is also the one that cannot be retrofitted. A grant hashes its keys into
 * its address, so the principal is decided at genesis and decided for the
 * grant's whole life. Each of these twenty-nine is permanently that way; the
 * only remedies are revoke-and-reissue, or the term running out.
 *
 * Genesis refuses it on mainnet now, with no override. This number is the
 * testnet clock: it must not grow.
 */
test("the funder/principal collapse has not spread further", () => {
  const collapsed = report.findings.filter((f: string) =>
    f.includes("the principal is a FUNDER key"),
  );
  assert.equal(
    collapsed.length,
    29,
    `${collapsed.length} grants name a funder key as their principal, and this test knew about 29.\n` +
      "If you added a grant, it inherited the default — genesis defaults --principal to the\n" +
      "funder. Pass a principal generated offline (ops/PRINCIPAL.md), or raise this number\n" +
      "in a commit that explains why a grant made after this test was written needed it.\n" +
      "It cannot be changed after genesis, so raising it is a permanent decision.",
  );
});

test("every grant names an agent key of its own", () => {
  const agents = report.keys.filter((k: { agentOf: number }) => k.agentOf > 0);
  assert.ok(agents.length >= 9, "agent keys are per-grant and must not collapse into one");
  for (const k of agents) {
    assert.equal(
      k.principalOf,
      0,
      `${k.key.slice(0, 16)} is an agent somewhere and a principal somewhere else`,
    );
  }
});

/**
 * The refusals genesis makes, checked by SPAWNING it.
 *
 * A unit test of a checker keeps passing when somebody adds a code path that
 * does not call it — which is why `network.ts`'s mainnet gate is tested by
 * spawning fifteen tools rather than by calling one function. Same reasoning
 * here, for the same kind of guard.
 */
import { spawnSync } from "node:child_process";

const KEY = "11".repeat(32);
const OTHER = "22".repeat(32);

function genesis(args: string[], env: Record<string, string> = {}) {
  return spawnSync(
    "node",
    ["--experimental-strip-types", "sdk/tools/genesis.ts", ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WARDA_SK: KEY, ...env },
    },
  );
}

test("genesis refuses an agent that is its own principal", () => {
  const r = genesis(["--principal", OTHER, "--agent", OTHER]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing: the agent key IS the principal key/);
  assert.match(r.stderr, /it is not a\s+grant/);
});

/**
 * The testnet half: warned, and allowed, because every grant this repository
 * has issued looks like this and refusing it would refuse its own history.
 */
test("genesis warns about a shared principal and revocation on testnet", () => {
  const r = genesis(["--principal", OTHER, "--revocation", OTHER, "--agent", KEY]);
  assert.match(r.stderr, /warning: the revocation key IS the principal key/);
  assert.match(r.stderr, /refused outright on mainnet/);
  assert.doesNotMatch(r.stderr, /refusing: the revocation key/);
});

/**
 * The inventory must describe keys that exist, not keys somebody meant to make.
 *
 * ops/known-keys.json is a claim about CUSTODY — where a secret lives and what
 * it is allowed to do — and a claim like that decays silently. A key listed
 * there whose secret was never generated, or whose public half was typed by
 * hand and is one character wrong, reads exactly like a key that is ready to
 * use, right up until a grant is issued naming it and nobody can revoke it.
 *
 * So: every entry must be 64 hex characters, and no two entries may name the
 * same key with different labels.
 */
test("the key inventory is well formed and unambiguous", () => {
  const known = JSON.parse(
    readFileSync(new URL("../ops/known-keys.json", import.meta.url), "utf8"),
  ).keys as { key: string; label: string; secretLives?: string }[];

  assert.ok(known.length > 0, "the inventory is empty");
  const seen = new Set<string>();
  for (const k of known) {
    assert.match(k.key, /^[0-9a-f]{64}$/, `${k.label}: not 64 hex characters`);
    assert.ok(k.label && k.label.length > 8, `${k.key.slice(0, 12)}: needs a label that says something`);
    assert.ok(k.secretLives, `${k.label}: must say where the secret lives, or it is not an inventory`);
    assert.ok(!seen.has(k.key), `${k.key.slice(0, 12)} is listed twice`);
    seen.add(k.key);
  }
});

/**
 * The key that matters most must be accounted for.
 *
 * 0393133d… is the principal of every grant this project has issued. An
 * inventory that does not mention it is an inventory of the easy half.
 */
test("the principal of every existing grant is in the inventory", () => {
  const principals = report.keys.filter((k: { principalOf: number }) => k.principalOf > 0);
  for (const p of principals) {
    assert.ok(
      p.label,
      `${p.key.slice(0, 16)} is the principal of ${p.principalOf} grant(s) and is not in ops/known-keys.json`,
    );
  }
});
