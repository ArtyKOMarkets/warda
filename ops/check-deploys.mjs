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
 *
 * ## Shipping a change through one of these
 *
 *     npm publish --workspace <pkg>
 *     npm view @warda_protocol/<pkg> version     # wait for it to say the new one
 *     cd <pkg>/deploy && npm install && vercel --prod
 *
 * The middle line is not optional. **npm's packument lags 30–60 seconds behind
 * a successful publish**, so `npm publish` prints `+ pkg@0.2.0` and the very
 * next `npm install` fails with
 *
 *     npm error notarget No matching version found for @warda_protocol/pkg@^0.2.0
 *
 * which reads as "the publish failed" and is not. It has now cost a command in
 * this repo twice. Waiting is the whole fix.
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

  /* 2. A deploy that READS the covenant template must CARRY it.
     verify.wardaprotocol.com answered /health perfectly and returned
     `internal` to every /v1/verify, because loadTemplate resolves the file
     through the SDK's exports map at RUNTIME and a bundler tracing the
     function's imports never sees it. mcp/deploy hit this, solved it with a
     copy beside the entry, and wrote it down — and the lesson stayed where it
     was learned instead of reaching the endpoint that needed it.

     And a copy introduces its own failure, which is why the bytes are compared
     rather than the file merely counted: a STALE template does not throw. The
     bytecode differs, so every address derived from it differs, and the
     service reports healthy grants as missing while looking entirely well. */
  const readsTemplate = ts.some((f) =>
    /loadTemplate|WARDA_TEMPLATE|covenant-template/.test(readFileSync(join(root, f), "utf8")),
  );
  if (readsTemplate) {
    const copies = files.filter((f) => f.endsWith("covenant-template.json"));
    if (copies.length === 0) {
      problems.push(
        `${dir}: reads the covenant template and does not carry a copy. The SDK resolves it at ` +
          `runtime through an exports map, which no bundler follows — the function deploys ` +
          `green and fails on the first request that needs an address.`,
      );
    }
    const master = JSON.parse(readFileSync(join(root, "sdk/covenant-template.json"), "utf8"));
    for (const c of copies) {
      const theirs = JSON.parse(readFileSync(join(root, c), "utf8"));
      if (theirs.baselineHex !== master.baselineHex) {
        problems.push(
          `${c}: has drifted from sdk/covenant-template.json. A stale template does not throw — ` +
            `every address derived from it differs, so healthy grants are reported missing and ` +
            `the service looks entirely well.`,
        );
      }
    }
  }

  /* 3. A tsconfig of its own, because it inherits none.
     A WARNING, not a failure. mcp/deploy and verify/deploy are live and have
     never had one; adding a tsconfig to a working endpoint changes what its
     build does, and that is not a change to make blind against a production
     service. Named so it is a decision rather than an oversight. */
  if (!existsSync(join(root, dir, "tsconfig.json"))) {
    warnings.push(`${dir}: no tsconfig.json, so its build runs on TypeScript defaults. Live and working; worth adding next time it is deployed deliberately.`);
  }

  /* 4. Does its dependency range admit the version in the tree?
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
    /* 5. Has the package CHANGED since that version was released?
       The registry endpoint read a document it could not parse and reported
       MISSING_FIELD, BAD_SIGNATURE_SHAPE and HOST_MISMATCH on a listing that
       was perfectly valid — because it was running the published 0.1.0, and
       multi-service support had been added to the tree afterwards without a
       version bump. The tree said 0.1.0 and npm said 0.1.0 and they were not
       the same code.

       Range checks cannot see that: the range admitted the version, and the
       version matched. What is checkable offline is git — source committed
       after the commit that introduced the current version number is source
       nobody can install. For a package the deploy serves, that is not
       work-in-progress; it is an endpoint that cannot do what the repo says it
       does. */
    const unreleased = commitsSinceVersion(local.name, local.version);
    if (unreleased > 0) {
      /* A NOTE, and deliberately not a failure. These directories are meant to
         lag: serving the published package is what stops an endpoint running
         unreleased code, so drift is the feature working. What cost an hour
         today was drift nobody had been told about — the tree and npm both
         said 0.1.0 and were different code, and the endpoint's answer looked
         like a broken listing rather than a stale dependency.

         So it is printed every run, with a count, and acting on it is a
         decision. Making it fail would turn the design into an obligation to
         publish on every commit. */
      warnings.push(
        `${dir}: serves ${name} ${local.version}, and ${unreleased} commit(s) have changed its ` +
          `source since. That is the endpoint lagging the tree ON PURPOSE — but if you are ` +
          `expecting it to do something added since, publish first.`,
      );
    }

    if (!admits(range, local.version)) {
      problems.push(
        `${dir}: depends on ${name} ${range}, and the tree is at ${local.version}. ` +
          `A caret does not cross the minor on a 0.x version, so this endpoint cannot install it.`,
      );
    }
  }
}

/**
 * Commits touching a package's source since the commit that set its current
 * version. Zero means the published artefact and the tree agree.
 */
function commitsSinceVersion(name, version) {
  const dir = workspaceDirFor(name);
  if (!dir) return 0;
  try {
    /* The commit that introduced this version string into package.json. */
    const set = execFileSync(
      "git",
      ["log", "-1", "--format=%H", `-S"version": "${version}"`, "--", `${dir}/package.json`],
      { cwd: root, encoding: "utf8" },
    ).trim();
    if (!set) return 0;
    const since = execFileSync(
      "git",
      ["log", "--format=%H", `${set}..HEAD`, "--", `${dir}/src`, `${dir}/README.md`],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    return since.length;
  } catch {
    /* No git, a shallow clone, or a version never committed. Not a finding. */
    return 0;
  }
}

function workspaceDirFor(name) {
  const ws = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).workspaces ?? [];
  for (const w of ws) {
    const p = join(root, w, "package.json");
    if (!existsSync(p)) continue;
    if (JSON.parse(readFileSync(p, "utf8")).name === name) return w;
  }
  return null;
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
