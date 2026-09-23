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
const grantPath = join(root, "growth/listener-grant.json");
if (existsSync(grantPath)) {
  let g;
  try { g = JSON.parse(readFileSync(grantPath, "utf8")); } catch { fail("growth/listener-grant.json is not JSON"); }
  const got = (k) => Number(g[k] ?? g.terms?.[k] ?? NaN);
  const check = [
    ["budget", got("budget"), LISTENER.budgetSompi],
    ["maxPerSpend", got("maxPerSpend"), LISTENER.priceSompi],
    ["epochLimit", got("epochLimit"), LISTENER.epochLimitSompi],
    ["epochLength", got("epochLength"), derived.epochLengthDaa],
  ];
  for (const [field, have, want] of check) {
    if (Number.isNaN(have)) problems.push(`the grant has no ${field}`);
    /* A grant's terms are fixed at genesis. If these disagree the grant is
       the truth and shape.ts is the lie, so the message says which to move. */
    else if (have !== want) problems.push(`grant ${field} is ${have}, shape.ts says ${want} — the grant cannot be edited, so change shape.ts`);
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
