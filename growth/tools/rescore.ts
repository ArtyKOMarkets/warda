/**
 * Re-score a saved run. No network, no token, no money.
 *
 *   node --experimental-strip-types tools/rescore.ts growth/listener/run.json
 *
 * The weights in `src/listen.ts` are an argument about specific posts, and an
 * argument needs the posts to stay still. Buying a fresh search every time one
 * moves costs money AND changes the evidence underneath the change being
 * judged — the new set is different, so you cannot tell whether the ranking
 * improved or the day did.
 *
 * So a trial saves what it read and this re-ranks it. The loop is: change a
 * weight, run this, read the order. Seconds, and free.
 */
import { readFileSync } from "node:fs";
import { fingerprint, score, type Post } from "../src/listen.ts";

const file = process.argv.find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!file) {
  console.error("rescore.ts <a file saved by `listen.ts --direct --save`>");
  process.exit(2);
}
const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

const doc = JSON.parse(readFileSync(file, "utf8")) as { at?: string; posts: Post[] };
const mute = new Set((flag("mute", "warda_protocol")!).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));

/* Ages are frozen to when the run happened. Re-scoring tomorrow must not turn
   every post into "48h old, the thread has moved on" — that would make the
   age rule swamp whatever is actually being tuned. */
const drift = doc.at ? Date.now() - new Date(doc.at).getTime() : 0;
const posts = doc.posts.map((p) => ({ ...p, at: new Date(new Date(p.at).getTime() + drift).toISOString() }));

/* The same fold a real pass does, so the list read here is the list that
   would have been produced. Without it a saved file shows the near-duplicates
   a pass would have merged, and the count at the bottom is wrong. */
const byText = new Map<string, Post>();
for (const post of posts) if (!byText.has(fingerprint(post))) byText.set(fingerprint(post), post);
const folded = [...byText.values()];

const scored = folded.map((p) => score(p, { mute })).sort((a, b) => b.score - a.score);
const floor = scored.filter((s) => s.band !== "skip").length;

for (const s of scored) {
  const mark = s.band === "high" ? "HIGH" : s.band === "worth a look" ? "look" : "  --";
  console.log(`${mark} ${String(s.score).padStart(3)}  @${s.post.author.handle}  ${s.post.text.replace(/\s+/g, " ").slice(0, 88)}`);
  console.log(`        ${s.why.join("  ")}`);
}
const dropped = posts.length - folded.length;
console.log(`\n${scored.length} posts${dropped ? ` (${dropped} near-duplicates folded)` : ""}, ${floor} above the floor, ${scored.filter((s) => s.band === "high").length} high.`);
