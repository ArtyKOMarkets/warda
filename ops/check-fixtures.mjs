/**
 * Does every file the tests read actually exist in a fresh checkout?
 *
 * ## The failure this catches
 *
 * `test/buy-e2e.test.ts` read the demo agent's key from
 * `covenant/deploy/demo-agent.key`. `.gitignore` matches `*.key`, so the file
 * exists on a machine that has run the deploy and nowhere else — and the six
 * most end-to-end tests in the repository passed locally, every time, while
 * being incapable of running on a clean clone. CI found it, which is what CI
 * is for; the point of this file is that it should not have had to.
 *
 * It is the same shape as `ops/check-dist.mjs` and the same shape as most of
 * what has gone wrong here lately: something true on the machine it was
 * written on, quietly untrue everywhere else, with nothing arranged to notice.
 * `check-dist` watches for a stale `dist`. This watches for a fixture that is
 * only local.
 *
 * ## How it decides
 *
 * It reads the string literals inside `repo("...")` and `new URL("...")` in
 * every test file, resolves them, and asks git whether the result is TRACKED.
 * Tracked is the question, not "exists" — a file that exists here and is not
 * committed is precisely the bug.
 *
 * Paths that leave the repository, and paths built at runtime out of
 * variables, are not examined: this reads literals, so a fixture assembled
 * from pieces slips past. That is a real limit and it is the honest one — a
 * scanner that pretended to understand the code would miss different things
 * and say so less clearly.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

const testFiles = git(["ls-files", "*test/*.test.ts", "*.test.ts"])
  .split("\n")
  .filter(Boolean);

/* `repo("x/y")` is this repo's own helper; `new URL("../x", import.meta.url)`
   is the pattern the workspace tests use. Only literals — see above. */
const PATTERNS = [
  /\brepo\(\s*"([^"]+)"\s*\)/g,
  /new URL\(\s*"(\.\.[^"]+)"\s*,\s*import\.meta\.url\s*\)/g,
];

const tracked = new Set(git(["ls-files"]).split("\n").filter(Boolean));
const problems = [];

for (const file of testFiles) {
  const text = readFileSync(resolve(root, file), "utf8");
  for (const pattern of PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const raw = m[1];
      /* A directory, a glob, or something with no extension is not a fixture
         this can judge — output directories are created by the test itself. */
      if (!/\.[a-z0-9]+$/i.test(raw)) continue;
      const abs = resolve(root, dirname(file), raw.startsWith("..") ? raw : "");
      const path = raw.startsWith("..") ? abs : resolve(root, raw);
      const rel = relative(root, path);
      if (rel.startsWith("..")) continue;            // outside the repo
      /* Installed by `npm ci`, so present in CI and correctly absent from git.
         A dependency's own files are not this repository's fixtures. */
      if (rel.startsWith("node_modules/") || rel.includes("/node_modules/")) continue;
      if (tracked.has(rel)) continue;                // committed: fine
      problems.push({ file, raw, rel, here: existsSync(path) });
    }
  }
}

if (problems.length === 0) process.exit(0);

console.error("a test depends on a file that is not committed:\n");
for (const p of problems) {
  console.error(`  ${p.file}`);
  console.error(`    reads ${p.raw}`);
  console.error(
    p.here
      ? `    which exists HERE and is not tracked by git — so this test passes on\n` +
        `    this machine and fails on a fresh checkout, which is worse than failing.`
      : `    which does not exist at all.`,
  );
  let why = "";
  try {
    why = git(["check-ignore", "-v", p.rel]).trim();
  } catch {
    /* not ignored; simply never committed */
  }
  if (why) console.error(`    ignored by ${why.split("\t")[0]}`);
  console.error("");
}
console.error(
  "Either commit the fixture, or inline the value. A key file is NOT a reason to\n" +
    "make an exception: `covenant/deploy/demo-agent.key` held a secret published on\n" +
    "/attack, and reading it from a gitignored path bought no secrecy and cost six\n" +
    "tests. If a fixture genuinely cannot be committed, the test has to build it.",
);
process.exit(1);
