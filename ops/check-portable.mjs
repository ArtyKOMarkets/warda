/**
 * Do the shell scripts here run on the machine they are run on?
 *
 * ## The failure this catches
 *
 * macOS ships **bash 3.2**, released in 2007, and `#!/bin/bash` gets it — not
 * whatever bash 5 homebrew put on the PATH, and not the bash on a Linux CI
 * runner. A script using `mapfile` is syntactically valid, passes `bash -n`
 * on any modern box, and dies at run time on the machine every one of these
 * scripts is actually for.
 *
 * `ops/refresh-agents.sh` did exactly that on its first run:
 *
 *     ops/refresh-agents.sh: line 44: mapfile: command not found
 *     ops/refresh-agents.sh: line 55: COMMANDS: unbound variable
 *
 * And `site/refresh-demo.sh` already carried a paragraph about `sort -z` being
 * a GNU extension BSD does not have, and about what it cost — a signature that
 * silently collapsed, so a run that had built a whole new page reported "no
 * change". The lesson was written down. Writing it down did not stop it.
 *
 * ## What it looks for
 *
 * Constructs that are bash 4+ or GNU-only, matched textually outside comments.
 * It is a list of things that have burned this repository or obviously would,
 * not an emulator: a script can still fail on macOS in a way this misses. It
 * exists so that the ones already paid for cannot recur.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TRAPS = [
  { re: /\bmapfile\b|\breadarray\b/, why: "mapfile/readarray are bash 4; macOS has 3.2. Use `while IFS= read -r` from a file." },
  { re: /\bdeclare\s+-A\b|\blocal\s+-A\b/, why: "associative arrays are bash 4; macOS has 3.2." },
  { re: /\$\{[A-Za-z_][A-Za-z0-9_]*\^\^|\$\{[A-Za-z_][A-Za-z0-9_]*,,/, why: "${x^^} / ${x,,} are bash 4; use tr." },
  { re: /\bsort\b[^|\n]*\s-z\b/, why: "`sort -z` is a GNU extension; BSD sort does not have it. This already collapsed refresh-demo's change signature." },
  { re: /\bsed\s+-i\s+-/, why: "`sed -i` takes a mandatory argument on BSD. Use `sed -i '' -e` or a temp file." },
  { re: /\bdate\s+-d\b/, why: "`date -d` is GNU; BSD date uses -v/-j -f." },
  { re: /\bgrep\s+-P\b/, why: "`grep -P` is not in BSD grep." },
  { re: /\breadlink\s+-f\b/, why: "`readlink -f` is GNU; BSD readlink has no -f." },
  { re: /\bstat\s+-c\b/, why: "`stat -c` is GNU; BSD stat uses -f." },
];

const scripts = execFileSync("git", ["ls-files", "*.sh"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const problems = [];
for (const file of scripts) {
  const lines = readFileSync(resolve(root, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    /* Comments are skipped: these scripts explain the traps at length, and a
       checker that cannot tell an explanation from a use would fail on the
       documentation warning about the thing. */
    if (/^\s*#/.test(line)) return;
    for (const trap of TRAPS) {
      if (trap.re.test(line)) problems.push({ file, line: i + 1, text: line.trim(), why: trap.why });
    }
  });
}

if (problems.length === 0) {
  console.log(`portable: ${scripts.length} shell scripts, nothing bash-4 or GNU-only.`);
  process.exit(0);
}
console.error("a shell script will not run on macOS, which is where these run:\n");
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(`    ${p.text}`);
  console.error(`    ${p.why}\n`);
}
process.exit(1);
