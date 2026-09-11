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
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["sdk", "x402", "mcp", "vendor", "verify", "borsh"];

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
      `  ${stale.map(([p]) => `npm run build --workspace @warda_protocol/${p === "sdk" ? "kaspa" : p}`).join("\n  ")}\n`,
  );
  process.exit(1);
}
