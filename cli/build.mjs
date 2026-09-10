/**
 * Build the published CLI.
 *
 * The repo runs `warda` straight from TypeScript: cli/warda.ts spawns
 * sdk/tools/*.ts by a path relative to itself, and everything resolves because
 * the whole tree is there. Installed from npm none of that is true — there is
 * no sdk/ above node_modules/@warda_protocol/cli, and `files` cannot reach
 * outside a package directory. Published as-is, every subcommand would fail
 * with ENOENT on its own script.
 *
 * So the package ships bundles instead of a checkout: warda.js plus one file
 * per tool it spawns, each carrying the SDK source it uses. Two consequences
 * are deliberate.
 *
 * NOTHING IS EXTERNAL. Every @warda_protocol and @noble import is inlined, so
 * the package declares no runtime dependencies at all. A CLI whose covenant
 * rules could be satisfied by a semver-compatible but different @warda_protocol
 * /kaspa is a CLI that can derive a different address than the one it printed
 * yesterday; inlining makes the rules part of the artifact and the version on
 * the tin the version that runs.
 *
 * IT STILL SPAWNS. The tools keep their own processes rather than becoming
 * function calls, because the documented contract of this CLI is its exit
 * codes — 3 means the covenant refused and nothing was spent, 4 means paid and
 * not served, do not retry. Those come from the child, and /start tells people
 * in another language to read them. Turning the tools into imports would mean
 * reimplementing that mapping by hand, which is exactly the kind of second
 * implementation of the rules this package promises not to be.
 */
import { build } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here("dist");

/* Every script cli/warda.ts spawns. Kept as an explicit list rather than a
   glob of sdk/tools: that directory holds a dozen more tools which are repo
   plumbing, and shipping them would put scripts in the package that its own
   help never mentions. If a new verb starts spawning something, this list is
   the one place that has to know. */
const TOOLS = [
  "../sdk/tools/check-node.ts",
  "../sdk/tools/new-key.ts",
  "../sdk/tools/wallet.ts",
  "../sdk/tools/consolidate.ts",
  "../sdk/tools/quickstart.ts",
  "../sdk/tools/genesis.ts",
  "../sdk/tools/follow-grant.ts",
  "../sdk/tools/which-key.ts",
  "../agents/tools/buy.ts",
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Not minified. Somebody deciding whether to hand this thing a spending key
  // should be able to read what it does, and `npm pack` is how they will look.
  minify: false,
  sourcemap: false,
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [here("warda.ts")],
  outfile: `${out}/warda.js`,
});

/* warda.ts carries its own shebang — `env -S node --experimental-strip-types`,
   which is what makes it runnable as the repo's bin. esbuild preserves it, and
   a banner would simply have put a second shebang above it. Rewrite the line
   instead: the bundle is JavaScript, the flag is unnecessary there, and from
   Node 24 it is deprecated. */
const built = `${out}/warda.js`;
const js = readFileSync(built, "utf8");
if (!js.startsWith("#!")) throw new Error("expected a shebang to replace");
writeFileSync(built, "#!/usr/bin/env node\n" + js.slice(js.indexOf("\n") + 1));

/* One build per tool, each with an explicit outfile. Given a list of entry
   points esbuild mirrors their shared directory structure into outdir, which
   would scatter these into dist/tools/sdk/tools/ and dist/tools/agents/tools/
   — and quickstart finds new-key and genesis as SIBLINGS by filename, so a
   layout that reflects where they came from in the repo is a layout where it
   cannot find them. Flat is the requirement, not a preference. */
for (const entry of TOOLS) {
  const name = entry.slice(entry.lastIndexOf("/") + 1).replace(/\.ts$/, ".js");
  await build({ ...common, entryPoints: [here(entry)], outfile: `${out}/tools/${name}` });
}

chmodSync(`${out}/warda.js`, 0o755);
console.log(`built dist/warda.js and ${TOOLS.length} tools`);
