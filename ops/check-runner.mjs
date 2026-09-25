#!/usr/bin/env node
/**
 * The runner holds agent keys and nothing else. This fails the build if that
 * stops being true in the source.
 *
 * The whole security argument of a hosted runner is one sentence: a breach
 * loses at most what the grants it holds could still spend. That is true only
 * while the runner cannot reach a principal or revocation key, and cannot
 * perform an owner operation except by asking. So:
 *
 *  - no file under runner/src may read a key file or the funder's env key;
 *  - no file under runner/src may import from cli/, ops/ or covenant/deploy,
 *    which is where the tools that DO hold those keys live;
 *  - every action type must declare an authority, and the only owner-level
 *    action the engine knows is `approval`, which executes nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../runner/src/", import.meta.url).pathname;
const bad = [];
const FORBIDDEN = [
  [/WARDA_SK\b/, "reads the funder's key from the environment"],
  [/\.key["'`]/, "names a key file"],
  [/revocation\.key|warda-revocation/i, "names the revocation key file"],
  [/from\s+["'](\.\.\/)+(cli|ops|covenant)\//, "imports from a tool that holds owner keys"],
  [/\b(signRevoke|buildRevoke|revokeGrant|buildReclaim|signReclaim|buildExit)\s*\(/, "calls an owner-key operation"],
];

for (const f of readdirSync(root).filter((f) => f.endsWith(".ts"))) {
  const text = readFileSync(join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  for (const [re, why] of FORBIDDEN) if (re.test(text)) bad.push(`runner/src/${f} ${why}`);
  // Genesis is signed only by an agent's deposit key, never by anything else.
  if (/attachGenesisSignature\s*\(/.test(text) && !/signer\(depositId\(/.test(text)) {
    bad.push(`runner/src/${f} signs a genesis with something other than a deposit key`);
  }
}

const wf = readFileSync(join(root, "workflow.ts"), "utf8");
const table = /export const AUTHORITY[^=]*=\s*\{([\s\S]*?)\};/.exec(wf);
if (!table) bad.push("runner/src/workflow.ts no longer has the AUTHORITY table");
else {
  const owners = [...table[1].matchAll(/"?([\w-]+)"?\s*:\s*"owner"/g)].map((m) => m[1]);
  if (owners.join() !== "approval") {
    bad.push(`owner-level actions must be exactly [approval]; found [${owners.join(", ")}]`);
  }
}

/* The funding window has a size, and the size is not optional.
 *
 * A breach of the runner loses at most what its grants could still spend —
 * that is the sentence on the landing page, and it is about grants that
 * EXIST. A deposit in flight is not one of them yet: for the minute between
 * it landing and the genesis confirming, the runner holds that coin alone.
 *
 * DESIGN.md has always disclosed the window. Disclosure is not a bound, and
 * the bound is easy to lose by accident — delete one check in `checkLimits`
 * and the runner will quote any figure at all, with nothing failing. */
const funding = readFileSync(join(root, "funding.ts"), "utf8");
if (!/export function maxDeposit\s*\(/.test(funding)) {
  bad.push("runner/src/funding.ts no longer exports maxDeposit — the funding window is unbounded again");
} else {
  const limits = /export function checkLimits[\s\S]*?\n}/.exec(funding);
  if (!limits) bad.push("runner/src/funding.ts no longer has checkLimits");
  else if (!/maxDeposit\s*\(\)/.test(limits[0])) {
    bad.push("runner/src/funding.ts checkLimits does not consult maxDeposit() — a quote is no longer capped");
  }
}

/* The policy condition, in the tool and in the prose.
 *
 * runner/DESIGN.md quotes the condition turnkey-scope.ts installs, and a
 * quoted string is a copy. This session has now found four places where a copy
 * of a fact outlived the fact: a table describing a build nobody had, a status
 * that could not say what had changed, a suite reporting a rule it was not
 * testing, and a version entry claiming a file that was sitting in the repo.
 *
 * It matters more here than in most of them. DESIGN.md's account of what a
 * leaked runner credential can do is what a reviewer reads INSTEAD of logging
 * into Turnkey, and it is the only account of it they can read.
 */
{
  const repo = new URL("../", import.meta.url).pathname;
  const tool = readFileSync(join(repo, "runner/tools/turnkey-scope.ts"), "utf8");
  const design = readFileSync(join(repo, "runner/DESIGN.md"), "utf8");
  const prefix = tool.match(/export const AGENT_PREFIX = "([^"]+)";/)?.[1];
  if (!prefix) {
    bad.push("runner/tools/turnkey-scope.ts no longer exports AGENT_PREFIX, so DESIGN.md's promise cannot be checked against the policy");
  } else {
    const clause = `wallet.label[0..${prefix.length}] == '${prefix}'`;
    if (!design.includes(clause)) {
      bad.push(`runner/DESIGN.md does not contain the condition turnkey-scope.ts installs (${clause})`);
    }
  }
}

if (bad.length) {
  console.error("check-runner: the runner must hold agent keys and nothing else\n\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(
  "check-runner: agent and single-use deposit keys only; owner operations are approvals; " +
    "the funding window is capped",
);
