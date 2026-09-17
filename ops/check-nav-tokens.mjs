#!/usr/bin/env node
/**
 * The site nav may not depend on a token the page might not define.
 *
 * `_nav.css` is injected into every page, and the pages do not share a
 * palette: the landing page declares eleven colour tokens, the simpler ones
 * declare seven. `.nv-go:hover` used `var(--teal-bright)`, which eleven pages
 * have never defined — and an invalid `var()` with no fallback does NOT fall
 * back to an earlier declaration. The property computes to its initial value,
 * so the one solid button in the bar went transparent on hover, on those pages
 * only. The focus rings had the same hole and nobody saw it at all.
 *
 * The rule: inside the nav, every custom property is either declared by the
 * nav itself (the `--nv-*` block, each with a literal fallback) or written
 * with a fallback at the point of use. A colour that exists on some pages is
 * not a colour this file may rely on.
 *
 * ## And the same failure by specificity, which the first fix did not touch
 *
 * Six pages carry `a:hover { color: var(--teal-bright) }` — a type selector
 * plus a pseudo-class, 0-1-1. `.nv-go` was a bare class, 0-1-0. So on those
 * pages the page won, the "Get started" label took the same colour as the
 * button under it, and the control rendered as a blank teal pill. The tokens
 * were all correct by then; the cascade was not.
 *
 * So the second rule: every selector in this file is scoped to `.topnav`. A
 * bar that appears on every page cannot be written at the specificity of a
 * page's own prose rules, and `!important` would have fixed one property and
 * left the next one to be found by eye.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = "site/src/_nav.css";
/* Comments out first, and this is not fussiness: the block explaining the bug
   quotes `var(--teal-bright)` as the thing that broke, and the first run of
   this check failed on its own documentation. check-router.mjs learned the
   same lesson on the same kind of prose. Newlines are preserved so the line
   numbers in a finding still point at the real line. */
const raw = readFileSync(ROOT + FILE, "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

/* Declared by the bar itself: `--nv-x: …` at the start of a declaration. */
const declared = new Set(Array.from(css.matchAll(/^\s*(--[\w-]+)\s*:/gm), (m) => m[1]));

const bare = [];
for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
  const [, name, next] = m;
  if (next === ",") continue;            // has a fallback at the point of use
  if (declared.has(name)) continue;      // the bar declares it
  const line = css.slice(0, m.index).split("\n").length;
  bare.push(`${FILE}:${line}: var(${name}) with no fallback, and the nav does not declare it.`);
}

/* Rule two: every selector is scoped to the bar. The two structural rules that
   are deliberately NOT — the overflow declaration on html/body, and .topnav
   itself — are named here so an exception stays a decision. */
const EXEMPT = new Set(["html, body", ".topnav", "body > .topnav"]);
const unscoped = [];
{
  const lines = css.split("\n");
  lines.forEach((line, i) => {
    const m = /^(\s*)([^{}/@\s][^{}]*?)\s*\{/.exec(line);
    if (!m) return;
    const sel = m[2].trim();
    if (EXEMPT.has(sel)) return;
    for (const part of sel.split(",").map((q) => q.trim())) {
      if (part.startsWith(".topnav") || part.startsWith("html") || part.startsWith("body")) continue;
      unscoped.push(`${FILE}:${i + 1}: \`${part}\` is not scoped to .topnav.`);
    }
  });
}

if (unscoped.length) {
  console.error(`\nnav specificity: ${unscoped.length} selector(s) a page can outrank.\n`);
  for (const u of unscoped) console.error(`  ${u}`);
  console.error(
    `\n  Prefix it with \`.topnav \`. Six pages carry \`a:hover { color: … }\` at 0-1-1, and a\n` +
      `  bare class in this file loses to it — which is how the Get started button became a\n` +
      `  blank teal pill on half the site.\n`,
  );
  process.exit(1);
}

if (bare.length) {
  console.error(`\nnav tokens: ${bare.length} depend on the page.\n`);
  for (const b of bare) console.error(`  ${b}`);
  console.error(
    `\n  Add it to the .topnav block as --nv-<name>: var(--<name>, <literal>), and use that.\n` +
      `  A page that defines the token still wins; the literal is what happens when nobody said.\n`,
  );
  process.exit(1);
}
console.log(
  `nav tokens: ${declared.size} declared by the bar itself, nothing depends on a page's palette, ` +
    `and every selector is scoped to .topnav.`,
);
