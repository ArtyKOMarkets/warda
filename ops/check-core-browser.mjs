/**
 * Is `site/src/core-browser.js` the bundle it claims to be, and does it still
 * enforce the rules?
 *
 * It is `@warda_protocol/core` compiled for a page, so that /sandbox answers
 * "what would this grant refuse?" with the same function the payer runs rather
 * than a second copy of the rules. A second copy is the failure it exists to
 * prevent — and a STALE bundle is that failure with a delay on it: the rules
 * change, the page goes on teaching the old ones, and nothing looks wrong.
 *
 * Same job as `ops/check-dist.mjs`, and the same reasoning. The difference is
 * where it is wrong. A stale dist breaks a tool for a developer who can read
 * the error; a stale bundle teaches a stranger something the covenant does not
 * do, on the page we sent them to.
 *
 * ## Why this compares bytes and check-dist compares timestamps
 *
 * `dist/` is gitignored, so on a fresh checkout it does not exist and has to be
 * built — a timestamp there means something. This file is COMMITTED, and git
 * does not preserve mtimes: a clone stamps every file at checkout time in
 * whatever order the objects were written, so "is the source newer than the
 * bundle?" is a coin toss in CI and passes or fails for no reason. So the
 * question is asked the only way it has a stable answer: rebuild it, and
 * compare.
 */
import { readFileSync, existsSync } from "node:fs";
import { bundleText, OUT } from "./build-core-browser.mjs";

if (!existsSync(OUT)) {
  console.error("site/src/core-browser.js is missing — /sandbox renders nothing without it.\n");
  console.error("  node ops/build-core-browser.mjs");
  process.exit(1);
}

const onDisk = readFileSync(OUT, "utf8");
const rebuilt = await bundleText();

if (onDisk !== rebuilt) {
  console.error("the browser bundle of the rules is not what its source produces.\n");
  console.error(
    `  committed: ${onDisk.length} bytes\n` +
      `  rebuilt:   ${rebuilt.length} bytes\n`,
  );
  console.error(
    "/sandbox runs this to say what a grant would refuse. Behind its source, it\n" +
      "teaches the old rules to a stranger and looks exactly like a page that is\n" +
      "working.\n\n" +
      "  node ops/build-core-browser.mjs",
  );
  process.exit(1);
}

/* ---- and does it still compute? ------------------------------------------
 * Freshness is not the only way this file can be wrong in public. A bundle
 * that loads and exports nothing useful renders as a sandbox where no grant
 * refuses anything — which is the most flattering way for that page to break,
 * and therefore the one least likely to be reported.
 *
 * So: run it, and put a spend through each limit. These are the same cases the
 * page self-tests with in the browser; this is the copy that runs in CI,
 * before a stranger is the one who finds out.
 */
const C = (0, eval)(onDisk + ";WardaCore");
const payee = "aa".repeat(32);
const stranger = "bb".repeat(32);
const set = new C.RecipientSet([payee]);
const grant = C.createGrant({
  version: 1,
  parentId: null,
  principalKey: "11".repeat(32),
  agentKey: "22".repeat(32),
  revocationKey: "33".repeat(32),
  assetId: "KAS",
  budgetTotal: C.kas("1"),
  maxPerSpend: C.kas("0.2"),
  epochLimit: C.kas("0.5"),
  epochLength: 1000n,
  recipientsRoot: set.root,
  recipientsDepth: set.depth,
  notBefore: 1_000_000n,
  expiresAt: 1_007_000n,
  delegationDepth: 2,
  nonce: "44".repeat(32),
});
const fresh = C.initialState(grant);
const midEpoch = { ...fresh, spentTotal: C.kas("0.45"), epochSpent: C.kas("0.45") };

/* The two-call shape /sandbox uses, and for the reason written there:
   validateSpend also checks the successor state the transaction produces,
   which a caller with no transaction cannot supply. So it is asked once for
   the successor the rules require, and once more with that in place. */
function refusals(state, amount, recipient, daaScore) {
  const req = {
    grantId: grant.grantId,
    amount,
    recipient,
    recipientProof: set.has(recipient) ? set.proof(recipient) : { index: 0, siblings: [] },
    daaScore,
    successor: state,
  };
  const first = C.validateSpend(grant, state, req);
  if (!first.expectedSuccessor) return first.failures.filter((f) => f !== "INVALID_SUCCESSOR");
  return C.validateSpend(grant, state, { ...req, successor: first.expectedSuccessor }).failures;
}

const cases = [
  ["a spend inside every limit", [], fresh, C.kas("0.1"), payee, 1_000_500n],
  ["EXCEEDS_MAX_PER_SPEND", ["EXCEEDS_MAX_PER_SPEND"], fresh, C.kas("0.5"), payee, 1_000_500n],
  ["RECIPIENT_NOT_AUTHORIZED", ["RECIPIENT_NOT_AUTHORIZED"], fresh, C.kas("0.1"), stranger, 1_000_500n],
  ["NOT_YET_VALID", ["NOT_YET_VALID"], fresh, C.kas("0.1"), payee, 999_000n],
  ["EXPIRED", ["EXPIRED"], fresh, C.kas("0.1"), payee, 1_008_000n],
  ["EXCEEDS_EPOCH_LIMIT", ["EXCEEDS_EPOCH_LIMIT"], midEpoch, C.kas("0.1"), payee, 1_000_500n],
  ["REVOKED", ["REVOKED"], C.revoke(fresh), C.kas("0.1"), payee, 1_000_500n],
];

const wrong = [];
for (const [name, want, ...args] of cases) {
  let got;
  try {
    got = refusals(...args);
  } catch (e) {
    wrong.push(`${name}: threw ${e.message}`);
    continue;
  }
  if (got.join(",") !== want.join(",")) wrong.push(`${name}: got [${got.join(",")}]`);
}

if (wrong.length > 0) {
  console.error("the browser bundle is current and does not enforce the rules:\n");
  for (const w of wrong) console.error(`  ${w}`);
  console.error(
    "\n/sandbox puts spends through this in front of strangers. A bundle that\n" +
      "refuses nothing looks exactly like a grant that has no limits.",
  );
  process.exit(1);
}

console.log(
  `core-browser: the committed bundle is byte-identical to a fresh build, ` +
    `and judged ${cases.length} spends correctly.`,
);
