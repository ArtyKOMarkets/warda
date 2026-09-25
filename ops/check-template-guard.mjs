#!/usr/bin/env node
// A tool holding a manifest and a template must compare them.
//
//     node ops/check-template-guard.mjs
//
// ## Why this exists
//
// `sdk/covenant-template.json` is the PACKAGED template: whatever covenant is
// current. Nearly every tool loads it by default and takes `--template` to
// override. That was harmless while the file had held the same bytes since
// September — the default was always right, so a tool that never checked was
// never wrong.
//
// Freezing a covenant changes what that file means. From that moment a v4
// manifest and the packaged template are a mismatched pair, and the failure is
// not an error: `scriptHashFor` derives a perfectly well-formed address from
// the wrong bytecode. Nothing is at it. `follow-grant` reports a grant that was
// never funded; `topup` sends the remaining balance there.
//
// Five tools already made this comparison, each with its own wording. Three did
// not — follow-grant, topup and mcp-descriptor — and nothing would have said so
// until somebody read an empty balance for a grant holding money.
//
// So it is a property now: a tool that reads a manifest AND loads a covenant
// template must refuse the pair when they disagree. Either by calling
// `assertTemplateForManifest` or by comparing `templateFingerprint` itself —
// the old inline guards are not churned for the sake of uniformity.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(REPO, "sdk", "tools");

const loadsTemplate = (s) =>
  /covenant-template(-v\d+)?\.json/.test(s);

// A manifest, not just any JSON: the binding is named for one and its fields
// are read off it. Deliberately narrow — a checker that flags every JSON read
// is a checker somebody turns off.
const readsManifest = (s) =>
  /\b(?:const|let)\s+(?:m|pm|cm|manifest)\s*(?::[^=]*)?=\s*JSON\.parse\(/.test(s);

const guarded = (s) =>
  s.includes("assertTemplateForManifest") ||
  (s.includes("templateFingerprint") && /\.covenant\b/.test(s));

const problems = [];
const checked = [];
for (const f of readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort()) {
  const s = readFileSync(join(DIR, f), "utf8");
  if (!loadsTemplate(s) || !readsManifest(s)) continue;
  checked.push(f);
  if (!guarded(s)) {
    problems.push(
      `sdk/tools/${f} reads a manifest and loads a covenant template without comparing\n` +
        `  them. After a covenant freeze that pair derives a valid address for the wrong\n` +
        `  bytecode — the grant looks empty rather than the tool looking broken.\n` +
        `  Call assertTemplateForManifest(template, manifest, path).`,
    );
  }
}

if (!checked.length) {
  console.error(
    "check-template-guard: matched no tools at all. The detection above has stopped\n" +
      "  recognising how these files are written, so it is asserting nothing — which is\n" +
      "  worse than failing. Fix the patterns rather than deleting the check.",
  );
  process.exit(1);
}

if (problems.length) {
  console.error(`check-template-guard: ${problems.length} unguarded tool(s)\n`);
  for (const p of problems) console.error("- " + p + "\n");
  process.exit(1);
}
console.log(`check-template-guard: ${checked.length} tools hold a manifest and a template; every one compares them`);
