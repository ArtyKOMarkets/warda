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

if (problems.length === 0) {
  console.log(`links: ${pages.length} built pages, every internal link resolves.`);
  process.exit(0);
}

console.error("the built site links to something that is not there:\n");
for (const p of problems) console.error(`  ${p.page}  ->  ${p.href}   (${p.why})`);
console.error(
  "\nA page build.py DROPPED is the usual cause: it is skipped when its data is missing,\n" +
    "and whatever links to it is published anyway. Either generate the data the build\n" +
    "asked for, or stop linking it until there is a page to link to.",
);
process.exit(1);
