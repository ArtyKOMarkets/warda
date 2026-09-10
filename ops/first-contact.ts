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
  "@warda_protocol/verify",
  /* The seller's half, and the one a reader is most likely to install
     WITHOUT ever appearing in any of the other signals here: somebody
     who takes payments does not clone this repo, does not create a
     grant, and never sends us a coin. Missing from this list, they are
     invisible. */
  "@warda_protocol/vendor",
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
  published?: Record<string, boolean>;
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
/**
 * An unpublished package is not a package with no downloads.
 *
 * `@warda_protocol/cli` read 0 and was taken for "nobody wanted it". It has
 * never been published — the registry answers 404 — and so did `verify`. The
 * downloads API returns nothing for both, and the first version of this file
 * turned that nothing into a zero and put it in a table beside real figures.
 *
 * Which is this project's oldest mistake in a new place: an absence rendered as
 * a measurement. An empty grant address that might mean drained or moved; a
 * cron log that does not exist versus one that is empty; a node that answers
 * "no utxos" because it has no index. Same shape every time, and it is always
 * the reading you would act on.
 */
const npm: Record<string, number> = {};
const published: Record<string, boolean> = {};
for (const pkg of PACKAGES) {
  try {
    const reg = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}`, {
      method: "HEAD",
    });
    published[pkg] = reg.ok;
  } catch { published[pkg] = prior?.published?.[pkg] ?? true; }

  if (!published[pkg]) { npm[pkg] = 0; continue; }
  try {
    const r = await fetch(`https://api.npmjs.org/downloads/point/last-week/${pkg}`);
    npm[pkg] = r.ok ? ((await r.json()) as { downloads?: number }).downloads ?? 0 : 0;
  } catch { npm[pkg] = prior?.npm[pkg] ?? 0; }
}
const npmLive = PACKAGES.filter((p) => published[p]);

/**
 * Whether these downloads could be real installs at all.
 *
 * `core` and `kaspa` are dependencies of `mcp`: every genuine `mcp` install
 * pulls both. So real adoption cannot produce a `mcp` figure LARGER than
 * either of them — and on 9 September it did, 558 against 315 and 325. That is
 * not a close call to interpret, it is an arithmetic contradiction, and it
 * means the numbers are mirrors and registry crawlers rather than people.
 *
 * Stated as a computed check rather than a caveat in prose, because a caveat
 * under a big number is read as modesty and ignored.
 */
const dl = (p: string) => npm[p] ?? 0;
/* Both dependants, checked the same way: mcp needs core AND kaspa, vendor
   needs kaspa. Either exceeding what it depends on is the same arithmetic
   contradiction, and vendor is the one being posted about — so it is the one
   most likely to show a number worth misreading. */
const impossible =
  dl("@warda_protocol/mcp") > Math.min(dl("@warda_protocol/core"), dl("@warda_protocol/kaspa")) ||
  dl("@warda_protocol/vendor") > dl("@warda_protocol/kaspa");
const npmTotal = npmLive.reduce((a, p) => a + (npm[p] ?? 0), 0);
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

/**
 * The dashboard, written at the end of every run.
 *
 * Self-contained and inlined — no fetch, no server, opens from disk. A usage
 * page that needs something running to show you a zero is a page you will not
 * open, and the whole point of this file is that the answer arrives without
 * anyone remembering to look.
 *
 * The headline is the only number that means USE. npm and GitHub are above it
 * in the funnel and below it in truth: an install can be a mirror, a star is
 * somebody deciding to read this later. Only a coin at the demo vendor that no
 * purchase log accounts for is somebody actually spending through the protocol.
 */
const esc = (v: unknown) => String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const delta = (now: number, was: number | null) =>
  was === null ? "" : `<span class="d ${now > was ? "up" : ""}">${now - was >= 0 ? "+" : ""}${now - was}</span>`;

function writePage(path: string) {
  const strangerRows = strangers.length
    ? strangers.map((x) => `<tr><td class="k">${formatKas(x.value)} KAS</td>` +
        `<td class="mono">${esc(x.txid.slice(0, 24))}…</td>` +
        `<td class="mono dim">${esc(x.address.slice(0, 26))}…</td></tr>`).join("")
    : "";

  const npmRows = PACKAGES.map((pkg) =>
    published[pkg]
      ? `<tr><td class="mono">${esc(pkg)}</td><td class="n">${npm[pkg] ?? 0}` +
        `${delta(npm[pkg] ?? 0, prior ? prior.npm[pkg] ?? 0 : null)}</td></tr>`
      : `<tr><td class="mono dim">${esc(pkg)}</td>` +
        `<td class="n dim">not published</td></tr>`).join("");

  const html = `<!doctype html><meta charset="utf-8"><title>Warda — is anyone using this?</title>
<style>
  :root{--void:#06090C;--panel:#101A20;--edge:#1E2E37;--edge-b:#2C4350;
    --chrome:#DDE0E2;--dim:#8D989E;--faint:#5D6B73;--teal:#14D7C1;--refuse:#FF6B5A;
    --mono:ui-monospace,Menlo,monospace;--sans:system-ui,sans-serif}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--void);color:var(--chrome);font-family:var(--sans);
    padding:clamp(1.5rem,5vw,4rem);line-height:1.6}
  .wrap{max-width:60rem;margin:0 auto}
  .eyebrow{font-family:var(--mono);font-size:.72rem;letter-spacing:.22em;color:var(--teal);
    text-transform:uppercase}
  h1{font-size:clamp(1.6rem,4vw,2.4rem);margin:.7rem 0 0;font-weight:600;letter-spacing:-.02em}
  .hero{border:1px solid var(--edge-b);border-radius:4px;background:var(--panel);
    padding:clamp(1.4rem,4vw,2.2rem);margin-top:1.8rem}
  .big{font-size:clamp(3rem,11vw,5.5rem);line-height:1;font-weight:700;
    color:${'${strangers.length ? "var(--teal)" : "var(--faint)"}'}}
  .heroL{font-family:var(--mono);font-size:.78rem;letter-spacing:.16em;color:var(--faint);
    text-transform:uppercase}
  .heroS{margin-top:1rem;color:var(--dim);max-width:58ch}
  h2{font-family:var(--mono);font-size:.72rem;letter-spacing:.2em;color:var(--faint);
    text-transform:uppercase;margin:2.4rem 0 .8rem;font-weight:400}
  table{width:100%;border-collapse:collapse}
  td{padding:.55rem 0;border-bottom:1px solid rgba(30,46,55,.6);font-size:.92rem}
  tr:last-child td{border-bottom:0}
  .mono{font-family:var(--mono);font-size:.8rem}
  .dim{color:var(--faint)} .n{text-align:right;font-family:var(--mono)}
  .k{font-family:var(--mono);color:var(--teal)}
  .d{margin-left:.7rem;color:var(--faint);font-size:.78rem}
  .d.up{color:var(--teal)}
  .note{margin-top:2.6rem;padding-top:1.2rem;border-top:1px solid var(--edge);
    color:var(--dim);font-size:.88rem;max-width:64ch}
  .warn{color:var(--refuse)}
</style>
<div class="wrap">
  <p class="eyebrow">Warda &middot; ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC</p>
  <h1>Is anyone using this?</h1>

  <div class="hero">
    <p class="heroL">Payments from someone who is not us</p>
    <p class="big">${strangers.length}</p>
    <p class="heroS">${strangers.length
      ? "A coin arrived at the demo vendor that no purchase log here accounts for. Check it before celebrating — then go and find out who they are."
      : "The only number that means <em>use</em>. /start ends a stranger at a real 402 purchase against our vendor, so the first one to finish it pays us from an address we have never seen."}</p>
    ${strangerRows ? `<table style="margin-top:1.2rem">${strangerRows}</table>` : ""}
  </div>

  <h2>npm — last week ${impossible ? '<span class="warn">· not real installs</span>' : ""}</h2>
  ${impossible ? `<p class="note" style="margin:0 0 .8rem;padding:0;border:0">
    <strong>These cannot be people.</strong> core and kaspa are dependencies of mcp, so every
    real mcp install pulls both — yet mcp reads higher than either. That is an arithmetic
    contradiction, not a close call: the traffic is mirrors and registry crawlers.
  </p>` : ""}
  <table>${npmRows}<tr><td><strong>total</strong></td><td class="n"><strong>${npmTotal}</strong>${delta(npmTotal, npmWas)}</td></tr></table>

  <h2>GitHub</h2>
  <table>
    <tr><td>stars</td><td class="n">${github.stars}${delta(github.stars, prior ? prior.github.stars : null)}</td></tr>
    <tr><td>forks</td><td class="n">${github.forks}${delta(github.forks, prior ? prior.github.forks : null)}</td></tr>
  </table>

  <p class="note">
    ${checkedChain
      ? "Chain read with a node attached."
      : '<span class="warn">No node this run — the signal that proves use was not read.</span>'}
    Baseline ${haveBaseline || checkedChain ? `taken ${esc((prior?.firstRun ?? new Date().toISOString()).slice(0, 10))}` : "<span class=\"warn\">NOT TAKEN</span>"};
    only coins arriving after it can count.
    npm counts mirrors, caches and CI, so treat a jump of three as weather. A star
    is attention, not use.
  </p>
</div>`;
  writeFileSync(path, html);
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
      published,
      github,
    },
    null, 2,
  ) + "\n",
);
writePage(repo("ops/usage.html"));

/* The data the PUBLIC page would read, written now and published by nothing.
   See site/src/usage.html for the two lines that turn it on, and the third
   that must go with them. */
writeFileSync(
  repo("site/src/usage.json"),
  JSON.stringify(
    {
      _comment:
        "Written by ops/first-contact.ts. NOT PUBLISHED — see site/src/usage.html. " +
        "`notUs` is the only figure here that means use.",
      checkedAt: new Date().toISOString(),
      chainChecked: checkedChain,
      baselineTaken: haveBaseline || checkedChain,
      notUs: strangers.length,
      npm: npmTotal,
      stars: github.stars,
    },
    null, 2,
  ) + "\n",
);
say(`  dashboard: ops/usage.html`);

process.exit(alert.length && strangers.length ? 10 : 0);
