/**
 * Has anyone who is not us started using this?
 *
 *     node --experimental-strip-types ops/first-contact.ts
 *     node --experimental-strip-types ops/first-contact.ts --quiet   # cron
 *
 * ## Why this needs to be a program
 *
 * Every agent on this site was built here, every payment so far has been one of
 * ours paying another, and the whole project is now waiting on a stranger. That
 * is a thing you can wait for badly — checking npm on a whim, noticing a
 * GitHub star weeks late — or a thing you can be told about.
 *
 * The failure it guards against is specific and has already happened twice in
 * this repository: a signal nobody was watching. The hosted vendor was down for
 * days and was found by a payment failing. The daily buy was uninstalled and
 * was found by someone reading a log that did not exist. "We will notice" is
 * not a plan, it is a hope with a cron job's job.
 *
 * ## Three signals, weakest to strongest
 *
 * **npm downloads.** Somebody ran `npm install`. Noisy: mirrors, caches, CI and
 * our own machines all count, and a jump of three means nothing. It is a
 * leading indicator with a bad signal-to-noise ratio, which is exactly what a
 * leading indicator is.
 *
 * **GitHub stars and forks.** Attention, not use. A star is somebody deciding
 * to look later. Worth knowing, worth not celebrating.
 *
 * **A payment at the demo vendor we cannot account for.** This is the one that
 * matters. `/start` walks a stranger to a real HTTP 402 purchase against
 * warda-demo-api.vercel.app, so somebody finishing that tutorial ends by
 * sending us money from an address we have never seen. Every coin our own
 * agents put there is in a purchase log with its transaction id; anything at
 * that address which is in no log, and appeared after this tool first ran, was
 * put there by somebody else.
 *
 * ## The baseline is seeded, deliberately
 *
 * On the first run, everything already at those addresses is recorded as known
 * and nothing is reported. That is not hiding anything — a demo run from before
 * this existed is genuinely not a stranger, and a tool that cried first-contact
 * over our own history would be ignored inside a week. Only what arrives AFTER
 * the baseline can be new.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NodeClient, toHex } from "@warda_protocol/kaspa";
import { formatKas } from "@warda_protocol/core";
import { rpcFrom } from "../sdk/tools/network.ts";

const repo = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));
const quiet = process.argv.includes("--quiet");
const STATE = repo("ops/first-contact.json");

const PACKAGES = [
  "@warda_protocol/core",
  "@warda_protocol/kaspa",
  "@warda_protocol/mcp",
  "@warda_protocol/x402",
  "@warda_protocol/cli",
];

/** Where a stranger's money would land: the demo vendor, and agent #001. */
const WATCHED = [
  "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4",
  "kaspatest:qq7xj0mpl0p46875mnkzhwatdy478pjkum745srhaey44l9jx566zefjaam3e",
];

interface State {
  firstRun: string;
  /**
   * Whether the baseline was taken with a node attached.
   *
   * Learned by writing this file: the first run happened somewhere without a
   * node, recorded ZERO known coins, and would have reported every coin already
   * at those addresses as a stranger the moment it next ran properly. A
   * baseline seeded blind is not a baseline, it is a guaranteed false alarm —
   * and a first-contact tool that cries wolf once is a tool nobody opens again.
   *
   * So a run without a node reports what it can, keeps whatever baseline it
   * already had, and refuses to claim it has one.
   */
  baselineComplete: boolean;
  knownTxids: string[];
  npm: Record<string, number>;
  github: { stars: number; forks: number };
}
const prior: State | null = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;

const say = (s = "") => { if (!quiet) console.log(s); };
const alert: string[] = [];

// ── every transaction id our own agents have ever recorded ──────────────────
/* Read from the logs rather than from a list kept here. A hardcoded set of our
   own txids is a set that stops being complete the next time an agent buys
   something, and the failure would be a false first-contact alert — the one
   kind of wrong that makes the whole tool worthless. */
const ours = new Set<string>();
for (const dir of readdirSync(repo(".")).filter((d) => d.startsWith("agent-"))) {
  const p = repo(`${dir}/purchases`);
  if (!existsSync(p)) continue;
  for (const f of readdirSync(p).filter((f) => f.endsWith(".json"))) {
    try {
      const r = JSON.parse(readFileSync(`${p}/${f}`, "utf8"));
      if (r.txid) ours.add(String(r.txid));
    } catch { /* a half-written receipt is not a stranger */ }
  }
}

// ── 1. npm ──────────────────────────────────────────────────────────────────
const npm: Record<string, number> = {};
for (const pkg of PACKAGES) {
  try {
    const r = await fetch(`https://api.npmjs.org/downloads/point/last-week/${pkg}`);
    npm[pkg] = r.ok ? ((await r.json()) as { downloads?: number }).downloads ?? 0 : 0;
  } catch { npm[pkg] = prior?.npm[pkg] ?? 0; }
}
const npmTotal = Object.values(npm).reduce((a, b) => a + b, 0);
const npmWas = prior ? Object.values(prior.npm).reduce((a, b) => a + b, 0) : null;

// ── 2. GitHub ───────────────────────────────────────────────────────────────
let github = prior?.github ?? { stars: 0, forks: 0 };
try {
  const r = await fetch("https://api.github.com/repos/ArtyKOMarkets/warda");
  if (r.ok) {
    const d = (await r.json()) as { stargazers_count: number; forks_count: number };
    github = { stars: d.stargazers_count, forks: d.forks_count };
  }
} catch { /* keep the last reading */ }

// ── 3. the one that counts ──────────────────────────────────────────────────
const haveBaseline = prior?.baselineComplete === true;

const url = rpcFrom(undefined);
const seen = new Set(prior?.knownTxids ?? []);
const strangers: { txid: string; value: bigint; address: string }[] = [];
let checkedChain = false;

if (url) {
  const client = await NodeClient.connect({ url });
  try {
    for (const address of WATCHED) {
      for (const u of await client.getUtxosByAddresses([address])) {
        const txid = toHex(u.outpoint.transactionId);
        seen.add(txid);
        if (haveBaseline && !prior!.knownTxids.includes(txid) && !ours.has(txid)) {
          strangers.push({ txid, value: u.entry.value, address });
        }
      }
    }
    checkedChain = true;
  } finally { client.close(); }
}

// ── report ──────────────────────────────────────────────────────────────────
if (!haveBaseline) {
  say(checkedChain
    ? "\nBaseline recorded. Reporting nothing this run, by design.\n"
    : "\nNo node, so NO baseline was taken — the chain was not read.\n" +
      "Run this again with node.env sourced before trusting any later alert.\n");
  say(checkedChain
    ? `  ${seen.size} coin(s) already at the watched addresses — ours, by definition.`
    : "  The coins already at those addresses were not read, so none are known yet.");
  say(`  npm last week: ${npmTotal}   ·   stars: ${github.stars}   ·   forks: ${github.forks}`);
  say("\n  From now on, only what ARRIVES is news.\n");
} else {
  const dNpm = npmWas === null ? 0 : npmTotal - npmWas;
  const dStar = github.stars - prior.github.stars;

  if (strangers.length) {
    const lines = strangers.map(
      (s) => `    ${formatKas(s.value)} KAS  ${s.txid.slice(0, 16)}…  at ${s.address.slice(0, 22)}…`,
    );
    alert.push(
      "SOMEBODY WHO IS NOT US PAID THE DEMO VENDOR.\n\n" +
        lines.join("\n") +
        "\n\n  No agent here has that transaction id in its purchase log. Either a\n" +
        "  stranger finished /start, or one of ours paid without recording it —\n" +
        "  check before you celebrate, then go and find out who they are.",
    );
  }
  if (dStar > 0) alert.push(`${dStar} new GitHub star(s) — ${github.stars} total.`);
  if (dNpm > 20) alert.push(`npm downloads up ${dNpm} on last week (${npmTotal}). Mirrors and CI count; treat as weather.`);

  if (alert.length) {
    console.log("\n" + alert.join("\n\n") + "\n");
  } else {
    say(`\nnothing new · npm ${npmTotal} (${dNpm >= 0 ? "+" : ""}${dNpm}) · stars ${github.stars} · ` +
        `${checkedChain ? "chain checked" : "NO NODE — the signal that matters was not read"}\n`);
  }
  if (!checkedChain) {
    console.error("warning: no node, so the only signal that would prove use was not checked.");
  }
}

mkdirSync(repo("ops"), { recursive: true });
writeFileSync(
  STATE,
  JSON.stringify(
    {
      firstRun: prior?.firstRun ?? new Date().toISOString(),
      baselineComplete: haveBaseline || checkedChain,
      knownTxids: checkedChain ? [...seen] : (prior?.knownTxids ?? []),
      npm,
      github,
    },
    null, 2,
  ) + "\n",
);
process.exit(alert.length && strangers.length ? 10 : 0);
