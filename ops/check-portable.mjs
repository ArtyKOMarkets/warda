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
  /**
   * `seq 1 $n` where n can be 0 — and it always can.
   *
   * Not a GNU-only construct, which is why this list did not have it and why
   * ops/principal-bundle.sh passed this check and then died on the Mac:
   *
   *     ops/principal-bundle.sh: line 36: !i: unbound variable
   *
   * BSD seq counts DOWN when the end is below the start, so `seq 1 0` prints
   * "1 0" where GNU seq prints nothing. The loop that was meant not to run ran
   * once, with an index nothing was at.
   *
   * The variable is the hazard: `seq 1 5` is fine on both and `seq 1 $#` is a
   * countdown on macOS every time the argument list is empty — the default path,
   * which is the one nobody tests.
   */
  {
    re: /\bseq\s+1\s+[$"']/,
    why:
      "`seq 1 $n` counts DOWN on BSD when n is 0, where GNU seq prints nothing — " +
      "so the loop runs when it should not. Use `while [ $# -gt 0 ]` with shift for " +
      "arguments, or a C-style `for ((i=1; i<=n; i++))`.",
  },
];

/**
 * A separate pass, because this one is about STRUCTURE rather than a word.
 *
 * An unquoted heredoc interpolates, which is the point of using one — these
 * scripts write JSON status files full of $now and $ok. It also runs backticks
 * and $(…) as command substitution, including inside what the author is
 * reading as prose. `ops/check-verify.sh` carried the word `found` in
 * backticks in a JSON comment and every successful run printed
 *
 *     ./ops/check-verify.sh: line 116: found: command not found
 *
 * on stderr. The file was written, the exit code was 0, and the noise was the
 * precise kind that teaches somebody to stop reading a monitor's output.
 *
 * Quoting the delimiter (<<'JSON') turns substitution off and the
 * interpolation with it, so that is not the fix — not writing backticks in the
 * body is.
 */
function heredocSubstitutions(text) {
  const out = [];
  const lines = text.split("\n");
  let end = null, startedAt = 0;
  lines.forEach((line, i) => {
    if (end === null) {
      /* Unquoted delimiters only: <<'X' and <<"X" do not substitute. */
      const m = line.match(/<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (m && !/<<-?\s*['"]/.test(line)) { end = m[1]; startedAt = i + 1; }
      return;
    }
    if (line.trim() === end) { end = null; return; }
    if (/`|\$\(/.test(line)) {
      out.push({
        line: i + 1,
        text: line.trim(),
        why:
          `a backtick or $( inside an unquoted heredoc (opened line ${startedAt}) is COMMAND ` +
          `SUBSTITUTION, even in prose. This already printed "found: command not found" from a ` +
          `run that succeeded.`,
      });
    }
  });
  return out;
}

const scripts = execFileSync("git", ["ls-files", "*.sh"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

/**
 * Is every script executable IN GIT?
 *
 * Not on disk — in the index, which is what a fresh clone gets and what cron
 * will find. This repository is edited through a mount that does not carry the
 * mode, so a file rewritten by a tool comes back 644 and `git add` records that
 * faithfully. Nothing in a diff shows it and nothing in a review catches it.
 *
 * It has now happened three times. `check-vendor.sh` shipped without its bit
 * and install-cron.sh carries a paragraph about what that costs: under cron the
 * entry fires, fails instantly, and appends nothing to a log whose whole
 * purpose is to be empty when things are well — a monitor that cannot start
 * looks exactly like a monitor with nothing to report. Then, in the very commit
 * that added a new monitor and quoted that paragraph, both the new script AND
 * install-cron.sh itself lost their bit. The second is the worse one: it is the
 * script that repairs everyone else's.
 *
 * The fix is `git update-index --chmod=+x <file>`, which sets the mode in the
 * index regardless of what the working tree can express.
 */
const modes = execFileSync("git", ["ls-files", "-s", "*.sh"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map((l) => ({ mode: l.slice(0, 6), file: l.split("\t")[1] }));

const notExecutable = modes.filter((m) => m.mode !== "100755");

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
  for (const h of heredocSubstitutions(lines.join("\n"))) problems.push({ file, ...h });
}

if (notExecutable.length > 0) {
  console.error("a shell script is not executable in git, so a fresh clone cannot run it:\n");
  for (const m of notExecutable) console.error(`  ${m.mode}  ${m.file}`);
  console.error(
    "\nThe working tree is not the question — the INDEX is what a clone gets and what cron\n" +
      "finds. This repo is edited through a mount that does not carry the mode, so a rewritten\n" +
      "file comes back 644 and `git add` records it. Nothing in the diff shows it.\n\n" +
      "  git update-index --chmod=+x " + notExecutable.map((m) => m.file).join(" "),
  );
  process.exit(1);
}

if (problems.length === 0) {
  console.log(
    `portable: ${scripts.length} shell scripts, all executable in git, nothing bash-4 or GNU-only.`,
  );
  process.exit(0);
}
console.error("a shell script will not run on macOS, which is where these run:\n");
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(`    ${p.text}`);
  console.error(`    ${p.why}\n`);
}
process.exit(1);
