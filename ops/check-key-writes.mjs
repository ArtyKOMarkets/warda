#!/usr/bin/env node
/**
 * A key file is the single copy of an authority. Writing one over another is
 * not a state any tool here can undo, so it is a state no tool here may enter
 * without being asked twice.
 *
 * This exists because on 17 September `warda key --out funder.key`, run a
 * second time from a pasted setup block, silently replaced a key holding 1000
 * KAS. The coin was still at the old address; the only copy of the key that
 * could move it was not. That is the third key this project has lost, and the
 * first one a guard could have caught.
 *
 * The rule: a `writeFileSync` with mode 0600 — this repo's marker for a
 * secret — must be preceded, within its function, by an `existsSync` check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["sdk/tools", "agents/tools", "cli", "growth/tools"];
const failures = [];

function sources(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (e === "node_modules" || e.includes(".stale.") || e.includes(".removed")) continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

let scanned = 0;
for (const d of DIRS) {
  for (const file of sources(join(ROOT, d))) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    scanned++;
    lines.forEach((line, i) => {
      if (!/mode:\s*0o600/.test(line)) return;

      /* Look back a bounded way for the guard. A window rather than the whole
         file, because an existsSync three hundred lines away about some other
         path is not a guard on this write — but wide enough to clear the
         refusal message itself, which is long on purpose and sits between the
         check and the write it protects. */
      const from = Math.max(0, i - 60);
      const window = lines.slice(from, i).join("\n");
      if (/existsSync\s*\(/.test(window)) return;

      failures.push(
        `${file.slice(ROOT.length)}:${i + 1}: writes a secret (mode 0600) with no existsSync above it.\n` +
          `  A key file is the only copy of an authority. Check it does not already exist and\n` +
          `  refuse — with a --force for somebody who means it — before writing over one.`,
      );
    });
  }
}

if (failures.length) {
  console.error(`\nkey writes: ${failures.length} unguarded.\n`);
  for (const f of failures) console.error(f + "\n");
  process.exit(1);
}
console.log(`key writes: ${scanned} tool sources, every secret write checks for an existing file first.`);
