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
 *
 * ## And the second rule, from the same week
 *
 * A key file is the single copy of an authority only while it is the only
 * copy. `quickstart` wrote the agent's secret at 0600 and then PRINTED it, so
 * every grant it created left the authority in scrollback, in shell history,
 * and in the log of whatever ran the command. That was survivable while
 * creating a grant was something a person did by hand and watched; `warda
 * topup` issues them on a schedule, where the audience for that line is a cron
 * mail spool.
 *
 * So: a variable this repo writes at 0600 may not also be interpolated into
 * output. Printing the PATH is the whole of what a caller needs, and a tool
 * that has written the file has nothing left to say about its contents.
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

/** `writeFileSync(x, SECRET + "\n", { mode: 0o600 })` — the name of the secret. */
const SECRET_ARG = /writeFileSync\s*\(\s*[^,]+,\s*([A-Za-z_$][\w$]*)\b/;
/** Anything that puts a string in front of a person or a log. */
const PRINTS = /\b(?:console\.(?:log|error|warn|info)|say|process\.(?:stdout|stderr)\.write)\s*\(/;

let scanned = 0;
for (const d of DIRS) {
  for (const file of sources(join(ROOT, d))) {
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    scanned++;

    /* Every variable this file writes as a secret. Collected first, because
       the print that leaks one can sit either side of the write. */
    const secrets = new Set();
    lines.forEach((line, i) => {
      if (!/mode:\s*0o600/.test(line)) return;
      for (let j = Math.max(0, i - 3); j <= i; j++) {
        const m = SECRET_ARG.exec(lines[j] ?? "");
        if (m) secrets.add(m[1]);
      }
    });

    for (const name of secrets) {
      const interpolated = new RegExp("\\$\\{\\s*" + name + "\\s*[}.+ ]");
      lines.forEach((line, i) => {
        if (!PRINTS.test(line) || !interpolated.test(line)) return;
        failures.push(
          `${file.slice(ROOT.length)}:${i + 1}: prints \`${name}\`, which this file writes at 0600.\n` +
            `  A secret that is also printed is in scrollback, in shell history, and in the log of\n` +
            `  whatever ran the command. Print the PATH; the file is the copy that is supposed to exist.`,
        );
      });
    }

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
