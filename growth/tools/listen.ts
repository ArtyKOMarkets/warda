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
 * ## --direct, and why it exists at all
 *
 * `--dry-run` prints the searches it would buy and calls nothing, which tells
 * you the rotation works and nothing about whether the RANKING does. The
 * ranking is the part that decides whether this is worth having, and it can
 * only be judged against real posts.
 *
 * So `--direct` calls X with your own bearer token, no grant and no payment,
 * prints every candidate with its score broken down, and sends nothing. It is
 * the cheapest way to find out the rule is wrong — before there is a grant, a
 * tunnel and a signed listing standing in front of it.
 *
 * It is also the one path here with no covenant behind it, so it carries its
 * own limit: a read cap, checked before every search, that it will not exceed.
 * Same shape as the epoch limit and for the same reason. The difference is
 * that this one is only software, which is exactly the weakness the rest of
 * this repo exists to argue about.
 *
 * ## --direct --send: running before the grant exists
 *
 * A trial you are watching sends nothing. A trial on cron has to, or there is
 * nothing to judge and nobody looking. So `--send` turns the messages on, and
 * the cap drops from a browsing 60 reads to what the grant will allow — three
 * searches an epoch, from src/shape.ts.
 *
 * That last part is the point. Running unattended at the budget the covenant
 * will enforce means switching to the grant changes nothing except WHERE the
 * limit lives: same cadence, same cost, same rotation. If the software budget
 * and the covenant disagreed, the switch would look like a regression and the
 * covenant would get the blame.
 *
 * ## What is written down
 *
 * `growth/listener/state.json` — the rotation cursor, the posts already sent,
 * and what has been spent this epoch. The seen list is what stops the same
 * thread arriving twice; it is the only state whose loss would be felt, and
 * losing it costs duplicate messages rather than duplicate money.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { explain, listen, QUERIES, type Fetcher, type Scored } from "../src/listen.ts";
import { xFetcher } from "../src/xsearch.ts";
import { plan } from "../src/rotate.ts";
import { alert, summary } from "../src/alert.ts";
import { score } from "../src/listen.ts";
import { pruneDir } from "../src/retain.ts";
import { epochStart } from "../src/epoch.ts";
import { LISTENER } from "../src/shape.ts";

/**
 * `growth/listener.env`, loaded before anything reads process.env.
 *
 * X_BEARER_TOKEN is billed per read and QUOTE_SECRET signs quotes, so both are
 * passwords. A password that has to be re-exported in every new terminal gets
 * typed into one eventually, and a secret in shell history is a secret in a
 * file nobody remembers is a file. The env file is gitignored; anything
 * already set in the environment wins, so a one-off override still works.
 */
function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    /* `export FOO=bar` as well as `FOO=bar`: ops/alerts.env is a file meant
       to be `source`d by shell scripts, and it is read here too. */
    const key = t.slice(0, eq).trim().replace(/^export\s+/, "");
    /* Quotes are stripped because a token pasted from a password manager
       often arrives wearing them, and a bearer token with a quote in it fails
       as a 401 that looks like a bad token rather than a bad file. */
    const value = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!(key in process.env)) process.env[key] = value;
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const DIR = join(HERE, "..", "listener");
const STATE = join(DIR, "state.json");
/* One line per pass, including the passes that buy nothing. Without it the
   only trace of a pass is `lastRunAt`, which the NEXT pass overwrites -- so
   "found nothing", "epoch already spent" and "cron is dead" all look the same
   from a phone, and the third one is the only one that needs a person. */
const PASSES = join(DIR, "passes.jsonl");

/* The Listener's own file first, then the alerts bot. `ops/alerts.env`
   already holds a working WARDA_TELEGRAM_TOKEN and chat — the one the growth
   week and the runner's ops messages use — and standing up a second bot to
   send to the same person is a second thing to keep alive for no gain. First
   file to set a key wins, so listener.env still overrides it. */
const growth = dirname(fileURLToPath(import.meta.url));
loadEnv(join(growth, "..", "listener.env"));
loadEnv(join(growth, "..", "..", "ops", "alerts.env"));

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const DRY = has("dry-run");
const DIRECT = has("direct");
/** `--direct` only. What a trial pass may read before it stops, whatever else
 *  it was going to do. 60 reads is $0.30 at X's $0.005. */
const SEND = has("send");
/**
 * A watched trial browses: 60 reads, about $0.30, and you read the rejects.
 * An unattended one spends what the grant will allow and no more — otherwise
 * twice daily at 60 is $4.20 a week against a budget of $2.10.
 */
const CAP_UNATTENDED = (LISTENER.epochLimitSompi / LISTENER.priceSompi) * LISTENER.maxResults;
const MAX_READS = Number(flag("max-reads", String(SEND ? CAP_UNATTENDED : 60)));
/**
 * `--save <file>`: write the posts a trial read, so the weights can be
 * changed and re-checked against them for nothing.
 *
 * The first real run cost $0.30 and taught this project more than the
 * previous day of building did — and then it was gone, because nothing kept
 * it. A ranking is tuned by argument about specific posts, and buying a fresh
 * set every time you move a weight both costs money and changes the evidence
 * under the change you are trying to judge.
 */
const SAVE = flag("save");
/**
 * `--test-telegram`: send one message shaped exactly like a real alert, and
 * stop.
 *
 * This is the link nothing has ever exercised, and it is the only one whose
 * failure is silent by design: `notify` catches its own errors and prints
 * instead, because a pass that found something should not be lost to a
 * Telegram outage. That is right, and it means a token that has never worked
 * looks identical to a quiet week. So it gets tested on purpose, with an
 * alert built from the same `alert()` the real path uses — a message that
 * renders wrong on a phone is as much a failure as one that never arrives.
 */
const TEST_TELEGRAM = has("test-telegram");
/* Defaults from src/shape.ts, which is the one place they are decided. A
   flag still overrides for a one-off, but nothing here restates a number. */
const PRICE = Number(flag("price", String(LISTENER.priceSompi)));
const EPOCH_HOURS = Number(flag("epoch-hours", String(LISTENER.epochHours)));
const EPOCH_LIMIT = Number(flag("epoch-limit", String(LISTENER.epochLimitSompi)));
const LIMIT = Number(flag("limit", "6"));
/* What one search buys. It must match the seller's --max-results: the seller
   caps the cost either way, but a buyer asking for 25 and paying for 10 has a
   request that disagrees with its own receipt. */
const PER_QUERY = Number(flag("per-query", String(LISTENER.maxResults)));
const XREADS = flag("xreads", process.env.XREADS_URL ?? "http://127.0.0.1:8788")!;
const GRANT = flag("grant", process.env.LISTENER_GRANT);
const PAYEES = flag("recipients", join(HERE, "..", "listener-payees.txt"));
/** Handles never worth reporting: ours, and anyone already in a thread with you. */
const MUTE = new Set((process.env.LISTENER_MUTE ?? "warda_protocol").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
/** The topics worth checking every twelve hours, not every other pass. */
const ALWAYS = (process.env.LISTENER_ALWAYS ?? "x402,agent payments").split(",").map((s) => s.trim()).filter(Boolean);

interface State {
  cursor: number;
  epochStartedAt: string;
  spentThisEpochSompi: number;
  seen: string[];
  lastRunAt?: string;
  /**
   * Which purse the last pass drew on.
   *
   * The epoch counter measures one thing and there are two of them. Before
   * the grant existed, `--direct --send` counted dollars on a card at the
   * price a search WILL cost, deliberately, so the arithmetic was exercised
   * at the covenant's budget before a covenant enforced it. The moment a
   * grant takes over, that number is about a purse nobody is spending from
   * any more — and on the first real run it said the epoch was exhausted
   * while the grant on chain had spent nothing.
   *
   * So the source is recorded, and changing it resets the count. Carrying it
   * across is not conservative, it is wrong in a direction that looks like
   * the covenant refusing.
   */
  fundedBy?: "card" | "grant";
}

function load(): State {
  if (!existsSync(STATE)) return { cursor: 0, epochStartedAt: new Date().toISOString(), spentThisEpochSompi: 0, seen: [] };
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8")) as State;
    return { cursor: s.cursor ?? 0, epochStartedAt: s.epochStartedAt ?? new Date().toISOString(),
             spentThisEpochSompi: s.spentThisEpochSompi ?? 0, seen: Array.isArray(s.seen) ? s.seen : [],
             fundedBy: s.fundedBy };
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

function logPass(r: Record<string, unknown>) {
  mkdirSync(DIR, { recursive: true });
  try {
    appendFileSync(PASSES, `${JSON.stringify({ at: new Date().toISOString(), ...r })}\n`);
  } catch (e) {
    /* The log is for legibility, not for money. A pass that cannot write it
       still did its job, and failing here would turn a bookkeeping problem
       into a missed feed. */
    console.error(`listener: could not append to ${PASSES}: ${(e as Error).message}`);
  }
}

/** A fresh epoch resets the software allowance, the same way the chain does.
 *  Where the boundary sits, and why it is a fixed grid rather than "now",
 *  is `epochStart` in ../src/epoch.ts -- it is there so a test can hold it. */
function rollEpoch(s: State): State {
  const next = epochStart(s.epochStartedAt, Date.now(), EPOCH_HOURS);
  return next === s.epochStartedAt ? s : { ...s, epochStartedAt: next, spentThisEpochSompi: 0 };
}

/**
 * Switching purses starts the epoch again.
 *
 * The count is only meaningful against the thing it was counted from. A
 * card-funded pass that used this epoch's three searches says nothing about
 * what the grant may still spend, and treating it as if it did produces a
 * refusal with the covenant's shape and none of its cause.
 */
function rollFunding(s: State, now: "card" | "grant"): State {
  if (s.fundedBy === now) return { ...s, fundedBy: now };
  /* Announced whenever a real count is being thrown away, including the first
     time — when there is no recorded source to have changed FROM, because the
     state predates this field. Discarding a number silently is how you later
     wonder whether it was ever right. */
  if (s.fundedBy || s.spentThisEpochSompi > 0) {
    const from = s.fundedBy ?? "an unrecorded source";
    console.error(`listener: funding changed from ${from} to ${now} — the epoch count starts again.`);
    console.error(`  ${s.spentThisEpochSompi} sompi was counted against ${from}, which is not what this pass draws on.`);
  }
  return { ...s, fundedBy: now, epochStartedAt: new Date().toISOString(), spentThisEpochSompi: 0 };
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
  if (TEST_TELEGRAM) {
    const token = (process.env.WARDA_TELEGRAM_TOKEN ?? "").trim();
    const chat = (process.env.WARDA_TELEGRAM_CHAT ?? "").trim();
    console.error(`telegram: token ${token ? "set" : "MISSING"}, chat ${chat ? "set" : "MISSING"}`);
    if (!token || !chat) {
      console.error("Put them in growth/listener.env, or let ops/alerts.env supply them.");
      process.exit(2);
    }
    /* A real post, from the second run, so what arrives is what an alert
       actually looks like rather than a placeholder that proves nothing about
       length, wrapping or the link preview. */
    const sample = score({
      id: "2102689461955936645",
      url: "https://x.com/AngelFamadr/status/2102689461955936645",
      text: "@AEON_Community What safeguards exist against hacking/unauthorized transactions when giving an agent a wallet?",
      at: new Date(Date.now() - 40 * 60_000).toISOString(),
      author: { handle: "AngelFamadr", name: null, followers: 3_000, verified: false },
      likes: 0, replies: 0, reposts: 0, matched: ["agent wallet"],
    });
    const a = alert(sample, { n: 1, of: 1 });
    console.error(`\n${a.text}\n`);
    let r: Response;
    try {
      r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: a.text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      /* Not a stack trace. "fetch failed" from undici means the request never
         left, which is a network or a proxy — a different problem from a
         token Telegram rejected, and the one a stack trace disguises worst. */
      console.error(`could not reach api.telegram.org: ${(e as Error).message}`);
      console.error("The message above is what would have been sent. Nothing is wrong with it.");
      process.exit(1);
    }
    const body = await r.text();
    if (!r.ok) {
      /* Telegram's own words. `chat not found` and `unauthorized` are
         different problems and the status alone tells you neither. */
      console.error(`telegram refused it: ${r.status}\n${body}`);
      process.exit(1);
    }
    console.error("sent. Check your phone: it should be one message, with a tappable link at the end.");
    return;
  }

  /* First, before anything else and whatever mode this is.
     X allows keeping Post objects offline only with a 24-hour obligation to
     reflect deletions; Post IDs have no such condition. A saved run keeps its
     text for a day of tuning and then keeps only what is ours. Run here
     rather than written in the runbook, because a retention rule somebody has
     to remember holds until the week they are busy. */
  for (const done of pruneDir(DIR)) {
    console.error(`pruned ${done.file}: ${done.posts} posts older than a day, IDs kept, X's content dropped`);
  }

  let state = rollFunding(rollEpoch(load()), DIRECT ? "card" : "grant");

  /* In --direct there is no grant, so the rotation is bounded by the read cap
     rather than by an allowance. Expressed in the same units so `plan` does
     not need to know which mode it is in. */
  const epochRemaining = DIRECT
    ? Math.floor(MAX_READS / PER_QUERY) * PRICE
    : Math.max(0, EPOCH_LIMIT - state.spentThisEpochSompi);

  const p = plan({
    queries: QUERIES,
    cursor: state.cursor,
    priceSompi: PRICE,
    epochRemainingSompi: epochRemaining,
    always: ALWAYS,
  });
  console.error(`listener: ${p.why}`);
  if (p.searches === 0) {
    /* Nothing bought means nothing to report, and reporting nothing every
       twelve hours is how a feed trains you to ignore it. Said on stderr,
       where cron mail will carry it, and not to the phone. */
    logPass({ searches: 0, why: p.why, reads: 0, sent: 0, spentSompi: 0, funded: state.fundedBy ?? null });
    save({ ...state, lastRunAt: new Date().toISOString() });
    return;
  }

  /* One buy per search, through the grant. The fetcher below is what turns a
     query into a purchase, so `listen` stays the same pure function the tests
     exercise and the money lives in one place. */
  let spent = 0;
  let reads = 0;
  let refused: string | null = null;

  /* Your card, not a grant. Announced on every pass rather than once in a
     README, because the argument this whole repo makes is that an unbounded
     spender should be visibly unbounded. */
  const direct: Fetcher = async (url) => {
    if (reads >= MAX_READS) {
      refused = `the trial read cap is spent: ${reads} of ${MAX_READS}. Nothing on chain bounded this — the cap is in tools/listen.ts, and that is the point.`;
      return { status: 0, body: "" };
    }
    const token = process.env.X_BEARER_TOKEN;
    if (!token) { console.error("--direct needs X_BEARER_TOKEN."); process.exit(2); }
    const r = await xFetcher(token)(url);
    if (r.status === 200) reads += PER_QUERY;
    return r;
  };

  const bought: Fetcher = async (url) => {
    if (refused) return { status: 0, body: "" };
    /* The seller's contract is `q` and `since`; what arrives here is X's own
       URL, with `query` and `start_time`. Forwarding the parameters wholesale
       sent the seller names it does not read, and it answered 400 three times
       — correctly, and before quoting, so nothing was charged for it.
    
       Translated rather than aligned, because the two names are right on
       their own sides: `listen` builds a real X request so its tests can
       assert a real X request, and the seller takes a query and a window
       because that is all it sells. `max_results` is deliberately not
       forwarded: what a search costs is the seller's decision, not the
       buyer's ask. */
    const x = new URL(url).searchParams;
    const want = new URLSearchParams();
    want.set("q", x.get("query") ?? "");
    const since = x.get("start_time");
    if (since) want.set("since", since);
    const target = `${XREADS}/search?${want}`;
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

  if (DIRECT) {
    console.error(`\nlistener --direct: calling X on your own token, no grant, no payment.`);
    console.error(`  at most ${MAX_READS} reads this pass — about $${(MAX_READS * 0.005).toFixed(2)}.`);
    if (SEND) console.error(`  --send: messages go to Telegram, and the cap is what the grant will allow.`);
    console.error("");
  }

  const since = new Date(Date.now() - 2 * EPOCH_HOURS * 3_600_000).toISOString();
  const result = await listen(DIRECT ? direct : bought,
    { since, seen: new Set(state.seen), limit: LIMIT, perQuery: PER_QUERY, mute: MUTE }, p.queries);

  if (SAVE) {
    mkdirSync(dirname(SAVE), { recursive: true });
    const posts = [...result.found, ...result.rejected].map((x) => x.post);
    writeFileSync(SAVE, `${JSON.stringify({ at: new Date().toISOString(), since, queries: p.queries.map((q) => q.label), posts }, null, 2)}\n`);
    console.error(`saved ${posts.length} posts to ${SAVE} — rescore them with tools/rescore.ts`);
  }

  /* The trial's actual output: every candidate with its reasons, the rejected
     ones included and named as rejected. A ranking is judged by what it threw
     away at least as much as by what it kept. */
  if (DIRECT) {
    for (const r of result.searched) {
      console.log(r.status === 200 ? `  ok  ${r.label}: ${r.found} posts` : `  --  ${r.label}: ${explain(r.status)}`);
    }
    /* One line, not one per query: six identical explanations is the same
       failure to say anything that the six bare numbers were. */
    const stuck = [...new Set(result.searched.filter((r) => r.status !== 200).map((r) => r.status))];
    if (stuck.length === 1 && result.searched.every((r) => r.status !== 200)) {
      console.log(`\n  every search answered the same way. ${explain(stuck[0]!)}`);
    }
    console.log("");
    const show = (x: Scored, mark: string) => {
      console.log(`${mark} ${String(x.score).padStart(3)}  @${x.post.author.handle}  ${x.post.text.replace(/\s+/g, " ").slice(0, 88)}`);
      console.log(`        ${x.why.join("  ")}`);
      console.log(`        ${x.post.url}\n`);
    };
    for (const x of result.found) show(x, x.band === "high" ? "HIGH" : "look");
    for (const x of result.rejected) show(x, "  --");
  }

  /* A watched trial sends nothing: the point is to read the reasons yourself,
     and a rule still being tuned should not be interrupting anybody. On cron
     there is nobody reading a terminal, so --send is what makes it a product
     rather than an exercise. */
  const send: Scored[] = DIRECT && !SEND ? [] : result.found;
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
    note: refused ?? (DIRECT && SEND ? "No covenant behind this yet — the cap is in tools/listen.ts." : undefined),
  });
  console.error(`\n${line}`);
  /* The summary goes to the phone only when it carries news: something was
     sent, or the covenant refused. A twice-daily "nothing today" is the
     message that teaches you to stop reading them. */
  if (send.length > 0 || refused) await notify(line);

  /* A watched trial advances the rotation, so a day of passes covers every
     query — but records nothing as seen and nothing as spent, because the
     posts it looked at must still be reportable once this is real.
 
     --send is different on both counts. What was sent must not be sent again
     twelve hours later, and the epoch accounting has to run exactly as it
     will under the grant — it is the same arithmetic, and the whole reason
     for running it here is to find out whether it is right before a covenant
     is enforcing it. Reads are counted at the price a search will cost. */
  const spentThisPass = DIRECT ? (reads / LISTENER.maxResults) * LISTENER.priceSompi : spent;
  state = DIRECT && !SEND
    ? { ...state, cursor: p.nextCursor, lastRunAt: new Date().toISOString() }
    : { ...state, cursor: p.nextCursor, spentThisEpochSompi: state.spentThisEpochSompi + spentThisPass, lastRunAt: new Date().toISOString() };
  logPass({ searches: p.searches, why: p.why, reads, sent: send.length,
            skipped: result.rejected.length, spentSompi: spentThisPass,
            refused: refused ?? null, funded: state.fundedBy ?? null });
  save(state);
  if (refused && !DIRECT) process.exit(3);
}

void main().catch((e: Error) => { console.error(e.stack ?? e.message); process.exit(1); });
