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
  packages.push({ dir: w, name: p.name, version: p.version, deps: p.dependencies ?? {}, bin: p.bin, files: p.files });
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

/**
 * A SECOND question, and the one that turned CI red.
 *
 * Do the ranges packages here declare for each other admit the versions in
 * this tree? Bumping kaspa to 0.6.0 left seven workspaces declaring ^0.5.x,
 * and a caret does not cross the minor below 1.0. Two consequences, and the
 * quiet one is worse:
 *
 *   `npm ci` FAILED outright on cli's peerOptional borsh ^0.3.0 against a
 *   workspace at 0.4.1 — ERESOLVE, which at least stops.
 *
 *   And every `dependencies` range that no longer matched silently STOPPED
 *   LINKING THE WORKSPACE. npm satisfies a sibling from the working copy only
 *   when the range admits its version; otherwise it fetches the published one.
 *   So x402, vendor, verify, agent, mcp and the rest would have been built and
 *   tested against a kaspa from the registry while the tree's sat unused, and
 *   nothing says so.
 *
 * That is the same shape as borsh 0.4.0 shipping against an unpublished
 * export, arriving from the opposite direction: there the tree was ahead of
 * npm, here the declared range points behind the tree.
 */
function admits(range, version) {
  return range.split("||").some((part) => {
    const r = part.trim();
    if (r === "*") return true;
    if (!r.startsWith("^")) return r === version;
    const a = r.slice(1).split(".").map(Number);
    const b = version.split(".").map(Number);
    if (a[0] !== b[0]) return false;
    if (b[0] === 0) return a[1] === b[1] && b[2] >= a[2];
    return b[1] > a[1] || (b[1] === a[1] && b[2] >= a[2]);
  });
}

const all = [];
for (const w of workspaces) {
  const f = join(root, w, "package.json");
  if (!existsSync(f)) continue;
  all.push({ dir: w, ...JSON.parse(readFileSync(f, "utf8")) });
}
const versionOf = Object.fromEntries(all.map((p) => [p.name, p.version]));

const stale = [];
for (const p of all) {
  for (const kind of ["dependencies", "peerDependencies", "devDependencies"]) {
    for (const [dep, range] of Object.entries(p[kind] ?? {})) {
      const v = versionOf[dep];
      if (!v || admits(range, v)) continue;
      stale.push(
        `${p.name} declares ${dep} ${range}, and this tree has ${v}. npm links a sibling from ` +
          `the working copy only when the range admits it — otherwise it quietly fetches the ` +
          `published one, and everything here is built against a version nobody is editing.`,
      );
    }
  }
}

if (stale.length > 0) {
  console.error("a workspace range does not admit the version in this tree:\n");
  for (const s of stale) console.error(`  ${s}`);
  console.error("\nA caret does not cross the minor below 1.0.0. Widen the range.");
  process.exit(1);
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

const broken = [];
/* A `bin` a published package cannot run.
 *
 * `verify` declares `warda-verify`, and wardaprotocol.com/protocol tells a
 * stranger that `npx warda-verify` "runs the identical thing yourself — which
 * is the version that matters, because a verifier you have to trust is not a
 * verifier". That sentence is the protocol's answer to depending on a hosted
 * service, and it rests on a file path in package.json being real, built, in
 * the `files` allowlist, and executable.
 *
 * Each of those can break without anything noticing. `dist/` is gitignored, so
 * a build that stops emitting the entry point looks identical in the tree; a
 * `files` array edited to trim the tarball can drop it; a shebang lost in a
 * refactor makes `npx` hand the file to the shell.
 *
 * This is not hypothetical for this repo — @warda_protocol/borsh@0.4.0 went to
 * npm broken for everyone the moment it arrived, which is why the rest of this
 * file exists. A bin is the same failure with a friendlier surface: it works
 * for everybody who has the repo and for nobody who does not. */
for (const p of packages) {
  for (const [cmd, raw] of Object.entries(p.bin ?? {})) {
    /* `"./dist/warda.js"` and `"dist/warda.js"` are the same path to npm, and
       both are documented forms. The first version of this check compared the
       string as written and reported @warda_protocol/cli as shipping a command
       outside its own tarball — which was false, and is the way a check earns
       being switched off. Normalise before comparing. */
    const rel = raw.replace(/^\.\//, "");
    const target = join(root, p.dir, rel);
    if (!existsSync(target)) {
      broken.push(
        `${p.name} declares bin "${cmd}" -> ${raw}, which does not exist. ` +
          `\`npx ${cmd}\` fails for anyone who installs it.`,
      );
      continue;
    }
    if (!readFileSync(target, "utf8").startsWith("#!")) {
      broken.push(`${p.name}'s bin "${cmd}" (${rel}) has no shebang, so npx hands it to the shell.`);
    }
    /* `files` is an allowlist: a path outside it is simply not in the
       tarball, and the package installs cleanly with the command missing. */
    if (Array.isArray(p.files) && !p.files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, "") + "/"))) {
      broken.push(
        `${p.name}'s bin "${cmd}" (${rel}) is outside its "files" allowlist [${p.files.join(", ")}], ` +
          `so it is not in the published tarball.`,
      );
    }
  }
}

/* Reported and fatal on its own, BEFORE the drift notes below.
 *
 * The drift report is advisory — it says what would be unwise to publish
 * today. A bin that is missing, unexecutable or outside the tarball is not a
 * judgement call about timing; it is a package that does not work. It also
 * has to come first: the first version of this check ran after the block that
 * prints and exits, so it found nothing and said nothing, which is a checker
 * with the same defect as the thing it checks for. */
if (broken.length > 0) {
  console.error("these packages declare a command that will not run:\n");
  for (const b of broken) console.error(`  ${b}`);
  console.error(
    "\nwardaprotocol.com tells a stranger to run `npx warda-verify` instead of trusting\n" +
      "the hosted verifier. That sentence is the protocol's answer to depending on a\n" +
      "service, and it is only true while the command is.\n",
  );
  process.exit(1);
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
  `releasable: ${packages.length} published packages, every declared bin is built and shippable, ` +
    `none depends on unreleased source.` +
    (lagging.length
      ? `\n  note: ${lagging.map((p) => `${p.name.split("/")[1]} (+${drift.get(p.name).length})`).join(", ")} ` +
        `have unreleased work of their own, which is normal.`
      : ""),
);
