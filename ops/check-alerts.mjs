/**
 * A rule you can write that the tool silently ignores.
 *
 * `ops/alerts.ts` dispatches on `kind`, and the example file is where anybody
 * learns which kinds exist. Those two can drift in both directions and both
 * are bad in the same quiet way: a kind implemented but never documented is a
 * feature nobody uses, and a kind documented but never implemented is a rule
 * somebody writes, installs, and trusts to watch something it is not watching.
 * The second one is why this file exists. An alert that cannot fire looks
 * exactly like an alert with nothing to report.
 *
 * It also holds the line the whole tool rests on: the Telegram token is used
 * once, in the request URL, and never reaches a log. A cron job appends to a
 * file nobody thinks of as secret, forever.
 *
 * Run by .github/workflows/check.yml.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = (p) => fileURLToPath(new URL("../" + p, import.meta.url));
const src = readFileSync(repo("ops/alerts.ts"), "utf8");
const problems = [];

/* Comments quote the very strings being searched for — check-router.mjs and
   check-nav-tokens.mjs each learned this by failing on their own prose.
   Newlines are preserved so line numbers survive. */
const bare = src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/\/\/[^\n]*/g, "");

/* The closed vocabulary, read from the type rather than typed again here. */
const m = bare.match(/type Kind =([^;]+);/);
if (!m) {
  problems.push("ops/alerts.ts no longer declares `type Kind`. That declaration is the list.");
} else {
  const kinds = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
  if (kinds.length === 0) problems.push("`type Kind` declares no kinds.");

  for (const k of kinds) {
    /* `!==` counts: the last kind is naturally written as a refusal of
       everything else rather than as a match. What does not count is no
       mention at all, which is the fall-through this exists to catch. */
    if (!new RegExp(`kind (===|!==) "${k}"`).test(bare)) {
      problems.push(
        `kind "${k}" is declared but never compared against in evaluate().\n` +
          `    A rule of that kind would fall through to another branch and be\n` +
          `    evaluated as something else.`,
      );
    }
  }

  const example = JSON.parse(readFileSync(repo("ops/alerts.example.json"), "utf8"));
  const shown = new Set((example.rules ?? []).map((r) => r.kind));
  for (const k of kinds) {
    if (!shown.has(k)) {
      problems.push(
        `kind "${k}" is implemented but has no rule in ops/alerts.example.json.\n` +
          `    That file is the only place anybody finds out the kind exists.`,
      );
    }
  }
  for (const k of shown) {
    if (!kinds.includes(k)) {
      problems.push(
        `ops/alerts.example.json shows kind "${k}", which ops/alerts.ts does not\n` +
          `    implement. Somebody would copy it, install it, and be watched over by\n` +
          `    a rule that cannot fire.`,
      );
    }
  }

  /* Every rule in the example must have an id, and they must be distinct —
     ids are how state is remembered, so a duplicate silently disables one. */
  const ids = (example.rules ?? []).map((r) => r.id);
  if (ids.some((i) => !i)) problems.push("a rule in ops/alerts.example.json has no id.");
  if (new Set(ids).size !== ids.length) {
    problems.push("ops/alerts.example.json has two rules with the same id.");
  }
  /* The example must never carry a real token. It is copied verbatim. */
  if (/\d{8,}:[A-Za-z0-9_-]{30,}/.test(readFileSync(repo("ops/alerts.example.json"), "utf8"))) {
    problems.push("ops/alerts.example.json contains something shaped like a bot token.");
  }
}

/* The token is a password. It may be read, and it may be interpolated into the
   API URL. It may not be printed, written to a file, or put in a message —
   which is the same rule ops/check-key-writes.mjs holds for key material, for
   the same reason. */
const TOKEN = /\btoken\b/;
for (const [i, line] of bare.split("\n").entries()) {
  if (!TOKEN.test(line)) continue;
  if (/api\.telegram\.org/.test(line)) continue;
  if (/^\s*(const|let)\s+token\s*=/.test(line)) continue;
  if (/^\s*if\s*\(!token/.test(line) || /!token\s*\|\|/.test(line)) continue;
  if (/console\.|say\(|chat\(|writeFileSync|JSON\.stringify|outbox\.push/.test(line)) {
    problems.push(
      `ops/alerts.ts:${i + 1} puts \`token\` somewhere that is written or printed:\n` +
        `      ${line.trim()}\n` +
        `    A cron log is a file nobody thinks of as secret, and it is kept forever.`,
    );
  }
}

/* The promise the module header makes, held to mechanically: this tool reads
   and sends text. It does not sign, build or broadcast. */
for (const forbidden of ["WARDA_SK", "submitTransaction", "signTransaction", "buildGenesis", "readFileSync(keyFile"]) {
  if (bare.includes(forbidden)) {
    problems.push(
      `ops/alerts.ts mentions ${forbidden}. This tool notifies and never acts:\n` +
        `    it holds no key, signs nothing and builds no transaction. If that is\n` +
        `    changing, it is a different tool and it does not belong on a schedule.`,
    );
  }
}

if (problems.length) {
  console.error("check-alerts: " + problems.length + " problem(s)\n");
  for (const p of problems) console.error("  - " + p + "\n");
  process.exit(1);
}
console.error("check-alerts: ok");
