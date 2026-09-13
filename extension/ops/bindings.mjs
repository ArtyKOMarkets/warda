/**
 * Put THIS platform's native bindings in place without evicting the other's.
 *
 * `node_modules/` is shared between the machine that builds and the machine
 * that runs the browser. npm unpacks only the binding of whoever ran the
 * install, so `npm i @rolldown/binding-darwin-arm64` on the Mac empties
 * `binding-linux-arm64-gnu`, and installing that back empties darwin again.
 * Two machines, one directory, one winner — and the loser's build fails with a
 * message about vite, or about lightningcss, or about whichever package the
 * bundler happened to reach first. The second one only appeared after the
 * first was fixed, which is the tell that a list of packages was the wrong
 * model.
 *
 * Both packages can simply coexist: each is looked up by NAME and the wrong
 * platforms are never required. The only thing stopping that is npm's pruning,
 * so this fetches the tarballs and unpacks them directly.
 *
 * The set is not hardcoded. Every package that does this declares its variants
 * as `optionalDependencies`, so the right one is chosen by matching the
 * platform, architecture and libc tokens against those names — which means a
 * new bundler dependency doing the same thing needs one line here, not a new
 * naming rule.
 *
 *   npm run bindings
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Packages whose native half is a per-platform optional dependency. */
const HOSTS = ["rolldown", "lightningcss", "esbuild"];

/** musl and glibc ship different binaries, and the wrong one loads then dies. */
const isMusl = (() => {
  if (process.platform !== "linux") return false;
  try {
    return execFileSync("ldd", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).includes("musl");
  } catch (e) {
    return String(e.stderr ?? "").includes("musl");
  }
})();

/** The variant whose NAME describes this machine. */
function variantFor(names) {
  const tokens = (n) => n.split(/[/@-]/).filter(Boolean);
  const matches = names.filter((n) => {
    const t = tokens(n);
    if (!t.includes(process.platform)) return false;
    if (!t.includes(process.arch)) return false;
    if (process.platform !== "linux") return true;
    // Only one of the two libc spellings may match, and a name carrying
    // neither (some packages omit it) is still a candidate.
    const gnu = t.includes("gnu") || t.includes("gnueabihf");
    const musl = t.includes("musl");
    if (!gnu && !musl) return true;
    return isMusl ? musl : gnu;
  });
  // Prefer the most specific, so "linux-arm64-gnu" wins over "linux-arm64".
  return matches.sort((a, b) => b.length - a.length)[0];
}

const contents = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

let installed = 0;
let failed = 0;

for (const host of HOSTS) {
  /* `require.resolve("<host>/package.json")` is the obvious way and it fails
     on any package whose `exports` does not list package.json — which
     lightningcss does not. Resolving the module itself and walking up to the
     directory that holds a package.json works for both, and the difference
     cost a build: lightningcss was silently skipped and the failure came back
     looking like a new problem. */
  let manifest, modules;
  try {
    let dir = path.dirname(require.resolve(host));
    while (!existsSync(path.join(dir, "package.json"))) {
      const up = path.dirname(dir);
      if (up === dir) throw new Error("no package.json above the entry point");
      dir = up;
    }
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    // node_modules/<name> or node_modules/@scope/<name>: up one, or two.
    modules = path.resolve(dir, host.includes("/") ? "../.." : "..");
  } catch {
    continue; // not a dependency here, which is fine
  }

  const optional = manifest.optionalDependencies ?? {};
  const name = variantFor(Object.keys(optional));
  if (!name) {
    console.error(`${host}: no variant for ${process.platform}-${process.arch}; skipping`);
    continue;
  }
  const version = optional[name];
  const dest = path.join(modules, ...name.split("/"));

  if (contents(dest).some((f) => f.endsWith(".node") || f === "bin")) {
    console.log(`ok    ${name}@${version}`);
    continue;
  }

  const staging = mkdtempSync(path.join(tmpdir(), "warda-binding-"));
  try {
    const tarball = execFileSync("npm", ["pack", `${name}@${version}`, "--pack-destination", staging, "--silent"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .pop();
    mkdirSync(dest, { recursive: true });
    // --strip-components=1 drops the "package/" prefix every npm tarball has.
    execFileSync("tar", ["-xzf", path.join(staging, tarball), "-C", dest, "--strip-components=1"]);
    const got = contents(dest);
    if (!got.some((f) => f.endsWith(".node") || f === "bin")) {
      throw new Error(`no binary in the tarball: ${got.join(", ")}`);
    }
    console.log(`added ${name}@${version}`);
    installed += 1;
  } catch (e) {
    console.error(`FAIL  ${name}@${version}: ${e.message.split("\n")[0]}`);
    failed += 1;
  }
}

console.log(
  installed === 0 && failed === 0
    ? "\nnothing to do — this machine's bindings were already here."
    : `\n${installed} added, ${failed} failed. Both platforms can now sit in the same node_modules.`,
);
process.exit(failed > 0 ? 1 : 0);
