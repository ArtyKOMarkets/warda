/**
 * Is any package's build older than its source?
 *
 * This exists because of a purchase that cost 0.03 KAS to discover. The resume
 * path was written, unit-tested, and ran against a live vendor as though none
 * of it were there — because the package tests import `../src/index.ts` while
 * the repo's tools import the package, which resolves through `main` to
 * `dist/`. Seventy-five tests exercised the new code and passed while the tool
 * ran a build from an hour earlier. Green and stale, simultaneously, by
 * design.
 *
 * That is not a mistake anyone can be careful about. The two paths look
 * identical from the call site and nothing announces the difference; the only
 * symptom is behaviour silently reverting to whatever was last built, which
 * reads as "the feature does not work" rather than "the feature is not here".
 *
 * So: fail loudly, before the tests rather than after, naming the package and
 * the command. A stale build is a wrong answer waiting to be believed.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Derived from the workspaces, not listed here.
 *
 * It WAS a list of six names, and a seventh package was added without being
 * added to it — so the guard that exists to catch "green and stale" sat out
 * the first run of a tool against a package that had never been built at all.
 * The tests passed, the CLI failed with a module-not-found for a dist nobody
 * had made, and this file said nothing.
 *
 * `ops/bindings.mjs` has the same lesson written at the top of it, from a
 * different direction: a hardcoded list is a model that stops being true the
 * moment somebody adds a thing. The condition that actually matters is
 * observable — a package with a `src/` whose `main` resolves into `dist/` is a
 * package whose tools read the build rather than the source.
 */
const packages = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  .workspaces.filter((w) => {
    const pkg = join(root, w, "package.json");
    if (w === "." || !existsSync(pkg) || !existsSync(join(root, w, "src"))) return false;
    const main = JSON.parse(readFileSync(pkg, "utf8")).main ?? "";
    return main.includes("dist/");
  });

function newest(dir) {
  let latest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else latest = Math.max(latest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return latest;
}

const stale = [];
for (const pkg of packages) {
  const src = join(root, pkg, "src");
  const dist = join(root, pkg, "dist");
  if (!existsSync(src)) continue;
  if (!existsSync(dist)) {
    stale.push([pkg, "never built"]);
    continue;
  }
  const s = newest(src);
  const d = newest(dist);
  if (s > d) stale.push([pkg, `src is ${Math.round((s - d) / 1000)}s newer`]);
}

if (stale.length) {
  console.error("\nA build is behind its source:\n");
  for (const [pkg, why] of stale) console.error(`  ${pkg.padEnd(8)} ${why}`);
  console.error(
    "\nThe tests here import src/ and would pass anyway. The repo's tools import\n" +
      "the package, which resolves to dist/ — so they would run the OLD code and\n" +
      "report the new feature as broken rather than absent.\n\n" +
      `  ${stale.map(([p]) => `npm run build --workspace ${p}`).join("\n  ")}\n`,
  );
  process.exit(1);
}
