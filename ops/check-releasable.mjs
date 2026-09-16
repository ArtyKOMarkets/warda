/**
 * Can these packages be published without shipping something nobody can install?
 *
 * ## The failure
 *
 * `@warda_protocol/borsh@0.4.0` went to npm and was broken for everyone the
 * moment it arrived. It imports `ordinaryPaymentToWire` from
 * `@warda_protocol/kaspa`, an export added to the tree six commits AFTER kaspa
 * 0.5.4 was released. So `import("@warda_protocol/borsh")` threw
 *
 *     The requested module '@warda_protocol/kaspa' does not provide an
 *     export named 'ordinaryPaymentToWire'
 *
 * on any machine that installed it from the registry. In the tree it was fine:
 * a workspace resolves its siblings to the working copy, so every test passed
 * against code that had not been published.
 *
 * It surfaced as a hosted verifier telling an operator to
 * `npm install @warda_protocol/borsh` — a package already in its
 * package.json — because `loadBorsh` wraps that import in a try and returns
 * null. A module the registry cannot supply is indistinguishable from one the
 * operator declined.
 *
 * ## What is checkable offline
 *
 * Not "does the published tarball export X" — that needs the registry. But the
 * condition underneath it does not: **a package must not be released while any
 * workspace package it depends on has unreleased source.** If kaspa has
 * commits to `src/` after the commit that set its current version, then
 * anything published against kaspa is published against code that is not on
 * npm, and whether that matters is luck.
 *
 * Version numbers cannot see this. The range admitted the version and the
 * version matched; the CODE differed. Git is what knows.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? [];

const packages = [];
for (const w of workspaces) {
  const f = join(root, w, "package.json");
  if (!existsSync(f)) continue;
  const p = JSON.parse(readFileSync(f, "utf8"));
  if (p.private) continue;
  packages.push({ dir: w, name: p.name, version: p.version, deps: p.dependencies ?? {} });
}
const byName = Object.fromEntries(packages.map((p) => [p.name, p]));

/** Commits to a package's src since the commit that set its current version. */
function unreleased(p) {
  try {
    const set = execFileSync(
      "git",
      ["log", "-1", "--format=%H", `-S"version": "${p.version}"`, "--", `${p.dir}/package.json`],
      { cwd: root, encoding: "utf8" },
    ).trim();
    /* A version never committed is a bump in progress, not a finding. */
    if (!set) return null;
    return execFileSync("git", ["log", "--format=%h", `${set}..HEAD`, "--", `${p.dir}/src`], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

const drift = new Map();
for (const p of packages) drift.set(p.name, unreleased(p));

/**
 * Which package is being published right now?
 *
 *     node ops/check-releasable.mjs              report, exit 0
 *     node ops/check-releasable.mjs --for borsh  refuse if THAT one is unsafe
 *
 * Two modes, because the hazard only bites the package actually going to npm.
 * Latent drift between a published package and the tree is normal — every
 * deploy directory in this repo depends on it deliberately. Failing CI over it
 * would turn "an endpoint cannot run unreleased code" into an obligation to
 * publish on every commit. So the strict mode is the one wired into a publish,
 * and the report is what runs everywhere else.
 */
const forArg = process.argv.indexOf("--for");
const target = forArg >= 0 ? process.argv[forArg + 1] : null;
const targetName = target?.includes("/") ? target : `@warda_protocol/${target}`;

const problems = [];
for (const p of packages) {
  if (target && p.name !== targetName) continue;
  const mine = drift.get(p.name);
  /* Only packages that are THEMSELVES ready to publish are judged, unless one
     was named — naming it says you are publishing it. */
  if (!target && (mine === null || mine.length > 0)) continue;
  for (const dep of Object.keys(p.deps)) {
    const d = byName[dep];
    if (!d) continue;
    const theirs = drift.get(dep);
    if (theirs && theirs.length > 0) {
      problems.push(
        `${p.name} ${p.version} is releasable, but it depends on ${dep} ${d.version}, which has ` +
          `${theirs.length} unreleased commit(s) to ${d.dir}/src. Publishing this ships a package ` +
          `built against code that is not on npm — it passes every test here, because a workspace ` +
          `resolves siblings to the working copy.`,
      );
    }
  }
}

if (problems.length > 0) {
  const fatal = Boolean(target);
  const say = fatal ? console.error : console.log;
  say(
    fatal
      ? `${targetName} cannot be published safely:\n`
      : "note: these would be published against unpublished code if released as they stand:\n",
  );
  for (const p of problems) say(`  ${p}`);
  say("\nPublish the dependency first, or bump it and publish both in order.");
  if (fatal) process.exit(1);
} else if (target) {
  console.log(`releasable: ${targetName} depends on nothing unpublished.`);
}

/* Not printed after a report: "none depends on unreleased source" directly
   under a list of packages that do is the kind of summary that trains people
   to stop reading summaries. */
const lagging = packages.filter((p) => (drift.get(p.name) ?? []).length > 0);
if (!target && problems.length === 0) console.log(
  `releasable: ${packages.length} published packages, none depends on unreleased source.` +
    (lagging.length
      ? `\n  note: ${lagging.map((p) => `${p.name.split("/")[1]} (+${drift.get(p.name).length})`).join(", ")} ` +
        `have unreleased work of their own, which is normal.`
      : ""),
);
