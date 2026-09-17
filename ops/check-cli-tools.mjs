#!/usr/bin/env node
/**
 * Every tool `warda` spawns must be in the bundle it ships.
 *
 * `cli/warda.ts` runs `sdk/tools/*.ts` as child processes. In the repo those
 * resolve because the whole tree is there; installed from npm they resolve
 * only if `cli/build.mjs` bundled them. The two lists are maintained by hand,
 * one file apart, and nothing joined them.
 *
 * On 17 September that cost `warda revoke`. The verb existed, its own comment
 * explained that revoke "must be reachable in a hurry, and it was the only
 * thing that needed the most setup" — and build-exit.ts was never added to
 * TOOLS, so the emergency stop was the one command broken in the published
 * package. It failed with MODULE_NOT_FOUND on a grant somebody was trying to
 * stop.
 *
 * A list that must match another list is a guard's job, not a reader's.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const warda = readFileSync(ROOT + "cli/warda.ts", "utf8");
const build = readFileSync(ROOT + "cli/build.mjs", "utf8");

/* Any repo tool named in the dispatcher, however it is spelled — a plain
   argument, a ternary, a variable initialised from a literal. Matching the
   PATH rather than the call shape is what makes this robust to how somebody
   writes the next one. `mcp/src/server.ts` is deliberately not matched: it is
   spawned only under `!BUNDLED`, and the package resolves its real dependency
   instead. */
const spawned = [...warda.matchAll(/["'`]((?:sdk|agents|growth)\/tools\/[\w.-]+\.ts)["'`]/g)]
  .map((m) => m[1])
  .filter((v, i, a) => a.indexOf(v) === i)
  .sort();

const bundled = [...build.matchAll(/["']\.\.\/((?:sdk|agents|growth)\/tools\/[\w.-]+\.ts)["']/g)]
  .map((m) => m[1])
  .filter((v, i, a) => a.indexOf(v) === i)
  .sort();

const missing = spawned.filter((t) => !bundled.includes(t));
const extra = bundled.filter((t) => !spawned.includes(t));

if (missing.length) {
  console.error(`\ncli tools: ${missing.length} spawned but not bundled.\n`);
  for (const m of missing) {
    console.error(
      `  ${m}\n` +
        `    cli/warda.ts runs this. cli/build.mjs does not ship it, so the verb that\n` +
        `    calls it fails with MODULE_NOT_FOUND for anybody who installed from npm.\n` +
        `    Add "../${m}" to TOOLS.\n`,
    );
  }
  process.exit(1);
}

/* Bundled-but-never-spawned is not a failure: `genesis.ts` is spawned by
   quickstart rather than by the dispatcher, and shipping it is correct. Worth
   naming so the list does not quietly accumulate. */
console.log(
  `cli tools: ${spawned.length} spawned, all bundled` +
    (extra.length ? `; ${extra.length} bundled for a child to spawn (${extra.join(", ")})` : "") +
    ".",
);
