#!/usr/bin/env node
// Does every reference vector say which covenant produced it?
//
//     node ops/check-goldens.mjs
//
// ## Why this exists
//
// The golden vectors are the strongest evidence in this repository: a
// transaction the Rust compiler built, which the JS SDK must reproduce byte
// for byte. They are pinned to one covenant — that is what makes them
// evidence — and for a year nothing recorded WHICH, because there was only one
// that mattered and `covenant-template.json` always was it.
//
// Freezing v5 ended that. A test loading the current template against a v4
// vector fails on a byte diff: a true failure, reported as the wrong thing,
// and the obvious repair is to regenerate the vectors — which throws away the
// evidence that this SDK ever matched the compiler for v4, while eighteen v4
// grants are still live and spendable only through it.
//
// So each vector carries a `covenant` fingerprint and `sdk/test/_golden.ts`
// loads that template. The fingerprint has to STAY there: `covenant/deploy`
// writes these files, and a regeneration that dropped the field would put
// every one of those tests back on whichever covenant happened to be current,
// silently, since a vector regenerated under the current covenant passes
// either way. The failure would arrive months later, on the first vector that
// was not regenerated.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

/* The current vectors, and every archive beside them. `golden-spend.json` is
   regenerated whenever the covenant moves, so the archives are the only place
   the evidence for a superseded covenant survives — and eighteen v4 grants are
   spendable only through v4's template. An archive that goes missing is not a
   stale file, it is a claim nobody can check any more. */
const VECTORS = readdirSync(join(REPO, "sdk"))
  .filter((f) => /^golden-[a-z]+(-v\d+)?\.json$/.test(f))
  .sort()
  .map((f) => `sdk/${f}`);
const known = new Map(read("covenant/versions.json").versions.map((v) => [v.fingerprint, v.version]));

const problems = [];
const seen = [];
for (const v of VECTORS) {
  let vector;
  try {
    vector = read(v);
  } catch {
    problems.push(`${v}: missing or unreadable, and the cross-implementation tests read it.`);
    continue;
  }
  const fp = vector.covenant;
  if (!fp) {
    problems.push(
      `${v} does not say which covenant produced it. Add "covenant": "<fingerprint>" — without\n` +
        `  it the tests fall back to whichever covenant is current, which is right until it is\n` +
        `  silently wrong. If covenant/deploy regenerated this file, it dropped the field.`,
    );
    continue;
  }
  if (!known.has(fp)) {
    problems.push(`${v}: covenant ${fp} has no entry in covenant/versions.json, so no template can be loaded for it.`);
    continue;
  }
  seen.push(`${known.get(fp)} ${v.replace("sdk/", "")}`);
}

if (problems.length) {
  console.error(`check-goldens: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error("- " + p + "\n");
  process.exit(1);
}
console.log(`check-goldens: every reference vector names its covenant — ${seen.join(", ")}`);
