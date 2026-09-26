/**
 * The instruction a newcomer gets when the borsh transport is missing.
 *
 * Found by installing the PUBLISHED CLI into a clean container and walking `/start`
 * the way a stranger would, on 26 September 2026 — the same day three documented
 * procedures in this repository turned out not to work on the machines they were
 * written for.
 *
 * The path is: `/start` says `npm install -g @warda_protocol/cli`; `warda` with no
 * arguments says `warda node` is the thing to "run this first"; a newcomer with no
 * kaspad of their own runs `warda node --borsh`; and that used to answer
 *
 *     npm install @warda_protocol/borsh @kluster/kaspa-wasm
 *
 * Running exactly that, in the project directory, changes nothing — a global bin
 * does not resolve a local node_modules — and the message repeats verbatim.
 * Verified both ways in a container: installed locally, identical text; installed
 * with `-g`, a different failure entirely.
 *
 * Correct advice given to the wrong layout, with nothing in it to suggest that is
 * what happened, at the first step of the first thing anybody tries.
 */
import assert from "node:assert/strict";
import { sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { insideCwd } from "../src/chain.ts";

const url = (p: string) => pathToFileURL(p).href;

test("a global install is outside the project, so -g is the advice", () => {
  /* The real paths, from the container where this was found. */
  for (const p of [
    "/usr/lib/node_modules/@warda_protocol/cli/dist/warda.js",
    "/opt/homebrew/lib/node_modules/@warda_protocol/cli/dist/warda.js",
    "/Users/a/.local/node/lib/node_modules/@warda_protocol/cli/dist/warda.js",
  ]) {
    assert.equal(insideCwd(url(p), "/Users/a/proj"), false, p);
  }
});

test("a LOCAL dependency is inside it, and telling that layout -g is the same error mirrored", () => {
  /* The case the first fix got wrong: it matched `/lib/node_modules/` and this
     path contains `node_modules`, so a project's own dependency was advised to
     install globally. */
  assert.equal(
    insideCwd(url("/Users/a/proj/node_modules/@warda_protocol/kaspa/dist/chain.js"), "/Users/a/proj"),
    true,
  );
});

test("the repository itself counts as inside", () => {
  assert.equal(insideCwd(url("/Users/a/Desktop/warda/sdk/src/chain.ts"), "/Users/a/Desktop/warda"), true);
});

test("a sibling whose name merely starts the same is NOT inside", () => {
  /* A raw startsWith makes /tmp/warda-abc a child of /tmp/warda-a. */
  assert.equal(insideCwd(url("/tmp/warda-abc/x.js"), "/tmp/warda-a"), false);
  assert.equal(insideCwd(url("/tmp/warda-a/x.js"), "/tmp/warda-a"), true);
});

test("a trailing separator on the cwd changes nothing", () => {
  assert.equal(insideCwd(url("/Users/a/proj/x.js"), "/Users/a/proj" + sep), true);
  assert.equal(insideCwd(url("/usr/lib/node_modules/p/x.js"), "/Users/a/proj" + sep), false);
});

test("the module path being the cwd itself is inside", () => {
  assert.equal(insideCwd(url("/Users/a/proj"), "/Users/a/proj"), true);
});

test("something that is not a file URL makes no claim, and defaults to the local advice", () => {
  /* Bundled and served, or a data: URL. The safer default is the instruction that
     works from a project directory: a spurious -g sends somebody to install
     globally for no reason, which is a worse first five minutes than a missing one. */
  assert.equal(insideCwd("data:text/javascript,export{}", "/Users/a/proj"), true);
  assert.equal(insideCwd("https://example.com/chain.js", "/Users/a/proj"), true);
});
