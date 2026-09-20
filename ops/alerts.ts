/**
 * Watch a few things, and say something when one of them changes.
 *
 *     ops/alerts.sh --dry-run        what it would send, sending nothing
 *     ops/alerts.sh --test           prove the pipe works before relying on it
 *     ops/alerts.sh --quiet          for cron
 *
 * ## This notifies. It never acts.
 *
 * The obvious next feature is the one this will not have: a rule that converts
 * on your behalf when the balance reaches your number. To do that it would
 * need a key that can move the coin, or an exchange key that can withdraw, and
 * it would need to hold that key on a schedule, unattended, forever. That is
 * the hot wallet this whole project exists to not be — the same reason
 * `warda fund` prints the sale instead of performing it, and the same reason
 * `warda topup` is not in `install-cron.sh`.
 *
 * So the strongest thing that can be said about this file is what it cannot
 * do. It holds no key, signs nothing, and builds no transaction. It reads
 * addresses and sends text. If it were compromised tomorrow, the worst an
 * attacker gets is your Telegram chat and the knowledge of what your agents
 * hold — which is a public chain anyone can already read.
 *
 * ## Thresholds are in sompi, even when you meant dollars
 *
 * "Tell me when this is worth $50" is a reasonable thing to want and an
 * unreasonable thing for a cron job to decide, because deciding it means
 * fetching a price, and a price fetched by a machine at 3am is a number
 * nobody said. `warda fund` already refuses to fetch one for exactly this
 * reason.
 *
 * The conversion therefore happens ONCE, in front of a person, at the moment
 * the rule is written: the console turns your $50 into KAS at a rate you can
 * see and records both. What lands in `ops/alerts.json` is a sompi figure the
 * node can compare against, plus a `quote` block that remembers what you meant
 * by it. The comparison never reads the quote. The message always shows it,
 * and says whose number it was.
 *
 * This is the same shape as everything else here: conversions belong at the
 * edges of a relationship, in front of a human, not inside each evaluation.
 *
 * ## Three states, not two
 *
 * A rule is `clear`, `firing`, or `undecided`. The third one is the whole
 * point. A node that is down, or a manifest the chain no longer confirms,
 * produces no reading — and a watcher that reports no reading as "nothing to
 * report" is the failure this repository keeps re-learning: absence rendered
 * as a measurement. An undecided rule says so, once, and keeps whatever it
 * knew before rather than overwriting it with a guess.
 *
 * ## It fires on the change, not on the condition
 *
 * A message every fifteen minutes for a condition that is still true is a
 * message you learn to swipe away, and the one that mattered goes with it. So
 * state is persisted and only transitions are sent — including the transition
 * back. A sweep rule that fired at your threshold and then went quiet after
 * you converted has told you two useful things; one that only ever fires has
 * told you one and then lied by omission.
 *
 * ## Exit codes
 *
 *   0   ran, and either sent what it had to or had nothing to send.
 *   1   could not send, or could not evaluate anything at all.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EMPTY_RESERVE,
  NodeClient,
  resolveNode,
  resolverFrom,
  scriptHashFor,
  scriptHashToAddress,
  templateIdFor,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
} from "@warda_protocol/kaspa";
import { formatKas } from "@warda_protocol/core";
import { renewVerdict } from "@warda_protocol/router";
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };

import { rpcFrom, resolveNetwork } from "../sdk/tools/network.ts";
import type { Chain } from "../sdk/tools/chain.ts";

const repo = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));
const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const quiet = has("quiet");
const dryRun = has("dry-run");
const RULES = flag("rules", repo("ops/alerts.json"))!;
const STATE = flag("state", repo("ops/alerts-state.json"))!;

/** Printed only when not --quiet. Anything a cron log must keep goes to say(). */
const chat = (s = "") => { if (!quiet) console.error(s); };
/** Always printed: a cron log that is empty when all is well, and not otherwise. */
const say = (s = "") => console.error(s);

/* ------------------------------------------------------------------ rules */

/**
 * The kinds, and the promise each makes.
 *
 * Adding one means adding a case to `evaluate`, a sentence to `describe`, and
 * an entry to `ops/alerts.example.json`. `ops/check-alerts.mjs` refuses a kind
 * that is missing any of the three, because a rule you can write and the tool
 * silently ignores is worse than a rule you cannot write.
 */
type Kind = "budget-low" | "expiring" | "balance-at-or-above";

/** What a person meant by a sompi figure, at the moment they wrote it down. */
interface Quote {
  /** e.g. "50" */
  amount: string;
  /** e.g. "USD" */
  asset: string;
  /** Units of `asset` one KAS bought, as stated. */
  perKas: string;
  /** Who said it, and when. A name a reader can go and ask. */
  source: string;
}

export interface Rule {
  id: string;
  kind: Kind;
  /** Free text shown at the top of the message. Yours, not generated. */
  note?: string;
  /** budget-low, expiring: path to the grant manifest, relative to the repo. */
  grant?: string;
  /** budget-low: at or below this much LEFT, a successor is due. */
  below?: string;
  /** budget-low: what the successor would cost, budget + fee. */
  needed?: string;
  /** budget-low: the funder's ADDRESS — never a key. Optional. */
  funder?: string;
  /** expiring: fire when the term has this many blocks or fewer to run. */
  within?: number;
  /** balance-at-or-above: the address to watch. */
  address?: string;
  /** balance-at-or-above: the threshold, in sompi. */
  atOrAbove?: string;
  /** What the sompi figure meant to you. Never read by the comparison. */
  quote?: Quote;
}

interface RuleFile {
  telegram?: { chatId?: string };
  rules: Rule[];
}

/* ------------------------------------------------------------------ state */

export type Status = "clear" | "firing" | "undecided";

export interface Remembered {
  status: Status;
  /** When it last CHANGED, not when it was last looked at. */
  since: string;
  /** Consecutive runs that could not decide it. */
  blind?: number;
  /** Whether the undecided run has already been reported. Once is enough. */
  blindReported?: boolean;
}

/**
 * What a run does to one rule's memory, and whether it says anything.
 *
 * Pulled out as a pure function for the same reason `renewVerdict` is one: it
 * is the part that has to be right at 3am, when nobody is reading the log, and
 * a pure function can be wrong in a test instead. `ops/test/alerts.test.ts`
 * holds it to the four rules below.
 *
 * 1. An undecided run has no opinion. It keeps the last decided status rather
 *    than overwriting it, so the NEXT firing is still a change from `clear`
 *    and not a change from nothing.
 * 2. It says so once. A rule that cannot be read for a week must not send a
 *    week of messages, and must not be silent either.
 * 3. Only changes are sent, including the change back. A message every
 *    fifteen minutes for a condition that is still true is a message you
 *    learn to swipe away.
 * 4. A rule that has never been seen before and is CLEAR says nothing. It was
 *    not firing, so it has not cleared — and on a fresh install every quiet
 *    rule announcing that it is quiet is the first impression this makes.
 *    A first run that is already FIRING does speak: that is news.
 */
export function transition(
  prev: Remembered | undefined,
  status: Status,
  now: string,
): { next: Remembered; send: "firing" | "cleared" | "blind" | null } {
  if (status === "undecided") {
    const reported = prev?.blindReported ?? false;
    return {
      next: {
        status: prev?.status ?? "undecided",
        since: prev?.since ?? now,
        blind: (prev?.blind ?? 0) + 1,
        blindReported: true,
      },
      send: reported ? null : "blind",
    };
  }
  /* Decided: the blind memo is cleared, so the next outage speaks again. */
  if (prev?.status === status) {
    return { next: { status, since: prev.since, blind: 0, blindReported: false }, send: null };
  }
  const next: Remembered = { status, since: now, blind: 0, blindReported: false };
  /* Nothing to clear if it was never firing — a rule seen for the first time,
     or one that has only ever been undecided. */
  if (status === "clear" && prev?.status !== "firing") return { next, send: null };
  return { next, send: status === "firing" ? "firing" : "cleared" };
}

const loadState = (): Record<string, Remembered> => {
  if (!existsSync(STATE)) return {};
  try {
    return JSON.parse(readFileSync(STATE, "utf8")) as Record<string, Remembered>;
  } catch {
    /* A corrupt state file must not stop the watcher — but starting from
       scratch silently would re-fire every rule as though it had just changed.
       Say so, and let the re-fire be explained rather than mysterious. */
    say("ops/alerts-state.json is unreadable; starting from nothing. Rules that are");
    say("already true will announce themselves once more.");
    return {};
  }
};

/* ------------------------------------------------------------------ reading */

/** A rule's outcome. `undecided` carries WHY, because that is the finding. */
export type Outcome =
  | { status: "clear"; lines: string[] }
  | { status: "firing"; lines: string[] }
  | { status: "undecided"; why: string };

const template = covenantTemplate as unknown as CovenantTemplate;

const { prefix, network } = resolveNetwork({
  prefix: flag("prefix"),
  network: flag("network", process.env.WARDA_NETWORK ?? "testnet-10"),
  action: "read an address",
});

/** Manifest -> the address the chain would hold this grant at, right now. */
function addressOf(m: Record<string, unknown>): { state: GrantState; address: string } {
  const authority: GrantAuthority = {
    principalKey: m.principal as string,
    revocationKey: (m.revocation as string) ?? (m.principal as string),
  };
  const state: GrantState = {
    agentKey: m.agent as string,
    budgetTotal: BigInt(m.budget as string),
    maxPerSpend: BigInt(m.max_per_spend as string),
    epochLimit: BigInt(m.epoch_limit as string),
    epochLength: BigInt(m.epoch_length as string),
    recipientsRoot: m.recipients_root as string,
    notBefore: BigInt(m.not_before as string),
    expiresAt: BigInt(m.expires_at as string),
    delegationDepth: BigInt(m.delegation_depth as string),
    templateId: templateIdFor(template, authority),
    spentTotal: BigInt(m.spent_total as string),
    reserved: BigInt(m.reserved as string),
    epochIndex: BigInt(m.epoch_index as string),
    epochSpent: BigInt(m.epoch_spent as string),
    reserveRoot: (m.reserve_root as string) ?? EMPTY_RESERVE,
  };
  return { state, address: scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix) };
}

export interface Reader {
  daa: bigint;
  at(address: string): Promise<bigint[]>;
}

export async function evaluate(rule: Rule, read: Reader): Promise<Outcome> {
  if (rule.kind === "balance-at-or-above") {
    if (!rule.address || !rule.atOrAbove) {
      return { status: "undecided", why: "needs both `address` and `atOrAbove`." };
    }
    const held = (await read.at(rule.address)).reduce((a, b) => a + b, 0n);
    const want = BigInt(rule.atOrAbove);
    const lines = [
      `${formatKas(held)} KAS at ${rule.address}`,
      `threshold ${formatKas(want)} KAS`,
    ];
    if (rule.quote) {
      /* Shown, never compared. The rate is whatever was true when a person
         wrote the rule; this run did not check it and does not claim to. */
      lines.push(
        `you set that as ${rule.quote.amount} ${rule.quote.asset} at ` +
          `${rule.quote.perKas} per KAS — ${rule.quote.source}. This alert did not ` +
          `re-check the rate.`,
      );
    }
    return { status: held >= want ? "firing" : "clear", lines };
  }

  if (!rule.grant) return { status: "undecided", why: "needs `grant`, a path to a manifest." };
  const path = rule.grant.startsWith("/") ? rule.grant : repo(rule.grant);
  if (!existsSync(path)) return { status: "undecided", why: `no manifest at ${rule.grant}` };
  const m = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const { state, address } = addressOf(m);

  /* A grant's address is a hash of its state, so it moves on every spend. An
     empty address is a manifest that is behind the agent OR a grant that has
     ended, and those are opposite facts. Neither is "fine", so neither is
     clear. */
  const coins = await read.at(address);
  if (coins.length === 0) {
    return {
      status: "undecided",
      why:
        `the chain holds nothing at ${address}, where ${rule.grant} says this grant is.\n` +
        `  The manifest is behind the agent, or the grant has ended. Both look like this.\n` +
        `  warda find --write`,
    };
  }
  const held = coins[0]!;
  const toGo = state.expiresAt - read.daa;

  if (rule.kind === "expiring") {
    const within = BigInt(rule.within ?? 3600);
    const lines = [
      `${rule.grant}`,
      toGo <= 0n
        ? `expired — the balance is the principal's to reclaim`
        : `${toGo} blocks left (~${toGo / 10n / 60n} min), threshold ${within}`,
      `holds ${formatKas(held)} KAS`,
    ];
    return { status: toGo <= within ? "firing" : "clear", lines };
  }

  /* Every kind is named, and an unrecognised one refuses.
     Written as a fall-through first, which meant a rule whose `kind` was
     misspelled — or written against a newer version of this tool — was
     evaluated as budget-low instead. It would have produced a plausible
     message about the wrong thing, and `ops/check-alerts.mjs` caught it on its
     first run. A watcher that silently substitutes one rule for another is
     worse than one that refuses. */
  if (rule.kind !== "budget-low") {
    return { status: "undecided", why: `no such kind: "${rule.kind}". See ops/alerts.example.json.` };
  }

  /* The decision is renewVerdict's, in @warda_protocol/router, where `warda
     topup` takes it too and where it is covered by tests. This file reads and
     prints; it judges nothing. */
  const reading = {
    budgetTotal: state.budgetTotal,
    spentTotal: state.spentTotal,
    reserved: state.reserved,
    held,
    expiresAt: state.expiresAt,
  };
  const below = BigInt(rule.below ?? state.maxPerSpend);
  const needed = BigInt(rule.needed ?? state.budgetTotal + 100_000_000n);

  /* No funder address means no claim about whether the next grant can be paid
     for. renewVerdict still decides whether one is DUE — that part reads only
     the grant — and the funder half of its answer is simply not printed.
     Reporting "short by" from a wallet nobody named would be inventing a
     measurement, which is the one thing this file must never do. */
  const funderCoins = rule.funder ? await read.at(rule.funder) : [];
  const verdict = renewVerdict({
    grant: reading,
    funder: {
      largest: funderCoins.reduce((a, b) => (b > a ? b : a), 0n),
      total: funderCoins.reduce((a, b) => a + b, 0n),
    },
    below,
    needed,
    now: read.daa,
  });

  const lines = [
    `${rule.grant}`,
    `${formatKas(verdict.left)} KAS left of ${formatKas(state.budgetTotal)}, ` +
      `threshold ${formatKas(below)} KAS`,
  ];
  if (verdict.expired) lines.push("the term is over, whatever the counters say");
  if (verdict.due && rule.funder) {
    if (verdict.fundable) {
      lines.push(`the funder can pay for the next one: ${formatKas(needed)} KAS as one coin`);
    } else if (verdict.obstacle === "not-in-one-coin") {
      lines.push(
        `enough in total but not in one coin — genesis takes a single input.\n` +
          `  warda wallet consolidate`,
      );
    } else {
      lines.push(`the funder is short by ${formatKas(verdict.shortBy)} KAS`);
    }
  }
  if (verdict.due) lines.push(`  warda topup ${rule.grant}`);
  return { status: verdict.due ? "firing" : "clear", lines };
}

/* ------------------------------------------------------------------ telegram */

/**
 * The token is read here and used in exactly one place: the URL below.
 *
 * It is never logged, never written to the state file, and never interpolated
 * into a message. `ops/check-alerts.mjs` enforces that, for the same reason
 * `ops/check-key-writes.mjs` exists — a secret printed to a cron log is a
 * secret in a file nobody thinks of as secret.
 */
const token = (process.env.WARDA_TELEGRAM_TOKEN ?? "").trim();

async function send(text: string, chatId: string): Promise<void> {
  /* No parse_mode. A Kaspa address is full of characters Markdown claims, and
     a message that fails to render is a message that did not arrive. */
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    /* The body carries Telegram's own description, which is the useful part —
       "chat not found" and "unauthorized" need different fixes. It does not
       echo the token; the token is in the URL, which is not in the body. */
    throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/* ------------------------------------------------------------------ run */

/**
 * The I/O shell. Everything above is pure and importable; this reads files,
 * opens a socket and sends messages.
 *
 * It is a function rather than the module body because `ops/test/alerts.test.ts`
 * imports `transition` from here, and a module that starts reading rule files
 * the moment it is imported cannot be tested — it exits 1 on the test runner's
 * machine before a single assertion runs. Which is exactly what it did.
 */
async function main(): Promise<number> {
  if (!existsSync(RULES)) {
    say(`no rules at ${RULES}.`);
    say(``);
    say(`  cp ops/alerts.example.json ops/alerts.json`);
    say(``);
    say(`Then edit it, or compose one in the console at /app and paste it in.`);
    say(`The file is gitignored: it names your addresses and your thresholds.`);
    return 1;
  }

  const file = JSON.parse(readFileSync(RULES, "utf8")) as RuleFile;
  const chatId = (process.env.WARDA_TELEGRAM_CHAT ?? file.telegram?.chatId ?? "").trim();

  if (has("test")) {
    if (!token || !chatId) {
      say("--test needs WARDA_TELEGRAM_TOKEN and a chat id. See ops/alerts.env.example.");
      return 1;
    }
    await send(
      "Warda alerts: this is the test message.\n\n" +
        "If you can read this, the pipe works. Nothing is being watched yet by the\n" +
        "fact of this message arriving — that is what the rules do.",
      chatId,
    );
    say("sent.");
    return 0;
  }

  const rules = file.rules ?? [];
  if (rules.length === 0) {
    say(`${RULES} has no rules. Nothing is being watched.`);
    return 1;
  }

  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) {
      say(`two rules share the id "${r.id}". Ids are how state is remembered, so the`);
      say(`second would overwrite the first and one of them would never fire.`);
      return 1;
    }
    seen.add(r.id);
  }

  /* One connection for every rule. Opened before anything is evaluated so that a
     node that is down produces one undecided run rather than N identical
     failures. */
  let client: Chain | undefined;
  const url = rpcFrom(flag("rpc"));
  try {
    if (url) {
      client = await NodeClient.connect({ url });
    } else if (resolverFrom({ resolver: flag("resolver") })) {
      const found = await resolveNode({ networkId: network });
      ({ client } = await NodeClient.open({ url: found.url, networkId: network }));
    }
  } catch (e) {
    chat(`could not reach a node: ${(e as Error).message}`);
  }

  if (!client) {
    /* Every rule is undecided, and that is ONE thing to say, not N. Nothing is
       written to the state file: a run that could not look must not be allowed
       to claim that anything changed. */
    say(`no node — nothing could be read, so nothing is being reported.`);
    say(`  . ops/node.env   or   --rpc ws://127.0.0.1:18210   or   WARDA_RESOLVER=<resolver>`);
    say(`${rules.length} rule${rules.length === 1 ? "" : "s"} left undecided. State unchanged.`);
    return 1;
  }

  const state = loadState();
  const now = new Date().toISOString();
  const outbox: string[] = [];
  let failed = 0;

  try {
    const dag = await client.getBlockDagInfo();
    const read: Reader = {
      daa: dag.virtualDaaScore,
      at: async (address) => (await client!.getUtxosByAddresses([address])).map((u) => u.entry.value),
    };

    for (const rule of rules) {
      let out: Outcome;
      try {
        out = await evaluate(rule, read);
      } catch (e) {
        out = { status: "undecided", why: (e as Error).message };
      }
      const was = state[rule.id];
      const prev = was?.status;
      const { next, send } = transition(was, out.status, now);
      state[rule.id] = next;

      if (out.status === "undecided") {
        chat(`${rule.id}: undecided — ${out.why}`);
        if (send === "blind") {
          outbox.push(
            `Warda: ${rule.id} cannot be read.\n\n${out.why}\n\n` +
              `This is not "nothing to report" — it is no reading at all. The rule keeps\n` +
              `whatever it knew before. You will not be told again until it can be read.`,
          );
        }
        continue;
      }

      chat(`${rule.id}: ${prev ?? "new"} -> ${out.status}${send ? "" : " (nothing to send)"}`);
      if (!send) continue;
      const head = send === "firing" ? `Warda: ${rule.id}` : `Warda: ${rule.id} — cleared`;
      outbox.push([head, rule.note ?? "", "", ...out.lines].join("\n").replace(/\n\n\n+/g, "\n\n"));
    }
  } finally {
    client.close?.();
  }

  if (outbox.length === 0) {
    chat(`nothing changed.`);
  } else if (dryRun) {
    say(`--dry-run: ${outbox.length} message(s), none sent.\n`);
    for (const m of outbox) say(m + "\n" + "-".repeat(60));
  } else if (!token || !chatId) {
    /* Having something to say and no way to say it is a failure, not a quiet
       run. Print it — the cron log is then the delivery of last resort. */
    failed = 1;
    say(`${outbox.length} message(s) to send and no Telegram credentials.`);
    say(`  cp ops/alerts.env.example ops/alerts.env    and fill it in\n`);
    for (const m of outbox) say(m + "\n" + "-".repeat(60));
  } else {
    for (const m of outbox) {
      try {
        await send(m, chatId);
        say(`sent: ${m.split("\n")[0]}`);
      } catch (e) {
        failed = 1;
        say(`NOT SENT: ${(e as Error).message}`);
        say(m);
      }
    }
  }

  /* The state file is written whatever happened to the sending, EXCEPT when
     there was nothing to read at all (handled above, before any state was
     touched). A message that failed to send has still been reported — in the
     cron log, loudly — and re-announcing it on every run afterwards would bury
     the next real change. */
  if (!dryRun) writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
  return failed;
}

/* Run only when run. Imported, this file is just `transition` and the types. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(await main());
}
