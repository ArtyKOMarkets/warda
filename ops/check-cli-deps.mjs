#!/usr/bin/env node
/**
 * What the CLI's bundle actually needs, versus what its package.json says.
 *
 * cli/build.mjs inlines every @warda_protocol and @noble import on purpose:
 * "a CLI whose covenant rules could be satisfied by a semver-compatible but
 * different @warda_protocol/kaspa is a CLI that can derive a different address
 * than the one it printed yesterday." The package is meant to declare no
 * runtime dependencies at all, and three optional peers for the things that
 * genuinely are not in the bundle.
 *
 * It did not. It declared `@warda_protocol/agent` as a hard dependency, and
 * the bundle does not reference it anywhere — esbuild inlines it, which is the
 * whole point. So every install dragged in a package it never loaded, and,
 * worse, ops/check-releasable refused to publish the CLI because that phantom
 * dependency had unreleased source. A dependency nothing imports still blocks
 * a release.
 *
 * It also declared `@warda_protocol/mcp` as a hard dependency while the code
 * for `warda mcp` catches a failed resolve and says "it ships separately —
 * npm install @warda_protocol/mcp". Declared as a dependency, that message was
 * unreachable, and the separate versioning it describes was not happening.
 *
 * So: the bundle is the authority. Whatever module specifiers survive the
 * build must be declared as optional peers, and nothing may be declared that
 * the bundle never mentions. The package cannot drift from its own artifact
 * without this failing.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "cli/dist");
const PKG = JSON.parse(readFileSync(join(ROOT, "cli/package.json"), "utf8"));

if (!existsSync(DIST)) {
  /* Not a failure. The bundle is gitignored and built on demand, and a
     checkout that has not built it yet is the normal state — refusing here
     would make `npm test` depend on having run a build. */
  console.log("cli deps: no cli/dist yet (run `npm run build --workspace cli`) — nothing to compare.");
  process.exit(0);
}

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/* Only real module specifiers: a static `from "x"`, a dynamic `import("x")`,
   or a `require.resolve("x")`. Bare strings that merely look like package
   names are excluded on purpose — the bundle carries "@warda_protocol/kaspa"
   as the `builtBy` field of every transaction it writes, and counting that as
   an import would have made this check demand a dependency on the one package
   it most deliberately inlines. */
const PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\.resolve\(\s*["']([^"']+)["']\s*\)/g,
];

const BUILTIN = new Set(builtinModules);
const needed = new Set();
for (const f of files(DIST)) {
  const text = readFileSync(f, "utf8");
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith("node:") || spec.startsWith(".") || spec.startsWith("/")) continue;
      /* A builtin imported without the node: prefix is still a builtin. The
         SDK reaches webcrypto as bare `crypto`, and demanding a dependency on
         it would be demanding a dependency on Node. */
      if (BUILTIN.has(spec)) continue;
      /* A subpath import needs the package, not the subpath. */
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      needed.add(pkg);
    }
  }
}

const peers = new Set(Object.keys(PKG.peerDependencies ?? {}));
const deps = new Set(Object.keys(PKG.dependencies ?? {}));
const optional = new Set(
  Object.entries(PKG.peerDependenciesMeta ?? {})
    .filter(([, v]) => v && v.optional)
    .map(([k]) => k),
);

const problems = [];

for (const n of needed) {
  if (!peers.has(n) && !deps.has(n)) {
    problems.push(
      `the bundle loads ${n} and cli/package.json declares it nowhere.\n` +
        `    An install that does not happen to have it fails at the moment somebody uses that verb.`,
    );
  } else if (peers.has(n) && !optional.has(n)) {
    problems.push(
      `${n} is a peer but not marked optional. Every install would warn about a package\n` +
        `    most people never need.`,
    );
  }
}

for (const d of deps) {
  problems.push(
    `cli/package.json declares ${d} as a DEPENDENCY. This package is a bundle: it should\n` +
      `    declare nothing it does not load at runtime, and optional peers for the rest.` +
      (needed.has(d) ? "" : ` The bundle never mentions ${d}.`),
  );
}

for (const p of peers) {
  if (!needed.has(p)) {
    problems.push(
      `cli/package.json declares the peer ${p}, and the bundle never mentions it.\n` +
        `    A phantom dependency still blocks a release: ops/check-releasable judges what is declared.`,
    );
  }
}

if (problems.length) {
  console.error(`\ncli deps: ${problems.length} problem(s).\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log(
  `cli deps: the bundle loads ${needed.size} external package(s) ` +
    `(${[...needed].sort().join(", ")}), each an optional peer, and nothing else is declared.`,
);
