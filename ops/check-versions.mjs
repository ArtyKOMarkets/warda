/**
 * covenant/versions.json, re-derived rather than believed.
 *
 * The file maps a template fingerprint to a version name so the console and
 * the site can label a grant from the manifest they already hold. A map like
 * that is worth nothing if it is only asserted — the same reason
 * ops/known-keys.json says how each key is derived and agents/tools/dashboard.ts
 * re-derives every entry before it publishes a label.
 *
 * Four checks:
 *
 *   1. every entry with a template file re-derives to its stated fingerprint
 *   2. GUARANTEES.md's version table and this file agree, so the prose and the
 *      data cannot drift apart
 *   3. `current` names a real entry, and it is the fingerprint the live
 *      template produces
 *   4. every "covenant" fingerprint in a manifest in this repo has an entry
 *
 * An entry with no template file (v2, overwritten before archiving became the
 * habit) is REPORTED rather than passed quietly. It is an honest gap and the
 * output should say so every time, because a gap nobody is reminded of is a
 * gap that becomes a claim.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(REPO, p), "utf8"));

/** sdk/src/template.ts's templateFingerprint, in one line and no import. */
const fingerprint = (tpl) =>
  Buffer.from(blake2b.create({ dkLen: 32 }).update(new TextEncoder().encode(tpl.baselineHex)).digest()).toString("hex").slice(0, 16);

const map = read("covenant/versions.json");
const problems = [];
const notes = [];

// ---- 1. re-derive ---------------------------------------------------------
for (const v of map.versions) {
  if (!v.template) { notes.push(`${v.version} has no archived template — its fingerprint is from GUARANTEES.md and cannot be re-derived here`); continue; }
  let tpl;
  try { tpl = read(v.template); } catch { problems.push(`${v.version}: no template at ${v.template}`); continue; }
  const got = fingerprint(tpl);
  if (got !== v.fingerprint) problems.push(`${v.version}: ${v.template} fingerprints ${got}, the entry claims ${v.fingerprint}`);
  const baked = tpl.baked ?? {};
  for (const k of ["maxProofDepth", "maxFee"]) {
    if (v.baked?.[k] !== baked[k]) problems.push(`${v.version}: baked.${k} is ${baked[k]} in the template, ${v.baked?.[k]} in the entry`);
  }
}

// ---- 2. the prose ---------------------------------------------------------
const table = [...readFileSync(join(REPO, "GUARANTEES.md"), "utf8")
  .matchAll(/^\|\s*(v\d+)\s*\|\s*`([0-9a-f]{16})`\s*\|/gm)].map((m) => [m[1], m[2]]);
if (!table.length) problems.push("GUARANTEES.md: no version table found — the check that keeps the prose honest has nothing to read");
for (const [version, fp] of table) {
  const entry = map.versions.find((v) => v.version === version);
  if (!entry) problems.push(`GUARANTEES.md names ${version} and versions.json does not`);
  else if (entry.fingerprint !== fp) problems.push(`${version}: GUARANTEES.md says ${fp}, versions.json says ${entry.fingerprint}`);
}
for (const v of map.versions) {
  if (!table.some(([n]) => n === v.version)) problems.push(`versions.json names ${v.version} and GUARANTEES.md's table does not`);
}

// ---- 3. current -----------------------------------------------------------
const cur = map.versions.find((v) => v.fingerprint === map.current);
if (!cur) problems.push(`current is ${map.current}, which is not an entry`);
else {
  const live = fingerprint(read("sdk/covenant-template.json"));
  if (live !== map.current) problems.push(`sdk/covenant-template.json fingerprints ${live}; versions.json calls ${map.current} current. A new template was built and not recorded.`);
  if (cur.status !== "current") problems.push(`${cur.version} is named current and its status says "${cur.status}"`);
}

// ---- 4. every manifest in the repo ---------------------------------------
const known = new Set(map.versions.map((v) => v.fingerprint));
const seen = new Map();
const SKIP = new Set(["node_modules", ".git", "_to_delete", "dist", "target", "build"]);
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p); continue; }
    if (!name.endsWith(".json")) continue;
    let text; try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/"covenant"\s*:\s*"([0-9a-f]{16})"/g)) {
      seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
      if (!known.has(m[1])) problems.push(`${p.slice(REPO.length + 1)}: covenant ${m[1]} has no entry in versions.json`);
    }
  }
})(REPO);

// ---- say it ---------------------------------------------------------------
if (problems.length) {
  console.error("covenant versions: NOT consistent.\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nA label derived from this file would be a label somebody typed.");
  process.exit(1);
}
const counts = [...seen.entries()].sort((a, b) => b[1] - a[1])
  .map(([fp, n]) => `${map.versions.find((v) => v.fingerprint === fp).version} ${n}`).join(", ");
console.log(`covenant versions: ${map.versions.length} recorded, every archived template re-derives, GUARANTEES.md agrees.`);
console.log(`  grants in this repo: ${counts}`);
for (const n of notes) console.log(`  note: ${n}`);
