/**
 * Does every internal link on the built site reach a page that was built?
 *
 * ## The failure this catches
 *
 * `site/build.py` drops a page whose data is missing — the attack page without
 * a live grant, the console page without a build, an agent page without a
 * reading — because a page that renders `{{DEMO_ADDRESS}}` to a stranger is
 * worse than no page. That is the right call, and it creates a second hazard
 * the build never checked: everything that LINKS to the dropped page is still
 * published, so the site ships looking finished with a link that 404s.
 *
 * `agent_publishable`'s own docstring says this shape has bitten the site
 * twice. It nearly did a third time, from a link to /agent-005 typed into the
 * landing page's roadmap while that page was still waiting on its first
 * reading — so the guard is the lesson rather than the fix.
 *
 * ## What it checks, and what it cannot
 *
 * Internal hrefs only: `/x`, `/x.html`, `x.html`, and in-page `#anchor`s
 * against the ids in the same file. External links are somebody else's uptime,
 * `mailto:` is not a page, and a link built by script at runtime is invisible
 * here — stated rather than papered over.
 *
 * Run against `site/web`, the built output, because that is what is deployed
 * and the src pages are full of unsubstituted placeholders.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { Script } from "node:vm";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "site", "web");
if (!existsSync(web)) {
  console.error(`no build at site/web — run site/build.py first.`);
  process.exit(1);
}

const pages = readdirSync(web).filter((f) => f.endsWith(".html"));
const built = new Set(pages);
const problems = [];

/* Vercel serves /x from x.html, so both spellings are the same page. Anything
   that exists as a real file (assets, json, the extension zip) is fine too. */
const resolves = (href) => {
  const clean = href.split(/[?#]/)[0];
  if (clean === "" || clean === "/") return built.has("index.html");
  const rel = clean.replace(/^\//, "");
  if (built.has(rel) || built.has(`${rel}.html`)) return true;
  const onDisk = join(web, rel);
  return existsSync(onDisk) && statSync(onDisk).isFile();
};

for (const page of pages) {
  const html = readFileSync(join(web, page), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/\shref="([^"]+)"/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|tel:|data:)/i.test(href)) continue;
    if (href.startsWith("#")) {
      const id = href.slice(1);
      if (id && !ids.has(id)) problems.push({ page, href, why: "no element with that id" });
      continue;
    }
    if (!href.startsWith("/") && !href.endsWith(".html")) continue;  // relative asset paths
    if (!resolves(href)) problems.push({ page, href, why: "no such page was built" });
  }
}

/**
 * And that every inline script PARSES.
 *
 * These pages render themselves from JSON: the agent pages keep `b-body`
 * hidden until the script fills it in, and the landing page's sections are the
 * same shape. So a syntax error does not produce a broken page, it produces a
 * BLANK one — and the build, which only substitutes placeholders, would report
 * success either way.
 *
 * Here rather than in a test because it needs the BUILT page: the sources are
 * full of unsubstituted placeholders, and a `{{WALLET_JS}}` that lands in the
 * wrong place is exactly the kind of thing this catches.
 */
for (const page of pages) {
  const html = readFileSync(join(web, page), "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  scripts.forEach((m, i) => {
    try {
      new Script(m[1]);
    } catch (e) {
      problems.push({ page, href: `inline script #${i + 1}`, why: `will not parse: ${e.message}` });
    }
  });
}

if (problems.length === 0) {
  console.log(
    `links: ${pages.length} built pages, every internal link resolves and every inline script parses.`,
  );
  process.exit(0);
}

const broken = problems.filter((p) => p.href.startsWith("inline script"));
const dangling = problems.filter((p) => !p.href.startsWith("inline script"));

if (dangling.length > 0) {
  console.error("the built site links to something that is not there:\n");
  for (const p of dangling) console.error(`  ${p.page}  ->  ${p.href}   (${p.why})`);
  console.error(
    "\nA page build.py DROPPED is the usual cause: it is skipped when its data is missing,\n" +
      "and whatever links to it is published anyway. Either generate the data the build\n" +
      "asked for, or stop linking it until there is a page to link to.\n",
  );
}
if (broken.length > 0) {
  console.error("a built page carries a script that will not parse:\n");
  for (const p of broken) console.error(`  ${p.page}  ${p.href}   (${p.why})`);
  console.error(
    "\nThese pages render themselves and keep their body hidden until the script has run,\n" +
      "so this does not ship a broken page \u2014 it ships a BLANK one, and the build reports\n" +
      "success either way.",
  );
}
process.exit(1);
