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
  `nav tokens: ${declared.size} declared by the bar itself, and nothing in it depends on a page's palette.`,
);
