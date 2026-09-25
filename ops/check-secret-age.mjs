/**
 * The secrets this project holds, checked against what it says about them.
 *
 * Two questions, and the second one matters more than the first.
 *
 * **Is it still ignored?** A secret that stops being gitignored is not a
 * policy problem, it is the thing the policy exists to prevent, and it is
 * silent: `git add -A` on a day somebody renamed a directory, and a key is in
 * the history forever. Checked first, and it fails hard.
 *
 * **Is it older than it claims to be rotated?** Softer, and honest about what
 * it can see: this reads the file's MODIFICATION TIME, which is evidence that
 * a secret was rewritten, not proof that the credential behind it was
 * reissued. Somebody can rotate a token at the provider and paste the new one
 * in, which moves the mtime — or rotate and forget, which does not. The check
 * is worth having anyway, for the same reason a smoke alarm is: the failure it
 * catches is the one nobody is thinking about.
 *
 * Anything with a `compromised` date is overdue the moment that date passes,
 * whatever its interval, and stays overdue until the file is newer than it.
 *
 *     node ops/check-secret-age.mjs
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { secrets } = JSON.parse(readFileSync(join(root, "ops/secrets.json"), "utf8"));

const DAY = 86_400_000;
const ignored = (p) => {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { cwd: root });
    return true;
  } catch {
    return false;
  }
};

const exposed = [];
const overdue = [];
const missing = [];

for (const s of secrets) {
  const abs = join(root, s.path);

  /* Ignored is checked whether or not the file is here. A path that has fallen
     out of .gitignore is a trap set for the next person to create it, and they
     will create it without looking. */
  if (!ignored(s.path)) exposed.push(s);

  if (!existsSync(abs)) {
    missing.push(s);
    continue;
  }
  const age = Date.now() - statSync(abs).mtimeMs;

  /* A known compromise clears only when somebody SAYS it has, by setting
     `rotatedAt`. Not when the file's mtime moves — an mtime moves for every
     reason there is, and runner/.env was rewritten for a fee-payee change
     three days after its database password went into a chat window. A check
     keyed on mtime would have called that rotated and gone quiet. */
  if (s.compromised) {
    const done = s.rotatedAt ? Date.parse(s.rotatedAt) : 0;
    if (!(done > Date.parse(s.compromised))) {
      overdue.push({
        s,
        why: `known compromised on ${s.compromised}, and ops/secrets.json does not record it rotated`,
      });
      continue;
    }
  }
  if (s.rotateDays !== null && age > s.rotateDays * DAY) {
    overdue.push({ s, why: `${Math.floor(age / DAY)} days old, and it says ${s.rotateDays}` });
  }
}

let bad = 0;

if (exposed.length) {
  bad += exposed.length;
  console.error(`\n${exposed.length} secret path(s) are NOT ignored by git:\n`);
  for (const s of exposed) console.error(`  ${s.path}  — holds ${s.holds}`);
  console.error(
    `\nThis is the failure the rest of this file is decoration for. Add the path to\n` +
      `.gitignore, and if it has ever been committed, treat the secret as public.\n`,
  );
}

if (overdue.length) {
  console.error(`\n${overdue.length} secret(s) are overdue:\n`);
  for (const { s, why } of overdue) {
    console.error(`  ${s.path}\n    ${why}`);
    console.error(`    can: ${s.can.join("; ")}`);
    if (s.note) console.error(`    ${s.note}`);
  }
  console.error(
    `\nFor an interval: the mtime is evidence, not proof — rotating at the provider and\n` +
      `pasting the new value in moves it, rotating and forgetting does not.\n` +
      `For a known compromise: set \`rotatedAt\` in ops/secrets.json when it is actually\n` +
      `done. Nothing else clears it, deliberately.\n`,
  );
}

if (missing.length) {
  console.log(`\n${missing.length} listed secret(s) are not on this machine, which is normal:`);
  for (const s of missing) console.log(`  ${s.path}`);
}

const known = secrets.length - missing.length;
if (!exposed.length && !overdue.length) {
  console.log(`\nsecrets: ${known} present, every path ignored, none past its stated interval.`);
}

/* Overdue does not fail the build; exposed does.
 *
 * A rotation clock that breaks CI gets the interval raised rather than the
 * secret rotated, which is worse than not having one. An unignored secret is
 * not a clock, it is an incident. */
process.exit(bad > 0 ? 1 : 0);
