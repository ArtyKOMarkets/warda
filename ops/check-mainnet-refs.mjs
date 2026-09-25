/**
 * MAINNET.md cites the repo. This checks that the repo still says it.
 *
 * A list of blockers is only worth having if its pointers are live. The
 * failure mode is not that somebody lies — it is that a file gets edited,
 * every line below the edit shifts, and a citation quietly starts pointing at
 * a blank line. Nobody notices, because nobody clicks a line number in a
 * markdown file until they are already looking for something.
 *
 * So: every `path:line` in MAINNET.md must resolve, and every quotation
 * attached to one must still be findable near the line it names.
 *
 * NEAR, not AT. Requiring the exact line would fail on every unrelated edit
 * above it and would be turned off within a week. A window is the version
 * somebody keeps: the quote has to still exist, in that file, close to where
 * the citation says — and when it has moved, this prints the line it moved to,
 * so fixing the reference is a one-character edit rather than an investigation.
 *
 *     node ops/check-mainnet-refs.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = "MAINNET.md";
const WINDOW = 15;

const doc = readFileSync(join(root, DOC), "utf8").split("\n");

/** Typographic noise out, so a quote survives a curly apostrophe. */
const norm = (s) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/* A citation is `path:line`, in backticks or bare. The path has to look like a
   path — a bare `foo:12` in prose is not one, and neither is a URL. */
const CITE = /`?([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:md|ts|mjs|js|rs|json|html|sil|py|sh)):(\d+)`?/g;

/* Quotations, in the two shapes this file uses: a blockquote line, and an
   italicised "…" inline. Both are collected with the line they sit on, so a
   quote can be attached to the citation above it. */
function quotesOn(line) {
  const out = [];
  if (/^>\s?/.test(line)) {
    const q = line.replace(/^>\s?/, "").trim();
    if (q) out.push(q);
  }
  for (const m of line.matchAll(/\*"([^"]{12,})"\*/g)) out.push(m[1]);
  for (const m of line.matchAll(/—\s*\*"([^"]{12,})"\*/g)) out.push(m[1]);
  return out;
}

const problems = [];
const checked = [];

let pending = null; // the most recent citation, awaiting its quotes

for (let i = 0; i < doc.length; i++) {
  const line = doc[i];

  for (const m of line.matchAll(CITE)) {
    const [, path, lineNo] = m;
    const abs = join(root, path);
    if (!existsSync(abs)) {
      problems.push(`${DOC}:${i + 1}  ${path} does not exist`);
      pending = null;
      continue;
    }
    const target = readFileSync(abs, "utf8").split("\n");
    if (Number(lineNo) > target.length) {
      problems.push(
        `${DOC}:${i + 1}  ${path}:${lineNo} is past the end of the file (${target.length} lines)`,
      );
      pending = null;
      continue;
    }
    pending = { path, line: Number(lineNo), target, at: i + 1 };
    checked.push(`${path}:${lineNo}`);
  }

  /* A quotation belongs to a citation in its own PARAGRAPH. Without this a
     blank line does not break the association, and a quote several paragraphs
     later gets checked against a file it was never about — which is how the
     first run of this blamed runner/deploy/README.md for a line in
     site/proof.html. */
  if (!line.trim()) pending = null;
  if (!pending) continue;
  for (const raw of quotesOn(line)) {
    /* An elision joins two fragments that are each verbatim. Requiring the
       whole thing would make every […] a false failure. */
    const fragments = norm(raw)
      .split(/\[…\]|\[\.\.\.\]/)
      .map((f) => f.trim())
      .filter((f) => f.length >= 12);
    if (!fragments.length) continue;

    const lo = Math.max(0, pending.line - 1 - WINDOW);
    const hi = Math.min(pending.target.length, pending.line + WINDOW);
    const hay = norm(pending.target.slice(lo, hi).join(" "));
    const missing = fragments.filter((f) => !hay.includes(f));
    if (!missing.length) continue;

    /* Not near it. Is it anywhere? If so the citation drifted and we can say
       where to, which is the difference between a useful check and a chore. */
    const whole = norm(pending.target.join(" "));
    const elsewhere = fragments.every((f) => whole.includes(f));
    if (elsewhere) {
      const anchor = norm(fragments[0]);
      const found = pending.target.findIndex((_l, k) =>
        norm(pending.target.slice(k, k + 4).join(" ")).includes(anchor),
      );
      problems.push(
        `${DOC}:${pending.at}  ${pending.path}:${pending.line} no longer has this quote; ` +
          `it is at ${pending.path}:${found + 1} now.\n      "${missing[0].slice(0, 70)}…"`,
      );
    } else {
      problems.push(
        `${DOC}:${pending.at}  ${pending.path} no longer contains this quote anywhere:\n` +
          `      "${missing[0].slice(0, 70)}…"\n` +
          `      Either the source changed and MAINNET.md is now wrong about it, or the\n` +
          `      quote was paraphrased. A blocker list may not paraphrase its evidence.`,
      );
    }
  }
}

/* Bare file references — no line number — still have to exist. Most of them
   name a thing that must be DONE, and a blocker pointing at a deleted file is
   a blocker nobody can act on. */
const BARE = /`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:md|ts|mjs|js|rs|json|html|sil|py|sh))`/g;
const seen = new Set();
for (const line of doc) {
  for (const [, path] of line.matchAll(BARE)) {
    if (seen.has(path) || path === DOC) continue;
    seen.add(path);
    if (!existsSync(join(root, path))) problems.push(`${DOC}  ${path} is referenced and does not exist`);
  }
}

if (problems.length) {
  console.error(`\n${DOC}: ${problems.length} reference${problems.length > 1 ? "s" : ""} no longer hold.\n`);
  for (const p of problems) console.error("  " + p);
  console.error(
    `\nFix the reference, or fix the claim. A list of what stands between this and\n` +
      `real money is worth exactly as much as its citations are.\n`,
  );
  process.exit(1);
}
console.log(
  `MAINNET.md: ${checked.length} line citations resolve, ${seen.size} referenced files exist, ` +
    `every quotation still found within ${WINDOW} lines of where it is cited.`,
);
