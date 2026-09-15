/**
 * Do the commands build.py prints actually exist?
 *
 * ## The failure this catches
 *
 * `site/build.py` drops a page whose data is missing and prints the command
 * that would produce it. That command is written once and read months later,
 * by somebody who cannot run it against anything to check — so a flag that was
 * never real, or one the tool requires and it omits, is discovered at exactly
 * the wrong moment: when a page is already missing and you are trying to fix
 * it.
 *
 * It happened the first time this file existed. The agent-005 command was
 * written from the shape of its neighbours rather than from the tool: it
 * passed `--borsh`, which `dashboard.ts` has never had and would have ignored
 * in silence, and it omitted `--purchases`, which `dashboard.ts` requires.
 * Neither is visible by reading, and both are obvious in one pass over the
 * script's own `flag(...)` calls.
 *
 * ## How it decides
 *
 * For each recorded command it finds the `.ts` entry point, reads every
 * `flag("x")` / `has("x")` the script asks for, and compares. A flag the
 * script does not read is an error. A flag the script REQUIRES — named in the
 * `if (!a || !b)` guard next to its usage text — and the command does not pass
 * is also an error.
 *
 * This is static and shallow on purpose. It does not run anything, it does not
 * know whether the values are right, and a tool that reads argv some other way
 * is invisible to it. It answers one question — could this command possibly
 * work — which is the question nobody could answer by looking.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* The commands as build.py stores them, read by asking Python — parsing its
   string-continuation syntax from JS would be a second implementation of it. */
const commands = JSON.parse(
  execFileSync(
    "python3",
    ["-c",
     "import json,re,pathlib;" +
     "s=pathlib.Path('site/build.py').read_text();" +
     "m=re.search(r'^AGENTS = \\[(.*?)^\\]', s, re.S|re.M);" +
     "ns={};exec('AGENTS = ['+m.group(1)+']', ns);" +
     "print(json.dumps([a[2] for a in ns['AGENTS']]))"],
    { cwd: root, encoding: "utf8" },
  ),
);

const problems = [];

for (const raw of commands) {
  const cmd = raw.replace(/\\\n\s*/g, " ");
  const script = cmd.match(/([\w./-]+\.ts)\b/)?.[1];
  if (!script) continue;
  /* Agent #001's command runs from its own directory: `cd agent && node
     tools/dashboard.ts ...`. The path is relative to that, not to the repo. */
  const from = cmd.match(/^\s*cd\s+([\w./-]+)\s*&&/)?.[1] ?? ".";
  const path = resolve(root, from, script);
  if (!existsSync(path)) {
    problems.push(`${from}/${script} does not exist, and a command names it`);
    continue;
  }
  const src = readFileSync(path, "utf8");

  const known = new Set([
    ...[...src.matchAll(/\b(?:flag|has)\(\s*"([^"]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/argv\.indexOf\(\s*`--\$\{(\w+)\}`/g)].map(() => null),
  ].filter(Boolean));

  const passed = new Set([...cmd.matchAll(/\s--([\w-]+)/g)].map((m) => m[1]));
  for (const f of passed) {
    if (!known.has(f) && f !== "experimental-strip-types") {
      problems.push(`${script} never reads --${f}, and the command passes it (silently ignored)`);
    }
  }

  /* Required flags: the guard beside the usage text. `if (!manifestPath ||
     !agentId || !recipientsPath || !purchasesDir)` names the locals, and each
     local was assigned from a flag() call a few lines above. */
  const guard = src.match(/if \(!\w+(?: \|\| !\w+)+\) \{\s*\n\s*console\.error\(\s*\n?\s*"usage:/);
  if (guard) {
    const locals = [...guard[0].matchAll(/!(\w+)/g)].map((m) => m[1]);
    for (const local of locals) {
      const from = src.match(new RegExp(`const ${local} = flag\\("([^"]+)"\\)\\s*;`));
      if (from && !passed.has(from[1])) {
        problems.push(`${script} requires --${from[1]} and the command omits it`);
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`commands: ${commands.length} recorded, every flag is one the tool reads.`);
  process.exit(0);
}
console.error("build.py records a command that cannot work:\n");
for (const p of problems) console.error(`  ${p}`);
console.error(
  "\nThese are printed when a page is dropped, to somebody who cannot test them.\n" +
    "Check them against the tool's own flag() calls, not against a neighbouring command.",
);
process.exit(1);
