#!/usr/bin/env node
/**
 * Three hazards the router's DESIGN.md names in prose, checked in code.
 *
 * Every guard in this repo exists because prose did not stop something. These
 * three are the ones that would be indistinguishable from a working system
 * until somebody checked, which is the worst kind and the reason to spend a
 * guard on them.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* Anchored on this file, not on the caller's cwd. A guard that passes only from
   the repo root fails in a subdirectory for a reason that has nothing to do with
   what it checks, which has already cost this repo an afternoon once with
   check-core-browser. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "router/src");
const failures = [];

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = sources(SRC);

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const at = `${file.slice(ROOT.length)}:${i + 1}`;
    const code = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");

    /* 1. A venue address baked into source. There is no published, verified
          Galleon deployment to copy, and an address typed from memory is an
          address that sends money somewhere nobody checked. Venues take their
          addresses from VenueConfig so the gap stays visible. */
    const addr = code.match(/0x[0-9a-fA-F]{40}\b/);
    if (addr) {
      failures.push(
        `${at}: a contract address literal (${addr[0]}) in router source.\n` +
          `  Addresses belong in VenueConfig, supplied by the caller. A constant here is a\n` +
          `  deployment nobody verified, and it will still be here after that venue redeploys.`,
      );
    }

    /* 2. A claim written as a literal instead of derived. verdict() computes
          what may be said about a route; anything that states the answer
          directly has stopped being checkable. */
    /* A type member is a declaration, not a claim: `authorisedToPayMe: "yes" |
       "unknown"` is the union this guard exists to protect, so skip the lines
       that declare it and look only at lines that assign. */
    const declares = /^\s*readonly\b/.test(code) || /\|\s*["'][a-z]/.test(code);
    if (!declares && (/\bauthorisedToPayMe\s*:\s*["']yes["']/.test(code) || /\brecipientEnforced\s*:\s*true\b/.test(code))) {
      failures.push(
        `${at}: a recipient claim written as a literal.\n` +
          `  This must come out of verdict(), which derives it from the hops. A literal says\n` +
          `  the chain constrained the recipient without anything having checked that it did.`,
      );
    }

    /* 3. A dollar amount reaching a field that holds a covenant limit. The
          covenant compares sompi; a USD number in one of these is a limit that
          consensus cannot enforce and a claim the deck already disowns. */
    const capField = code.match(/\b(maxPerSpend|budgetTotal|epochLimit)\s*[:=]\s*([^,;)]+)/);
    if (capField && /\b(usd|price|dollar|fiat)\b/i.test(capField[2])) {
      failures.push(
        `${at}: ${capField[1]} assigned from something dollar-shaped (${capField[2].trim()}).\n` +
          `  A covenant limit is sompi. Dollars are a quote unit; converting is quote()'s job and\n` +
          `  the result is attested, never enforced.`,
      );
    }
  });
}

/* 4. The zone vocabulary must stay a closed set. A fourth word — "routed",
      "verified", "safe" — is how an admission becomes a reassurance. */
const quote = readFileSync(join(SRC, "quote.ts"), "utf8");
const zoneDecl = quote.match(/export type Zone =([^;]+);/);
if (!zoneDecl) {
  failures.push("router/src/quote.ts: the Zone union has moved or gone; this guard cannot check it.");
} else {
  const words = [...zoneDecl[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]).sort();
  const expected = ["assumed", "attested", "enforced"];
  if (words.join(",") !== expected.join(",")) {
    failures.push(
      `router/src/quote.ts: Zone is now ${words.join(", ")}.\n` +
        `  It is deliberately ${expected.join(", ")} and nothing else. A word that sounds like an\n` +
        `  answer is worse than the absence of one — see DESIGN.md.`,
    );
  }
}

if (failures.length) {
  console.error(`\nrouter: ${failures.length} problem(s).\n`);
  for (const f of failures) console.error(f + "\n");
  process.exit(1);
}
console.log(`router: ${files.length} source files, no baked addresses, no literal claims, zone vocabulary intact.`);
