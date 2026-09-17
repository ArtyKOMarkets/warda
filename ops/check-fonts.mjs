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
 * the sources: exactly one stylesheet link, and every family the CSS names is
 * in it.
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
  if (links.length !== 1) {
    problems.push(
      `${f}: ${links.length} Google Fonts link(s), expected exactly one.` +
        (links.length === 0
          ? "\n    The page's own CSS names faces it never loads, so it renders in a fallback\n" +
            "    and a weight with no real face behind it is synthesised by the browser."
          : ""),
    );
    continue;
  }

  const want = new Set();
  for (const m of html.matchAll(DECLARED)) {
    /* The first quoted name in the stack is the one being asked for; the rest
       are the fallbacks, which by definition need no link. */
    const first = /"([^"]+)"/.exec(m[1]);
    if (first) want.add(first[1]);
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
