#!/usr/bin/env node
/**
 * Every published page is in the sitemap.
 *
 * site/src/sitemap.xml is hand-written, and hand-written lists of the other
 * files decay silently in one direction: a page is added, the list is not,
 * and nothing anywhere fails. /rail and /agent-006 had both been live and
 * unlisted, and neither was noticed by a link check — a sitemap is the one
 * index whose omissions cost nothing locally and cost discovery everywhere
 * else. It is also the file this project can least afford to be wrong: the
 * whole argument for /llms.txt and the MCP card is that an agent can find
 * this protocol without a person in the loop.
 *
 * So the rule is the same one the rest of this repo uses for second copies:
 * if it must agree with something, make disagreeing fail. The sitemap is
 * checked against what build.py actually wrote, not against a second list.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "site/web");
const MAP = join(WEB, "sitemap.xml");

if (!existsSync(WEB) || !existsSync(MAP)) {
  console.error("sitemap: nothing built. Run `python3 site/build.py` first.");
  process.exit(1);
}

/* Pages that exist and are deliberately not advertised. Each one needs a
   reason here, so "not in the sitemap" stays a decision rather than a
   forgotten line. */
const UNLISTED = new Map([
  ["agent-006.intro.html", "a fragment injected into agent-006, not a page"],
]);

const xml = readFileSync(MAP, "utf8");
const listed = new Set(
  Array.from(xml.matchAll(/<loc>https:\/\/wardaprotocol\.com(\/[^<]*)<\/loc>/g), (m) => m[1]),
);

const missing = [];
for (const f of readdirSync(WEB)) {
  if (!f.endsWith(".html")) continue;
  if (UNLISTED.has(f)) continue;
  const url = f === "index.html" ? "/" : "/" + f.replace(/\.html$/, "");
  if (!listed.has(url)) missing.push(`${url}  (site/web/${f})`);
}

/* And the other direction: a sitemap entry for a page that no longer exists
   sends a crawler to a 404, which is worse than not listing it. */
const built = new Set(
  readdirSync(WEB)
    .filter((f) => f.endsWith(".html"))
    .map((f) => (f === "index.html" ? "/" : "/" + f.replace(/\.html$/, ""))),
);
const dangling = [...listed].filter(
  (u) => !built.has(u) && !existsSync(join(WEB, u.replace(/^\//, ""))),
);

if (missing.length || dangling.length) {
  console.error("\nsitemap: out of step with what was built.\n");
  for (const m of missing) console.error(`  not listed:  ${m}`);
  for (const d of dangling) console.error(`  listed, but nothing is there:  ${d}`);
  console.error("\n  Edit site/src/sitemap.xml. A page nobody can find is a page that was not shipped.\n");
  process.exit(1);
}
console.log(`sitemap: ${built.size} built pages, ${listed.size} entries, none missing and none dangling.`);
