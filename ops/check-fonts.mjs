#!/usr/bin/env node
/**
 * Every page loads the typefaces every page claims to be set in.
 *
 * Six published pages — console, network, proof, rail, sandbox and verify —
 * declared `--body: "Barlow"`, `--display: "Chakra Petch"` and
 * `--mono: "JetBrains Mono"` in `:root` and never loaded a single one of them.
 * They had been rendering in Helvetica since the day each was written, and
 * nothing said so: a font stack ending in `sans-serif` cannot fail, it can only
 * silently be something else.
 *
 * It surfaced through the nav, which is the one component on all of them. The
 * "Get started" button is 600 weight; with no real 600 face behind it the
 * browser SYNTHESISES one, and a faux bold looks different from a designed
 * one. The report was "that button changes font on network and funding", which
 * is exactly what it did and exactly which pages lacked the link.
 *
 * The link is injected by build.py now, so this checks the output rather than
 * the sources: every family the CSS names is loaded, by exactly one link.
 *
 * ## A page that names no family needs no link
 *
 * The rule used to be "exactly one link, always", which is a blunt proxy for
 * the sentence at the top and overshoots it. /audit is a generated document
 * copied in whole — it sets itself in system stacks on purpose, so that it
 * renders the same offline, prints without fetching anything, and looks the
 * same when the auditor produces it for somebody else's covenant on somebody
 * else's machine. It claims no typeface, so there is nothing for it to be
 * silently missing, and the guard demanding a link it does not use was the
 * guard asking for the thing it exists to prevent: a stylesheet named but not
 * needed rather than needed but not named.
 *
 * The six pages this was written for still fail: they DO name Barlow, Chakra
 * Petch and JetBrains Mono in their tokens, and that is what is checked.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "site/web");

if (!existsSync(WEB)) {
  console.error("fonts: nothing built. Run `python3 site/build.py` first.");
  process.exit(1);
}

/* The families a page says it is set in, read out of its own tokens rather
   than listed here — a second list of font names is a second thing to keep
   true, which is the failure this whole check exists for. */
const DECLARED = /--(?:display|body|mono)\s*:\s*([^;]+);/g;

const problems = [];
let pages = 0;
for (const f of readdirSync(WEB)) {
  if (!f.endsWith(".html")) continue;
  const html = readFileSync(join(WEB, f), "utf8");
  pages++;

  const links = html.match(/<link[^>]+fonts\.googleapis\.com[^>]*>/g) ?? [];

  const want = new Set();
  for (const m of html.matchAll(DECLARED)) {
    /* The first quoted name in the stack is the one being asked for; the rest
       are the fallbacks, which by definition need no link. */
    const first = /"([^"]+)"/.exec(m[1]);
    if (first) want.add(first[1]);
  }

  /* Two links is a problem whatever the page claims — they race, and the
     second usually means a copied <head>. Zero is a problem only for a page
     that names something. */
  if (links.length > 1) {
    problems.push(`${f}: ${links.length} Google Fonts links, expected one.`);
    continue;
  }
  if (links.length === 0) {
    if (want.size > 0) {
      problems.push(
        `${f}: names ${[...want].map((w) => `"${w}"`).join(", ")} in its tokens and loads no stylesheet.` +
          "\n    It renders in a fallback, and a weight with no real face behind it is" +
          "\n    synthesised by the browser.",
      );
    }
    continue;
  }
  for (const family of want) {
    if (!links[0].includes(family.replace(/ /g, "+"))) {
      problems.push(`${f}: names "${family}" in its tokens; the stylesheet link does not load it.`);
    }
  }
}

if (problems.length) {
  console.error(`\nfonts: ${problems.length} problem(s).\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log(`fonts: ${pages} built pages, each loading exactly the faces its own tokens name.`);
