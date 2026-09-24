/**
 * One line a day, so that silence means something.
 *
 * The Listener's whole design is that it only speaks when it has news:
 * `listener-pass.sh` exits 0 and says nothing when a pass finds nothing, on
 * the correct grounds that a twice-daily "nothing today" trains you to stop
 * reading it. The cost of that is real and was paid on 23 September: an
 * evening pass whose epoch had already been spent did nothing, said nothing,
 * and was indistinguishable from a dead cron for eighteen hours.
 *
 * So this reads the pass log rather than the feed. It reports what ran, not
 * what was found, and its alarming case is the absence of passes. Nothing
 * here touches the chain or the seller: a heartbeat that can fail for the
 * same reasons as the thing it watches is not a heartbeat.
 *
 *   node --experimental-strip-types growth/tools/heartbeat.ts [--hours 24] [--expect 2]
 *
 * Exits 1 when no pass has been recorded in EPOCH_HOURS + 2, which is the one
 * state that needs a person. Exits 0 otherwise, message on stdout.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LISTENER } from "../src/shape.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "listener");
const PASSES = join(DIR, "passes.jsonl");
const STATE = join(DIR, "state.json");

const flag = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const HOURS = Number(flag("hours", "24"));
const EXPECT = Number(flag("expect", "2"));

type Pass = {
  at: string; searches?: number; reads?: number; sent?: number;
  skipped?: number; spentSompi?: number; refused?: string | null; why?: string;
};

function passes(): Pass[] {
  if (!existsSync(PASSES)) return [];
  return readFileSync(PASSES, "utf8").split("\n").filter(Boolean)
    .flatMap((l) => { try { return [JSON.parse(l) as Pass]; } catch { return []; } });
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d`;
};
const kas = (sompi: number) => (sompi / 1e8).toFixed(2);
const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const now = Date.now();
/* Sorted rather than trusted to be in order: the file is append-only in
   practice, but "the last line is the latest pass" is the kind of assumption
   that survives every test and then breaks the one morning it matters. */
const all = passes().sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
const window = all.filter((p) => now - new Date(p.at).getTime() < HOURS * 3_600_000);
const last = all.length ? all[all.length - 1] : undefined;
const sum = (k: keyof Pass) => window.reduce((a, p) => a + (Number(p[k]) || 0), 0);

const pad = (label: string) => label.padEnd(16);
const lines: string[] = [`Listener · last ${HOURS}h`, ""];

if (!last) {
  /* No log at all is ambiguous on purpose: it is also what the first day
     after this shipped looks like, so it says which it cannot tell. */
  console.log(
    `Listener · no pass has ever been recorded.\n\n` +
      `growth/listener/passes.jsonl does not exist. Either no pass has run since ` +
      `pass logging was added, or the cron is not installed:\n\n  ops/install-cron.sh --listener`,
  );
  process.exit(1);
}

const sinceLast = now - new Date(last.at).getTime();
const stale = sinceLast > (LISTENER.epochHours + 2) * 3_600_000;

lines.push(`${pad("passes")}${window.length}${window.length < EXPECT ? ` of ${EXPECT} expected` : ""}`);
lines.push(`${pad("searches")}${sum("searches")} · ${kas(sum("spentSompi"))} KAS`);
lines.push(`${pad("posts read")}${sum("reads")} · surfaced ${sum("sent")}`);

const refusals = window.filter((p) => p.refused).length;
if (refusals) lines.push(`${pad("refusals")}${refusals} (the covenant said no)`);

const idle = window.filter((p) => !p.searches);
if (idle.length) lines.push(`${pad("bought nothing")}${idle.length} — ${idle[idle.length - 1].why ?? "no reason recorded"}`);

lines.push("");
lines.push(`${pad("last pass")}${hhmm(new Date(last.at))}, ${ago(sinceLast)} ago`);

if (existsSync(STATE)) {
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8")) as { epochStartedAt?: string };
    if (s.epochStartedAt) {
      const ends = new Date(s.epochStartedAt).getTime() + LISTENER.epochHours * 3_600_000;
      lines.push(ends > now ? `${pad("epoch resets")}in ${ago(ends - now)}` : `${pad("epoch resets")}on the next pass`);
    }
  } catch { /* state is the pass's business, not the heartbeat's */ }
}

if (stale) {
  lines.push("");
  lines.push(`NOTHING HAS RUN FOR ${ago(sinceLast)}. A pass is due every ${LISTENER.epochHours}h.`);
  lines.push(`See ~/Library/Logs/warda-listener.log, or reinstall: ops/install-cron.sh --listener`);
}

console.log(lines.join("\n"));
process.exit(stale ? 1 : 0);
