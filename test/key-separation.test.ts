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
 */
test("the principal/revocation collapse has not spread further", () => {
  const collapsed = report.findings.filter((f: string) =>
    f.includes("principal and revocation are one key"),
  );
  assert.equal(
    collapsed.length,
    15,
    `${collapsed.length} grants share a principal and revocation key, and this test knew about 15.\n` +
      "If you added a grant, it inherited the collapse — genesis defaults --revocation to the\n" +
      "principal. Pass a separate key, or raise this number in a commit that explains why.",
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
