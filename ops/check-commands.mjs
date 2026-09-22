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

/**
 * A command must not redirect onto the file it is meant to produce.
 *
 * `> site/src/agent-002.json` truncates the reading BEFORE the tool runs. These
 * tools refuse loudly rather than publish a page about a grant that has moved
 * — and with a plain redirect, refusing deletes the page's data as the price of
 * refusing. Agent #002's reading was destroyed by the check that was protecting
 * it and had to be recovered from git. Write to `.new` and `mv` on success.
 */
for (const [i, raw] of commands.entries()) {
  const flat = raw.replace(/\\\n\s*/g, " ");
  const target = flat.match(/>\s*(\S+)/)?.[1];
  if (target && !target.endsWith(".new")) {
    problems.push(
      `command ${i + 1} redirects straight onto ${target} — a refusal would truncate it. ` +
        `Use \`> ${target}.new && mv ${target}.new ${target}\`.`,
    );
  }
}

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

  /**
   * Every flag the script MENTIONS, not only the ones it reads through a
   * helper.
   *
   * It started as `flag("x")` and `has("x")` and produced a false positive on
   * the first command it was asked about: `--settled` is read by a reduce over
   * argv comparing `a === "--settled"`, which no helper pattern can see. A
   * guard that blocks a correct command is worse than one with a gap, because
   * the way past it is to stop believing it.
   *
   * So: any `--flag` appearing anywhere in the script's source, including its
   * usage text. The gap that leaves is a tool that documents a flag it does
   * not read. The gap it closes is the one that cost something — `--borsh`,
   * which appeared nowhere in dashboard.ts at all.
   */
  const known = new Set([
    /* Read through the usual helpers... */
    ...[...src.matchAll(/\b(?:flag|has)\(\s*"([^"]+)"/g)].map((m) => m[1]),
    /* ...or mentioned literally anywhere, including a usage string or an argv
       comparison. Both are needed: `--also` is only ever `flag("also")` and
       never appears as text, while `--settled` is only ever compared as
       `a === "--settled"` and never passes through a helper. Taking one and
       not the other produced a false positive each way within a minute. */
    ...[...src.matchAll(/--([A-Za-z][\w-]*)/g)].map((m) => m[1]),
  ]);

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

/**
 * The console prints a command too, and nobody was checking it.
 *
 * `/app` assembles a `warda grant` line from what you typed and shows it to
 * you to paste. It was doing that with two flags the CLI does not have:
 * `--window`, which genesis reads but `warda grant` never forwarded, and
 * `--agent`, which does not exist there at all because the agent key is
 * generated by the command rather than supplied to it. Both would have been
 * ignored in silence — and `--window` was the term, one of the four things the
 * covenant enforces. Somebody would have set a 7-day agent, pasted the
 * command, and got 30 days.
 *
 * Same question as above, asked of a different printer of commands: could this
 * possibly work. The flags are string literals in the page, so they can be
 * read without running anything.
 */
const consoleSrc = readFileSync(resolve(root, "site/src/app.html"), "utf8");
const emit = consoleSrc.match(/\$\("cmd"\)\.textContent =([\s\S]*?);\n/);
if (!emit) {
  problems.push(
    "site/src/app.html no longer assigns $(\"cmd\").textContent, so the command it " +
      "shows people is not being checked. If the console stopped printing one, delete " +
      "this check with it.",
  );
} else {
  /* Comments stripped first. The CLI's prose explains that it converts --days
     into genesis's --window, which made `--window` look like a flag the CLI
     reads — so the first run of this check passed a console printing exactly
     the flag it was written to catch. Every guard in ops/ has now learned this
     the same way: check-router on its own vocabulary, check-nav-tokens on its
     own token, and this one on a sentence written ten minutes earlier.
     Newlines are preserved so nothing downstream loses its place. */
  const cliSrc = readFileSync(resolve(root, "cli/warda.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
  /* Flags the CLI READS, and only those.
     The commands above use a looser rule — any `--flag` in the script's text —
     because those scripts read argv in ways no pattern can see. The CLI does
     not: every flag it honours goes through `flag()` or `has()`. And the loose
     rule is actively wrong here, because the CLI's source is full of flags it
     PASSES DOWNSTREAM: `--window`, `--recipients`, `--agent-out`, `--via` are
     all strings in this file and none of them is a flag you may type. Taking
     them as known is how the second run of this check also passed a console
     printing `--window`. */
  const cliKnown = new Set([
    ...[...cliSrc.matchAll(/\b(?:flag|has)\(\s*"([^"]+)"/g)].map((m) => m[1]),
    ...[...cliSrc.matchAll(/(?:===|includes\()\s*"--([\w-]+)"/g)].map((m) => m[1]),
  ]);
  for (const m of emit[1].matchAll(/--([a-z][\w-]*)/g)) {
    if (!cliKnown.has(m[1])) {
      problems.push(
        `the console at /app prints \`warda grant --${m[1]}\`, which cli/warda.ts never ` +
          `reads. It would be ignored in silence by whoever pastes it.`,
      );
    }
  }

  /* The controls — revoke, reclaim, renew, find — print commands too, and a
     revoke button whose command carries a flag the CLI ignores is the worst
     kind of silent. They live between two markers in app.html; every
     `warda <verb>` string there is checked, verb and flags both. */
  /* Both consoles print commands: the classic page and console/src/lib/commands.ts,
     which the React console draws every control from. Each keeps the same two
     markers, and every `warda <verb>` between them is checked, verb and flags both. */
  const nextCmds = resolve(root, "console/src/lib/commands.ts");
  const sources = [["site/src/app.html", consoleSrc]];
  if (existsSync(nextCmds)) sources.push(["console/src/lib/commands.ts", readFileSync(nextCmds, "utf8")]);
  const verbs = new Set([...cliSrc.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));
  for (const [where, text] of sources) {
    const block = text.match(/\/\* warda-commands \*\/([\s\S]*?)\/\* end warda-commands \*\//);
    if (!block) {
      problems.push(`${where} has no /* warda-commands */ block, so the controls' commands are not being checked.`);
      continue;
    }
    for (const m of block[1].matchAll(/"warda ([a-z-]+)([^"]*)"/g)) {
      if (!verbs.has(m[1])) problems.push(`${where} prints \`warda ${m[1]}\`, which is not a command cli/warda.ts has.`);
      for (const f of m[2].matchAll(/--([a-z][\w-]*)/g)) {
        if (!cliKnown.has(f[1])) {
          problems.push(`${where} prints \`warda ${m[1]} --${f[1]}\`, which cli/warda.ts never reads.`);
        }
      }
    }
  }
}

if (problems.length === 0) {
  console.log(`commands: ${commands.length} recorded and the console's own, every flag is one the tool reads.`);
  process.exit(0);
}
console.error("build.py records a command that cannot work:\n");
for (const p of problems) console.error(`  ${p}`);
console.error(
  "\nThese are printed when a page is dropped, to somebody who cannot test them.\n" +
    "Check them against the tool's own flag() calls, not against a neighbouring command.",
);
process.exit(1);
