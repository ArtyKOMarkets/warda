/**
 * The published readings for the growth fleet, from the latest finished week.
 *
 *   node --experimental-strip-types growth/tools/reading.ts orchestrator > site/src/agent-009.json
 *   node --experimental-strip-types growth/tools/reading.ts scout        > site/src/agent-010.json
 *
 * The growth tree gets a new batch grant every week, so its readings cannot be
 * one fixed command in site/build.py the way #001–#006 are. This reads
 * growth/current.json — written by tools/week.ts when a week finishes — and
 * runs the same agents/tools/dashboard.ts every other agent's page comes from,
 * with the flags that week's ending needs: the batch grant was REVOKED by the
 * principal; Scout was SETTLED into its parent. Two different endings, named
 * as such, because the difference is what the pages demonstrate.
 *
 * No finished week: exit 1 and print nothing, so the refresh keeps whatever
 * reading was there and the build does not publish a page without data.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GROWTH = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(GROWTH, "..");
const which = process.argv[2];
const CURRENT = join(GROWTH, "current.json");
const RESEARCHER = (process.env.GROWTH_RESEARCHER_URL ?? "https://warda-growth.vercel.app").replace(/\/$/, "");

if (which !== "orchestrator" && which !== "scout") {
  console.error("reading.ts orchestrator | scout");
  process.exit(2);
}
if (!existsSync(CURRENT)) {
  console.error("no finished growth week yet (growth/current.json) — nothing to publish.");
  process.exit(1);
}
const c = JSON.parse(readFileSync(CURRENT, "utf8")) as {
  label: string; grant: string; child: string | null; purchases: string; payees: string; scoutPayees: string;
  settle: string | null; revoke: string | null;
};
/* Paths are stored absolute on the machine that ran the week; resolve them
   against this checkout so a reading made elsewhere reads the same files. */
const here = (p: string) => (existsSync(p) ? p : join(REPO, p.slice(p.indexOf("growth/"))));

let args: string[];
if (which === "orchestrator") {
  /* The orchestrator buys nothing itself; its log is an empty directory,
     and the payments are on Scout's page — which --settled points to. */
  const none = join(GROWTH, "batches", c.label, "orchestrator-purchases");
  mkdirSync(none, { recursive: true });
  args = [here(c.grant), "--id", "WARDA-009", "--recipients", here(c.payees), "--purchases", none,
    "--endpoint", `${RESEARCHER}/verify`,
    "--mission", `Run the growth fleet for ${c.label}: hire Scout with a piece of this budget that may pay Researcher and nobody else, take back what it did not spend, and end.`];
  if (c.child) args.push("--settled", here(c.child));
  if (c.revoke) args.push("--ended", c.revoke);
} else {
  if (!c.child) {
    console.error(`${c.label} hired nobody (no candidates) — no Scout reading this week.`);
    process.exit(1);
  }
  args = [here(c.child), "--id", "WARDA-010", "--recipients", here(c.scoutPayees), "--purchases", here(c.purchases),
    "--parent", here(c.grant), "--parent-id", "WARDA-009",
    "--endpoint", `${RESEARCHER}/verify`,
    "--mission", "Find projects building agents that pay for things, buy one checkable record about each from Researcher, and come home."];
  if (c.settle) args.push("--settled-into", c.settle);
}

/* The dashboard's reading, plus one fact it cannot know: this grant is one
   week of a job that runs every week. The pages use it to say "this week is
   done" rather than presenting an ended grant as a retired agent. */
const child = spawn(process.execPath, ["--experimental-strip-types", join(REPO, "agents/tools/dashboard.ts"), ...args], {
  cwd: REPO, stdio: ["ignore", "pipe", "inherit"],
});
let out = "";
child.stdout.on("data", (d) => (out += String(d)));
child.on("close", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const reading = JSON.parse(out) as Record<string, unknown>;
  const r = (c as unknown as { report?: { bought?: number; spentSompi?: string } }).report ?? {};
  reading.weekly = {
    label: c.label,
    schedule: "every Monday, 10:13",
    role: which,
    ...(which === "orchestrator"
      ? { delegatedTo: { id: "010", payments: r.bought ?? 0, spent: `${Number(r.spentSompi ?? 0) / 1e8} KAS` } }
      : { parent: "009" }),
  };
  process.stdout.write(JSON.stringify(reading, null, 2) + "\n");
});
