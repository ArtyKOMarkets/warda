#!/usr/bin/env node
/**
 * Bundle the hosted runner into api/index.js.
 *
 *   node runner/deploy/build.mjs
 *
 * Every other deploy directory here installs PUBLISHED packages, so an
 * endpoint cannot serve unreleased code. This one cannot: the runner and the
 * agent wallet it drives (@warda_protocol/agent) have never been published.
 * So the bundle is built from the working tree at deploy time, by deploy.sh,
 * and never committed — a bundle in git is a second copy of the source, and
 * the one that drifts. What is left external is what must be installed as
 * itself: the database driver, Turnkey's SDK, and the borsh reader with its
 * WASM, which a bundler cannot inline.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, "entry.mjs")],
  outfile: join(here, "api", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@neondatabase/serverless", "@turnkey/sdk-server", "@warda_protocol/borsh", "@kluster/kaspa-wasm"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
  legalComments: "none",
});
console.log("runner deploy: bundled api/index.js");
