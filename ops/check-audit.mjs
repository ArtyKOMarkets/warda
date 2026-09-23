/**
 * Is the published audit report older than the covenant it describes?
 *
 * ## The failure this catches
 *
 * The report is generated — `cargo run --bin audit` in covenant/harness —
 * then committed, then copied to the site by build.py as /audit. Three steps,
 * any of which somebody can skip, and the failure is silent in the worst way:
 * a page that says a covenant passed 118 cases, describing a covenant that has
 * since changed. Nothing about it looks wrong. It is the same shape as
 * check-dist.mjs's green-and-stale build, except the wrong answer is published
 * to strangers rather than run locally.
 *
 * ## Why this asks git rather than the filesystem
 *
 * The obvious check — is AUDIT.html's mtime newer than warda_grant.sil's —
 * is worthless in CI. A fresh checkout stamps every file with the checkout
 * time, so the comparison is a coin flip between two files written in the same
 * second. Since both the covenant and the report are committed artifacts, the
 * question is really about commits: was the covenant changed in a commit later
 * than the one that last regenerated the report? That survives a clone.
 *
 * Git cannot see an edit that has not been committed yet, so the working tree
 * is checked separately: a dirty warda_grant.sil means the report describes a
 * file that no longer exists on disk, whatever the commits say.
 *
 * Outside a git checkout — a tarball, a vendored copy — it falls back to
 * mtimes, which are meaningful there, and says which rule it applied.
 */
import { statSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const covenant = join(root, "covenant", "warda_grant.sil");
const html = join(root, "covenant", "AUDIT.html");
const md = join(root, "covenant", "AUDIT.md");
const json = join(root, "covenant", "audit.json");
const rel = (f) => relative(root, f);

const fail = (m) => { console.error(`audit: ${m}`); process.exit(1); };
const regen = "cd covenant/harness && cargo run --bin audit";

for (const f of [html, md, json]) {
  if (!existsSync(f)) {
    fail(`${rel(f)} is missing — the three artifacts are written by one run.\n` +
         `       Run: ${regen}`);
  }
}

const git = (...args) => {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

/* A commit time of 0 means the file exists on disk but git has never recorded
   it — untracked, or added but not committed. Treat that as "no history" and
   let the caller decide, rather than reading it as the epoch. */
const committed = (f) => {
  const t = git("log", "-1", "--format=%ct", "--", rel(f));
  return t ? Number(t) : null;
};

const inGit = git("rev-parse", "--is-inside-work-tree") === "true";
let how;

if (inGit) {
  const dirty = git("status", "--porcelain", "--", rel(covenant));
  if (dirty) {
    fail(`${rel(covenant)} has uncommitted changes, so no committed report describes it.\n` +
         `       Run: ${regen}`);
  }

  const src = committed(covenant);
  const report = committed(html);
  if (src === null || report === null) {
    /* One of them has no commit yet — a first run, or an artifact staged but
       not committed. There is no order to compare, so the count check below
       is the whole guard, and saying so beats implying more. */
    how = "no commit history for one of the two files; only the counts were checked";
  } else {
    if (src > report) {
      const when = git("log", "-1", "--format=%cd", "--date=short", "--", rel(covenant));
      fail(`${rel(covenant)} was changed on ${when}, after the last commit that touched ` +
           `${rel(html)}.\n       The published report describes an older covenant. ` +
           `Run: ${regen}`);
    }
    how = "the report was regenerated no earlier than the last change to the covenant";
  }
} else {
  /* Not a checkout: mtimes are the only evidence, and here they mean something. */
  const src = statSync(covenant).mtimeMs;
  for (const f of [html, md, json]) {
    if (statSync(f).mtimeMs < src) {
      fail(`${rel(f)} is older than ${rel(covenant)}.\n       Run: ${regen}`);
    }
  }
  how = "not a git checkout, so file times were used";
}

/* The two artifacts of one run must agree on what that run was. They are
   written within milliseconds of each other, so a disagreement means one was
   carried over from an earlier one — and the page is the copy that ships. */
const cases = JSON.parse(readFileSync(json, "utf8")).cases;
const inHtml = readFileSync(html, "utf8").match(/<div class="v num">(\d+)<\/div>/);
if (!inHtml) fail(`could not find the case count in ${rel(html)} — has the report layout changed?`);
if (Number(inHtml[1]) !== cases) {
  fail(`${rel(html)} says ${inHtml[1]} cases, ${rel(json)} says ${cases} — one is from an older run.\n` +
       `       Run: ${regen}`);
}

console.log(`audit: ${cases} cases in both the page and the JSON; ${how}.`);
