#!/usr/bin/env node
/**
 * Do the Listener's numbers still agree with each other?
 *
 * ## The failure this catches
 *
 * They live in four places that cannot import one another: `src/shape.ts`,
 * the table in `growth/RUNBOOK-listener.md`, the flag defaults in two tools,
 * and — once it exists — a grant on chain whose terms cannot be edited at all.
 *
 * None of the ways they drift produce an error. The buyer asks for 25 results
 * and the seller caps at 10, so every purchase pays for a search twice the
 * size of the one it gets. Or the software budget in `rotate.ts` outruns the
 * epoch limit, and the covenant refuses a pass that the runner thought it
 * could afford — at eight in the morning, in a cron log, saying only that the
 * spend was rejected.
 *
 * The tools now read their defaults from `shape.ts`, so those two cannot
 * drift. This checks the two that still can: the prose table, and a grant.
 *
 * ## Why the runbook is checked rather than generated
 *
 * Because the table is an explanation, not a data structure — it carries the
 * reasoning next to each figure, and generating it would flatten that into a
 * list of numbers nobody reads. So it stays written by hand, and this refuses
 * to let it be wrong.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { LISTENER, derived, kas } = await import(join(root, "growth/src/shape.ts"));

const fail = (m) => { console.error(`listener: ${m}`); process.exit(1); };
const problems = [];

/* ---- the runbook's table -------------------------------------------- */
const bookPath = join(root, "growth/RUNBOOK-listener.md");
if (!existsSync(bookPath)) fail("growth/RUNBOOK-listener.md is missing");
const book = readFileSync(bookPath, "utf8");

/* Each figure with the units the table writes it in. A missing line is as
   much a failure as a wrong one: a table that stopped mentioning the epoch
   limit is a table somebody will read as "there isn't one". */
const expect = [
  ["budget", `${kas(LISTENER.budgetSompi)} KAS`],
  ["maxPerSpend", `${kas(LISTENER.priceSompi)} KAS`],
  ["epochLimit", `${kas(LISTENER.epochLimitSompi)} KAS`],
  ["epochLength", `${derived.epochLengthDaa.toLocaleString("en-US")} DAA`],
  ["term", `${derived.termDaa.toLocaleString("en-US")} DAA`],
];
for (const [field, text] of expect) {
  const line = book.split("\n").find((l) => l.trim().startsWith(field));
  if (!line) problems.push(`the runbook's table has no \`${field}\` row`);
  else if (!line.includes(text)) problems.push(`runbook says \`${line.trim()}\`; shape.ts says ${field} is ${text}`);
}
for (const [what, n] of [["searches over the term", derived.searchesPerTerm], ["searches per epoch", derived.searchesPerEpoch]]) {
  if (!book.includes(String(n))) problems.push(`the runbook never mentions ${n} ${what}`);
}

/* ---- a grant, if one has been made ---------------------------------- */
/*
 * The field names are the manifest's own, which are snake_case. The first
 * version of this guessed camelCase and `budget` matched by luck — so it
 * reported three missing fields while appearing to check four, and a guard
 * that half-matches is worse than one that fails, because the half that
 * passed looked verified.
 */
const grantPath = join(root, "growth/listener-grant.json");
if (existsSync(grantPath)) {
  let g;
  try { g = JSON.parse(readFileSync(grantPath, "utf8")); } catch { fail("growth/listener-grant.json is not JSON"); }
  const num = (k) => (g[k] === undefined ? NaN : Number(g[k]));

  const check = [
    ["budget", num("budget"), LISTENER.budgetSompi],
    ["max_per_spend", num("max_per_spend"), LISTENER.priceSompi],
    ["epoch_limit", num("epoch_limit"), LISTENER.epochLimitSompi],
    ["epoch_length", num("epoch_length"), derived.epochLengthDaa],
    /* Never checked before, and it is the one term that is about authority
       rather than money: this agent hires nobody, and a grant that can
       delegate when it never will is authority handed out for no reason. */
    ["delegation_depth", num("delegation_depth"), 0],
    /* The term, as the covenant actually expresses it — two absolute DAA
       scores rather than a length. A window that is not 7 days means the
       budget is spread over the wrong number of epochs. */
    ["the term (expires_at - not_before)", num("expires_at") - num("not_before"), derived.termDaa],
  ];
  for (const [field, have, want] of check) {
    if (Number.isNaN(have)) problems.push(`the grant has no ${field}`);
    /* A grant's terms are fixed at genesis. If these disagree the grant is
       the truth and shape.ts is the lie, so the message says which to move. */
    else if (have !== want) problems.push(`grant ${field} is ${have}, shape.ts says ${want} — the grant cannot be edited, so change shape.ts`);
  }
}

/* A pass that could not buy must not look like a pass with nothing to report.
 *
 * This is here rather than in a unit test because what it guards is a PROPERTY
 * of the unattended pass: six of them failed every purchase over twenty-one
 * hours, exited 0, sent nothing, and logged a quiet day, while the covenant
 * template had moved and every buy was answering "no UTXO". The only reason it
 * was noticed at all was an unrelated email about a different service.
 *
 * Two things have to hold, and they are separable — a tool that alerted without
 * exiting non-zero would leave cron's watchdog blind, and one that exited
 * without alerting would leave the phone blind:
 *
 *   * the pass says so, to the place a person actually reads;
 *   * and it exits non-zero, so ops/listener-pass.sh's own alert fires too.
 *
 * And the distinction from a REFUSAL is the point. A covenant refusal is the
 * system working; it already exits 3. A pass that could not buy exits 5 — not 4,
 * which buy.ts defines as "paid, unserved" and ops/monitor.sh alerts on every
 * single time because each occurrence is another payment.
 */
{
  const pass = readFileSync(join(root, "growth/tools/listen.ts"), "utf8");
  if (!/brokeCount\s*===\s*attempted/.test(pass)) {
    problems.push(
      "growth/tools/listen.ts no longer distinguishes a pass where EVERY buy failed.\n" +
        "    Without it a broken agent reports a quiet day: the buy returns status 0 and the\n" +
        "    ranker reads that as a search that found nothing. That is how the fleet stayed\n" +
        "    down for twenty-one hours.",
    );
  } else {
    if (!/every purchase in this pass FAILED/i.test(pass)) {
      problems.push("growth/tools/listen.ts detects an all-failed pass but no longer says so to Telegram.");
    }
    if (!/process\.exit\(5\)/.test(pass)) {
      problems.push(
        "growth/tools/listen.ts detects an all-failed pass but no longer exits non-zero,\n" +
          "    so ops/listener-pass.sh's watchdog stays quiet about it.",
      );
    }
  }
}

if (problems.length) {
  console.error(`\nlistener: ${problems.length} disagreement(s).\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log(
  `listener: ${kas(LISTENER.budgetSompi)} KAS over ${LISTENER.termDays} days, ` +
  `${derived.searchesPerEpoch} searches per ${LISTENER.epochHours}h epoch, ` +
  `${derived.searchesPerTerm} a term for $${derived.usdPerTerm}` +
  `${existsSync(grantPath) ? " — and the grant agrees" : " — no grant yet"}.`,
);
