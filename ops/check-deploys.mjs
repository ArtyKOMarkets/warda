/**
 * The deploy directories are the one place here where nothing checks anything —
 * and the only place that talks to strangers.
 *
 * Two deploys of the registry endpoint went out green and wrong in the same
 * hour. The first served the handler's own TypeScript source at `/` and
 * reported success. The second printed two compile errors and reported
 * "Deployment completed / status Ready", then failed at runtime on every
 * request. Vercel's typechecking is ADVISORY: it tells you and ships anyway,
 * which is the same green-and-stale shape `check-dist` and `check-core-browser`
 * exist to refuse elsewhere.
 *
 * These directories are deliberately not workspaces — each depends on the
 * PUBLISHED package so an endpoint cannot serve unreleased code. The cost is
 * that they inherit none of the repo's configuration, and every convention that
 * is invisible because it is everywhere stops being true inside them.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];

const tracked = execFileSync("git", ["ls-files", "*/deploy/*"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const dirs = [...new Set(tracked.map((f) => f.slice(0, f.indexOf("/deploy/") + "/deploy".length)))];

for (const dir of dirs) {
  const files = tracked.filter((f) => f.startsWith(dir + "/"));

  /* Only TypeScript deploys. covenant/deploy is Rust and has no business being
     asked for a tsconfig. */
  const ts = files.filter((f) => f.endsWith(".ts"));
  if (ts.length === 0) continue;

  /* 1. `.ts` import specifiers.
     Every workspace here sets allowImportingTsExtensions, so `./x.ts` is the
     house style. A deploy directory has no tsconfig inheritance, so the
     default applies and the specifier is an error:
       TS5097: An import path can only end with a '.ts' extension when
               'allowImportingTsExtensions' is enabled.
     The build reports it and deploys regardless; the function then fails on
     every request. Write `./x.js` — it resolves to x.ts and emits correctly. */
  for (const f of ts) {
    const src = readFileSync(join(root, f), "utf8");
    for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+"(\.[^"]*\.ts)"/gm)) {
      problems.push(`${f}: imports "${m[1]}" — outside a workspace that is TS5097. Use "${m[1].replace(/\.ts$/, ".js")}".`);
    }
  }

  /* 2. A tsconfig of its own, because it inherits none.
     A WARNING, not a failure. mcp/deploy and verify/deploy are live and have
     never had one; adding a tsconfig to a working endpoint changes what its
     build does, and that is not a change to make blind against a production
     service. Named so it is a decision rather than an oversight. */
  if (!existsSync(join(root, dir, "tsconfig.json"))) {
    warnings.push(`${dir}: no tsconfig.json, so its build runs on TypeScript defaults. Live and working; worth adding next time it is deployed deliberately.`);
  }

  /* 3. Does its dependency range admit the version in the tree?
     A caret does not cross the minor on a 0.x version, so ^0.5.1 will never
     install 0.6.0. That is npm working correctly and is exactly how an endpoint
     silently stays a release behind — serving tools the tree stopped having, or
     missing ones it gained. */
  const pkgPath = join(root, dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const deps = JSON.parse(readFileSync(pkgPath, "utf8")).dependencies ?? {};
  for (const [name, range] of Object.entries(deps)) {
    if (!name.startsWith("@warda_protocol/")) continue;
    const local = findWorkspace(name);
    if (!local) continue;
    if (!admits(range, local.version)) {
      problems.push(
        `${dir}: depends on ${name} ${range}, and the tree is at ${local.version}. ` +
          `A caret does not cross the minor on a 0.x version, so this endpoint cannot install it.`,
      );
    }
  }
}

function findWorkspace(name) {
  const ws = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? [];
  for (const w of ws) {
    const p = join(root, w, "package.json");
    if (!existsSync(p)) continue;
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    if (pkg.name === name) return pkg;
  }
  return null;
}

/** Only the shapes this repo uses: ^x.y.z and an exact pin. */
function admits(range, version) {
  const v = version.split(".").map(Number);
  if (!range.startsWith("^")) return range === version;
  const r = range.slice(1).split(".").map(Number);
  if (r[0] !== v[0]) return false;
  /* Below 1.0.0 a caret is locked to the minor as well. */
  if (v[0] === 0) return r[1] === v[1] && v[2] >= r[2];
  return v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2]);
}

if (problems.length > 0) {
  console.error("a deploy directory would ship something the repo cannot check:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nThese directories are not workspaces, on purpose — each serves the PUBLISHED package so\n" +
      "an endpoint cannot run unreleased code. The cost is that they inherit no configuration,\n" +
      "and Vercel's typechecking is advisory: it reports and deploys anyway.",
  );
  process.exit(1);
}

const checked = dirs.length;
console.log(`deploys: ${checked} directories, no .ts specifiers, every dependency range installs.`);
for (const w of warnings) console.log(`  note: ${w}`);
