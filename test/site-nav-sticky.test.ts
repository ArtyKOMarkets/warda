/**
 * The navigation bar stays put when you scroll. Pinned, because it did not.
 *
 * ## Two causes, one symptom, eighteen months apart in diagnosis
 *
 * `position: sticky` sticks to the nearest SCROLLING ancestor. Five pages
 * carried `body { overflow-x: hidden }` to stop sideways drag on phones, and
 * `overflow-x: hidden` makes an element a scroll container — so on every one
 * of them the bar was stuck to a box that scrolls with the page, which is
 * indistinguishable from sticky not working.
 *
 * It had been diagnosed once before, as a specificity problem: the landing
 * page's `body > *:not(.field) { position: relative }` outscores a bare
 * `.topnav`. That was real, the fix was right, and it changed nothing visible,
 * because the second cause was still standing. A fix that produces no
 * improvement is evidence you have found A cause and not THE cause — and the
 * honest response is to keep looking rather than to call it done.
 *
 * The clipping now lives once, in `_nav.css`, as `clip` rather than `hidden`:
 * it clips identically and does not create a scroll container. It is declared
 * beside the bar because it is not a page's styling preference, it is what the
 * bar requires in order to work — and a page that quietly sets its own
 * `overflow-x: hidden` on body breaks the navigation for its readers with no
 * error anywhere, which is precisely how this lasted.
 *
 * So the assertion is not "the nav is sticky". It is that no page reintroduces
 * the thing that silently unsticks it.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const src = fileURLToPath(new URL("../site/src/", import.meta.url));
const read = (f: string) => readFileSync(src + f, "utf8");

/* The source pages, not the build: `site/web/` is generated and a checkout
   with no Python must still run this.
   
   Excluded: partials (no <body> of their own); the generated agent-00N pages,
   written from agent.html on every build so they cannot drift independently;
   and anything build.py does not treat as a page at all. `usage.html` is the
   third kind — written in September and deliberately kept dark until a
   stranger's payment lands, so it is a fragment with no nav and that is
   correct. A test that demanded a nav bar on it would be demanding the file
   be published. */
const generated = /^agent-00\d\.html$/;
const unpublished = new Set(["usage.html"]);
const pages = readdirSync(src).filter(
  (f) =>
    f.endsWith(".html") &&
    !f.startsWith("_") &&
    !f.includes(".intro.") &&
    !generated.test(f) &&
    !unpublished.has(f),
);

test("the bar is declared sticky, at a specificity that wins", () => {
  const css = read("_nav.css");
  assert.match(
    css,
    /body\s*>\s*\.topnav\s*\{[^}]*position:\s*sticky/,
    "the landing page's `body > *:not(.field) { position: relative }` outscores a bare " +
      "`.topnav`, so the selector has to be `body > .topnav`",
  );
  assert.match(css, /html,\s*body\s*\{\s*overflow-x:\s*clip/, "the sticky precondition is gone");
});

test("no page makes body a scroll container and unsticks the bar", () => {
  /* Comments are stripped first: `_nav.css` explains the hazard in prose, and
     a test that cannot tell an explanation from a declaration would either
     fail on the explanation or pass by ignoring everything. */
  const offenders: string[] = [];
  for (const page of pages) {
    const live = read(page)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    if (/overflow-x:\s*hidden/.test(live)) offenders.push(page);
  }
  assert.deepEqual(
    offenders,
    [],
    "these set `overflow-x: hidden`, which makes the element a scroll container and " +
      "sticks the nav to something that scrolls away. Use `clip` — it clips the same and " +
      "creates no scroll container. It is already declared once in _nav.css.",
  );
});

test("every navigable page actually gets the bar and its CSS", () => {
  /* A page that forgets the placeholder renders with no navigation at all,
     which is the failure this whole file is about, in its loudest form. */
  const missing = pages.filter((p) => {
    const t = read(p);
    return !t.includes("{{NAV}}") || !t.includes("{{NAV_CSS}}");
  });
  assert.deepEqual(missing, [], "these pages are missing {{NAV}} or {{NAV_CSS}}");
});
