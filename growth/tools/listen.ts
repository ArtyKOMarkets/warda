/**
 * Listener: one pass. Search X, score what came back, send the good ones.
 *
 *   source ../ops/node.env
 *   node --experimental-strip-types tools/listen.ts --dry-run
 *   node --experimental-strip-types tools/listen.ts
 *
 * Twice daily, from cron. A pass is small on purpose: it buys what this
 * epoch's allowance affords, reports what it found, and stops. There is no
 * long-running process to keep alive and nothing to resume except the
 * purchase machinery that already knows how.
 *
 * ## It does not implement paying
 *
 * `agents/tools/buy.ts` does, and it is the same loop #002 through #006 use:
 * it holds the grant, advances the manifest, writes every attempt — including
 * the refusals — to a purchase file, and resumes a payment that settled
 * without being served. Re-implementing that here would be a fourth copy of a
 * payment loop, and the copy that drifts is always the one nobody is looking
 * at. So this shells out, exactly as `week.ts` does.
 *
 * Exit 3 from that tool is the covenant refusing. That is not an error here:
 * it is the limit doing its job, it gets said plainly, and the pass ends.
 *
 * ## What is written down
 *
 * `growth/listener/state.json` — the rotation cursor, the posts already sent,
 * and what has been spent this epoch. The seen list is what stops the same
 * thread arriving twice; it is the only state whose loss would be felt, and
 * losing it costs duplicate messages rather than duplicate money.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listen, QUERIES, type Fetcher, type Scored } from "../src/listen.ts";
import { plan } from "../src/rotate.ts";
import { alert, summary } from "../src/alert.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const DIR = join(HERE, "..", "listener");
const STATE = join(DIR, "state.json");

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const DRY = has("dry-run");
const PRICE = Number(flag("price", "5000000"));
const EPOCH_HOURS = Number(flag("epoch-hours", "12"));
const EPOCH_LIMIT = Number(flag("epoch-limit", "15000000")); // 0.15 KAS: three searches
const LIMIT = Number(flag("limit", "6"));
/* What one search buys. It must match the seller's --max-results: the seller
   caps the cost either way, but a buyer asking for 25 and paying for 10 has a
   request that disagrees with its own receipt. */
const PER_QUERY = Number(flag("per-query", "10"));
const XREADS = flag("xreads", process.env.XREADS_URL ?? "http://127.0.0.1:8788")!;
const GRANT = flag("grant", process.env.LISTENER_GRANT);
const PAYEES = flag("recipients", join(HERE, "..", "listener-payees.txt"));
/** Handles never worth reporting: ours, and anyone already in a thread with you. */
const MUTE = new Set((process.env.LISTENER_MUTE ?? "wardaprotocol").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
/** The topics worth checking every twelve hours, not every other pass. */
const ALWAYS = (process.env.LISTENER_ALWAYS ?? "x402,agent payments").split(",").map((s) => s.trim()).filter(Boolean);

interface State {
  cursor: number;
  epochStartedAt: string;
  spentThisEpochSompi: number;
  seen: string[];
  lastRunAt?: string;
}

function load(): State {
  if (!existsSync(STATE)) return { cursor: 0, epochStartedAt: new Date().toISOString(), spentThisEpochSompi: 0, seen: [] };
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8")) as State;
    return { cursor: s.cursor ?? 0, epochStartedAt: s.epochStartedAt ?? new Date().toISOString(),
             spentThisEpochSompi: s.spentThisEpochSompi ?? 0, seen: Array.isArray(s.seen) ? s.seen : [] };
  } catch {
    /* A corrupt state file must not stop a pass. The cost of starting over is
       duplicate messages for a day; the cost of not running is a silent gap
       in the one feed being trusted to be complete. */
    console.error(`${STATE} is unreadable — starting from nothing. Expect some repeats today.`);
    return { cursor: 0, epochStartedAt: new Date().toISOString(), spentThisEpochSompi: 0, seen: [] };
  }
}

function save(s: State) {
  mkdirSync(DIR, { recursive: true });
  /* The seen list is bounded: a post older than a few days cannot be reported
     again anyway, because the age penalty puts it under the floor. Keeping
     every id forever would grow a file for no benefit. */
  writeFileSync(STATE, `${JSON.stringify({ ...s, seen: s.seen.slice(-4000) }, null, 2)}\n`);
}

/** A fresh epoch resets the software allowance, the same way the chain does. */
function rollEpoch(s: State): State {
  const age = Date.now() - new Date(s.epochStartedAt).getTime();
  if (age < EPOCH_HOURS * 3_600_000) return s;
  return { ...s, epochStartedAt: new Date().toISOString(), spentThisEpochSompi: 0 };
}

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const p = spawn("node", ["--experimental-strip-types", cmd, ...args], { cwd: REPO, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => { stderr += d; process.stderr.write(d); });
    p.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function notify(text: string) {
  const token = (process.env.WARDA_TELEGRAM_TOKEN ?? "").trim();
  const chat = (process.env.WARDA_TELEGRAM_CHAT ?? "").trim();
  if (!token || !chat) { console.log(`\n${text}\n`); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error(`telegram: ${r.status} — the pass ran regardless.`);
  } catch (e) {
    console.error(`telegram: ${(e as Error).message} — the pass ran regardless.`);
  }
}

async function main() {
  let state = rollEpoch(load());

  const p = plan({
    queries: QUERIES,
    cursor: state.cursor,
    priceSompi: PRICE,
    epochRemainingSompi: Math.max(0, EPOCH_LIMIT - state.spentThisEpochSompi),
    always: ALWAYS,
  });
  console.error(`listener: ${p.why}`);
  if (p.searches === 0) {
    /* Nothing bought means nothing to report, and reporting nothing every
       twelve hours is how a feed trains you to ignore it. Said on stderr,
       where cron mail will carry it, and not to the phone. */
    save({ ...state, lastRunAt: new Date().toISOString() });
    return;
  }

  /* One buy per search, through the grant. The fetcher below is what turns a
     query into a purchase, so `listen` stays the same pure function the tests
     exercise and the money lives in one place. */
  let spent = 0;
  let refused: string | null = null;
  const bought: Fetcher = async (url) => {
    if (refused) return { status: 0, body: "" };
    const target = `${XREADS}/search?${new URL(url).searchParams}`;
    if (DRY) { console.error(`would buy ${target}`); return { status: 0, body: "" }; }
    if (!GRANT) { console.error("no --grant: pass one, or use --dry-run"); process.exit(2); }
    const r = await run(join(REPO, "agents/tools/buy.ts"), [
      target, "--json", "--id", "GROWTH-LISTENER", "--grant", GRANT, "--recipients", PAYEES!,
      "--out", join(DIR, "purchases"), "--task", "x search",
    ], { WARDA_SK: readFileSync(join(HERE, "..", "keys", "listener.key"), "utf8").trim() });
    if (r.code === 3 || /remains in the current epoch/.test(r.stderr)) {
      refused = "the covenant refused: this grant's allowance for the epoch is spent.";
      return { status: 0, body: "" };
    }
    if (r.code !== 0) return { status: 0, body: "" };
    spent += PRICE;
    try {
      const paid = JSON.parse(r.stdout) as { body?: unknown };
      return { status: 200, body: JSON.stringify(paid.body ?? paid) };
    } catch { return { status: 0, body: r.stdout }; }
  };

  const since = new Date(Date.now() - 2 * EPOCH_HOURS * 3_600_000).toISOString();
  const result = await listen(bought, { since, seen: new Set(state.seen), limit: LIMIT, perQuery: PER_QUERY, mute: MUTE }, p.queries);

  const send: Scored[] = result.found;
  for (const [i, s] of send.entries()) {
    const a = alert(s, { n: i + 1, of: send.length });
    await notify(a.text);
    state.seen.push(s.post.id);
  }

  const line = summary({
    searched: result.searched.length,
    reads: result.reads,
    sent: send.length,
    skipped: result.rejected.length,
    costUsd: result.reads * 0.005,
    spentKas: spent / 1e8,
    note: refused ?? undefined,
  });
  console.error(`\n${line}`);
  /* The summary goes to the phone only when it carries news: something was
     sent, or the covenant refused. A twice-daily "nothing today" is the
     message that teaches you to stop reading them. */
  if (send.length > 0 || refused) await notify(line);

  state = { ...state, cursor: p.nextCursor, spentThisEpochSompi: state.spentThisEpochSompi + spent, lastRunAt: new Date().toISOString() };
  save(state);
  if (refused) process.exit(3);
}

void main().catch((e: Error) => { console.error(e.stack ?? e.message); process.exit(1); });
