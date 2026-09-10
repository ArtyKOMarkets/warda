#!/usr/bin/env -S node --experimental-strip-types
/**
 * `warda` — one short command for the whole life of a grant.
 *
 * This adds no capability. Every verb here spawns a tool that already existed
 * under sdk/tools or agents/tools, and the protocol rules are still computed
 * in exactly one place. What it adds is the thing a developer meets first:
 *
 *   node --experimental-strip-types sdk/tools/quickstart.ts --recipients payees.txt \
 *     --budget 1000000000 --max-per-spend 100000000 --rpc wss://…
 *
 * becomes
 *
 *   warda grant --payees payees.txt --budget 10 --max-per-spend 1
 *
 * Three things change, and each of them was a real place people fell off:
 *
 *   1. KAS, not sompi. `--budget 1000000000` is a number nobody can check by
 *      eye, and the failure mode of getting it wrong by a factor of ten is a
 *      grant that is silently ten times too permissive.
 *   2. The grant is remembered. `.warda/config.json` records which manifest,
 *      which allowlist, and which agent key belong together, so `warda pay`
 *      needs a URL and nothing else. Passing the wrong --grant to a shared
 *      buy.ts spends a grant you did not mean to spend; this removes the
 *      opportunity rather than documenting it.
 *   3. The agent key is read from the file it lives in, not exported into a
 *      shell where it stays in history. It is passed to the child process and
 *      nowhere else. This CLI never sends a key anywhere, never stores one it
 *      was not given a path to, and holds no coin of yours: there is no
 *      account here to be a custodian of.
 *
 * ## This is not a wallet, and the difference is the product
 *
 * A wallet holds a key and asks software to check the limits before it signs.
 * A grant is an address whose *unlocking script* carries the limits, so the
 * limits are checked by the network on every spend, by nodes that have never
 * heard of this file. `warda pay` to an address that is not on the allowlist
 * does not fail a check here — there is no valid transaction to build. That is
 * why the refusal in `warda help` is worth reading before anything else.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { kas, formatKas } from "@warda_protocol/core";

/* Where this file is decides where its tools are, and there are exactly two
   places it is ever run from.
   
   In the repo it is TypeScript at cli/warda.ts and the tools are TypeScript at
   ../sdk/tools and ../agents/tools — nothing is built, so a stale dist can
   never quietly serve yesterday's covenant rules.
   
   Installed from npm there is no repo above it: `files` cannot reach outside a
   package directory, so the published artifact is cli/build.mjs's bundle —
   dist/warda.js beside dist/tools/*.js, each carrying the SDK source it uses.
   Published without this seam, every subcommand would have gone looking for
   node_modules/@warda_protocol/sdk/tools/*.ts and failed with ENOENT.
   
   The extension of THIS module is the tell, for the same reason it is in
   quickstart: a build-time constant would be a second thing to keep true. */
const BUNDLED = import.meta.url.endsWith(".js");
const repo = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));
const STRIP = "--experimental-strip-types";

/** The script to run for a repo-relative tool path, wherever we are. */
const toolPath = (script: string): string =>
  BUNDLED
    ? fileURLToPath(
        new URL("tools/" + script.slice(script.lastIndexOf("/") + 1).replace(/\.ts$/, ".js"),
                import.meta.url),
      )
    : repo(script);

const argv = process.argv.slice(2);
const verb = argv[0];
const rest = argv.slice(1);

const flag = (n: string, d?: string): string | undefined => {
  const i = rest.indexOf(`--${n}`);
  const v = i >= 0 ? rest[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};
const has = (n: string) => rest.includes(`--${n}`);
/* Explicitly annotated, not merely returning `never`. TypeScript narrows past
   a call like this only when the variable carries the signature itself, so
   without the annotation every `die(...)` guard below leaves the thing it just
   guarded still possibly-undefined — and the fix that suggests itself is a
   scattering of `!`, which is the same guard written where it cannot be
   checked. */
const die: (msg: string, code?: number) => never = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

/* ── the remembered grant ────────────────────────────────────────────────────
   Written by `warda grant`, read by everything after it. Deliberately in the
   working directory and not $HOME: a machine that runs two agents has two
   grants, and a config in $HOME would make the second one silently spend the
   first one's budget. */
const CONFIG = ".warda/config.json";
interface Config {
  id?: string;
  grant?: string;
  payees?: string;
  agentKey?: string;
  purchases?: string;
  rpc?: string;
}
const readConfig = (): Config =>
  existsSync(CONFIG) ? (JSON.parse(readFileSync(CONFIG, "utf8")) as Config) : {};
const writeConfig = (c: Config) => {
  mkdirSync(".warda", { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
};

/** KAS in, sompi out. Accepts "10", "0.04", "10kas", "1000000000sompi". */
const sompi = (v: string, what: string): string => {
  const s = v.trim().toLowerCase();
  if (s.endsWith("sompi")) {
    const n = s.slice(0, -5).trim();
    if (!/^\d+$/.test(n)) die(`${what}: "${v}" is not a whole number of sompi.`);
    return n;
  }
  try {
    return kas(s.replace(/kas$/, "").trim()).toString();
  } catch (e) {
    return die(`${what}: ${(e as Error).message}\n  Amounts here are KAS: --${what} 10, or 0.04.`);
  }
};

const run = (script: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(process.execPath, [...(BUNDLED ? [] : [STRIP]), toolPath(script), ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return r.status ?? 1;
};

/** The rpc to use: an explicit flag, then the remembered one, then the env. */
const rpcArgs = (cfg: Config): string[] => {
  const url = flag("rpc") ?? cfg.rpc ?? process.env.WARDA_RPC_JSON;
  return url ? ["--rpc", url] : [];
};

/** The agent's key, read from the file that holds it and handed to one child. */
const agentSecret = (cfg: Config): string => {
  if (process.env.WARDA_SK) return process.env.WARDA_SK.trim();
  const path = flag("key") ?? cfg.agentKey;
  if (!path || !existsSync(path)) {
    die(
      "no agent key.\n" +
        "  `warda grant` writes one to agent.key and remembers it. If you have one\n" +
        "  already, point at it with --key <file>, or set WARDA_SK.",
    );
  }
  return readFileSync(path!, "utf8").trim();
};

const HELP = `warda — bounded spending authority for an agent, on Kaspa.

  warda node                    is a node worth believing? (run this first)
  warda key      [--out f.key]  a new keypair, and its address
  warda wallet   [consolidate]  an ordinary key: what it holds, what it can fund
  warda grant    --payees <f>   create a grant. Limits in KAS.
                                [--budget 10] [--max-per-spend 1] [--epoch-limit 2]
                                [--key <funder.key>, or set WARDA_SK]
  warda balance                 what may this agent spend right now?
  warda pay      <url>          buy something behind an HTTP 402
                                [--data <json|@file>] POST it, when the price
                                is of the work rather than of the URL
  warda activity                every attempt, refusals included
  warda find                    the grant moved. Where is it now?
  warda which-key --address <a> [paths…]   which file holds the key for it?
  warda mcp                     serve the grant over MCP (stdio)

Everything after \`warda grant\` remembers the grant, the allowlist and the key
in .warda/config.json, so it needs no flags. Override any of them per command.

The whole thing, from nothing:

  $ warda key --out wallet.key            # fund this address from a faucet
  $ echo kaspatest:qqtw…twam4 > payees.txt
  $ WARDA_SK=$(cat wallet.key) warda grant --payees payees.txt --budget 10 --max-per-spend 1
  ✔ grant    grant.json      budget 10 KAS · max 1 KAS/payment · 1 payee
  ✔ agent    agent.key       0600, and it is the agent's whole authority
  $ warda pay https://warda-demo-api.vercel.app/fact
  ✔ paid 0.04 KAS · 200 · fa7ad66b…
  $ warda pay https://somewhere-else.example/thing
  ✗ that payee is not on this grant's allowlist. No valid transaction exists —
    not one the network would reject. There is nothing to sign.

That last refusal is the product. It is not a check this CLI performs.`;

switch (verb) {
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;

  case "version":
  case "--version":
    /* Beside this file in the repo (cli/package.json), one level up from the
       bundle (dist/warda.js -> the package root). Reported wrong, this is the
       number somebody quotes in a bug report. */
    console.log(
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL(BUNDLED ? "../package.json" : "package.json", import.meta.url)),
          "utf8",
        ),
      ).version,
    );
    break;

  case "node": {
    const cfg = readConfig();
    const grant = flag("grant") ?? cfg.grant;
    process.exit(
      run("sdk/tools/check-node.ts", [
        ...rpcArgs(cfg),
        ...(grant && existsSync(grant) ? ["--grant", grant] : []),
        ...rest.filter((a) => a.startsWith("--resolver")),
      ]),
    );
    break;
  }

  case "key": {
    const out = flag("out");
    process.exit(
      run("sdk/tools/new-key.ts", [
        "--label",
        flag("label", "wallet")!,
        ...(out ? ["--out", out] : []),
        /* new-key resolves a prefix and a network together and refuses the
           pair when they disagree. Not forwarding these meant `warda key
           --prefix kaspa` silently produced a TESTNET address — the one
           failure that guard exists to prevent, reintroduced by the wrapper
           that was supposed to expose it. Funding that address is money sent
           to a chain nobody is watching. */
        ...(flag("prefix") ? ["--prefix", flag("prefix")!] : []),
        ...(flag("network") ? ["--network", flag("network")!] : []),
      ]),
    );
    break;
  }

  /* The wallet and the grant are different things and this is the seam between
     them. A wallet is an ordinary key with nothing bounding it — the funder
     before a grant exists, and where an agent's earnings arrive after one
     spends. Everything below `grant` is bounded; this verb is not, and says
     so every time it runs. */
  case "wallet": {
    const cfg = readConfig();
    const sub = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    if (sub && sub !== "consolidate") {
      die(`warda wallet [consolidate]   — unknown subcommand: ${sub}`, 2);
    }
    /* The FUNDER key, which is not the agent key the config remembers. Naming
       the wrong one here would consolidate a grant's agent key instead, and
       the two files sit side by side in the same directory. */
    const key = flag("key") ?? (existsSync("wallet.key") ? "wallet.key" : undefined);
    if (!key && !process.env.WARDA_SK) {
      die(
        "no wallet key.\n" +
          "  `warda key --out wallet.key` makes one, or pass --key <file>.\n" +
          "  This is the funder's key, not the agent's — " +
          (cfg.agentKey ? `not ${cfg.agentKey}.` : "they are different keys."),
      );
    }
    process.exit(
      run(
        sub === "consolidate" ? "sdk/tools/consolidate.ts" : "sdk/tools/wallet.ts",
        [
          ...(key ? ["--key", key] : []),
          ...rpcArgs(cfg),
          ...(has("submit") ? ["--submit"] : []),
          ...(has("force") ? ["--force"] : []),
          ...(has("json") ? ["--json"] : []),
          ...(flag("max-inputs") ? ["--max-inputs", flag("max-inputs")!] : []),
          ...(flag("fee") ? ["--fee", flag("fee")!] : []),
          ...(flag("prefix") ? ["--prefix", flag("prefix")!] : []),
        ],
      ),
    );
    break;
  }

  case "grant": {
    const payees = flag("payees") ?? flag("recipients");
    if (!payees) {
      die(
        "warda grant --payees <file>\n\n" +
          "  One address per line — the complete set this agent may ever pay. It is\n" +
          "  compiled into the script that unlocks the coin at creation and cannot be\n" +
          "  changed afterwards, so this file is not a config: it is the authority.\n" +
          "  Keep it. A grant commits to the list's root, and a root cannot produce\n" +
          "  the proof a spend needs — lose it and the grant can be revoked, never spent.",
        2,
      );
    }
    if (!existsSync(payees!)) die(`--payees: no such file: ${payees}`, 2);

    const out = flag("out", "grant.json")!;
    const agentOut = flag("agent-out", "agent.key")!;
    const cfg = readConfig();

    /**
     * The FUNDER's key, by path rather than only through the environment.
     *
     * This is what closes the loop for an agent that earns. Money arriving from
     * a sale lands at an ordinary key — agent #001's digest income does — and
     * that key can fund a grant directly; there is no need to move it anywhere
     * first. `warda wallet` counts it, `warda wallet consolidate` merges it
     * past genesis's one-input rule, and this bounds it. Requiring the key to
     * be exported into the shell to do that last step left the loop looking
     * open when it was not.
     */
    const funder = flag("key");
    const funderEnv: NodeJS.ProcessEnv = funder
      ? { WARDA_SK: readFileSync(funder, "utf8").trim() }
      : {};

    const status = run("sdk/tools/quickstart.ts", [
      "--recipients",
      payees!,
      "--budget",
      sompi(flag("budget", "10")!, "budget"),
      "--max-per-spend",
      sompi(flag("max-per-spend", "1")!, "max-per-spend"),
      "--epoch-limit",
      sompi(flag("epoch-limit", "2")!, "epoch-limit"),
      "--out",
      out,
      "--agent-out",
      agentOut,
      ...(flag("prefix") ? ["--prefix", flag("prefix")!] : []),
      ...(flag("network") ? ["--network", flag("network")!] : []),
      ...rpcArgs(cfg),
    ], funderEnv);
    if (status !== 0) process.exit(status);

    writeConfig({
      ...cfg,
      id: flag("id", cfg.id ?? "MY-AGENT")!,
      grant: out,
      payees: payees!,
      agentKey: agentOut,
      purchases: flag("purchases", cfg.purchases ?? "purchases")!,
      rpc: flag("rpc") ?? cfg.rpc,
    });
    console.error(`Remembered in ${CONFIG}. \`warda pay <url>\` now needs no flags.`);
    break;
  }

  case "balance": {
    const cfg = readConfig();
    const path = rest.find((a) => a.endsWith(".json")) ?? cfg.grant;
    if (!path || !existsSync(path)) {
      die("no grant. Create one with `warda grant --payees <file>`, or pass a manifest path.");
    }
    const m = JSON.parse(readFileSync(path!, "utf8"));

    /* The epoch a grant is in is a function of the chain's height, so a
       balance without a node can report the limits but not the headroom.
       It says which one it is rather than printing a number it cannot stand
       behind — an epoch figure from a stale height is the kind of wrong that
       looks right. */
    let daa: bigint | null = null;
    const url = flag("rpc") ?? cfg.rpc ?? process.env.WARDA_RPC_JSON;
    if (url) {
      const { NodeClient } = await import("@warda_protocol/kaspa");
      try {
        const client = await NodeClient.connect({ url });
        try {
          daa = (await client.getBlockDagInfo()).virtualDaaScore;
        } finally {
          client.close();
        }
      } catch (e) {
        console.error(`(no node: ${(e as Error).message})\n`);
      }
    }

    const B = (k: string) => BigInt(m[k] ?? 0);
    const budget = B("budget");
    const spent = B("spent_total");
    const reserved = B("reserved");
    const remaining = budget - spent - reserved;
    const epochLen = B("epoch_length");
    const notBefore = B("not_before");
    const epochNow = daa !== null && daa >= notBefore ? (daa - notBefore) / epochLen : null;
    const epochSpent = epochNow !== null && epochNow === B("epoch_index") ? B("epoch_spent") : 0n;
    const epochLeft = B("epoch_limit") - epochSpent;
    const largest =
      epochNow === null
        ? null
        : [remaining, epochLeft, B("max_per_spend")].reduce((a, b) => (a < b ? a : b));

    const payees = cfg.payees && existsSync(cfg.payees)
      ? readFileSync(cfg.payees, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean)
      : [];

    const line = (k: string, v: string) => console.log(`  ${k.padEnd(16)}${v}`);
    console.log(`\n${cfg.id ?? "agent"}    ${path}\n`);
    line("budget left", `${formatKas(remaining > 0n ? remaining : 0n)} KAS of ${formatKas(budget)}`);
    line("per payment", `${formatKas(B("max_per_spend"))} KAS`);
    line(
      "this epoch",
      epochNow === null
        ? `${formatKas(B("epoch_limit"))} KAS every ${epochLen} blocks (needs a node for the current epoch)`
        : `${formatKas(epochLeft > 0n ? epochLeft : 0n)} KAS left of ${formatKas(B("epoch_limit"))}, epoch ${epochNow}`,
    );
    if (largest !== null) {
      line("largest now", `${formatKas(largest > 0n ? largest : 0n)} KAS`);
    }
    line("may pay", payees.length ? `${payees.length} address${payees.length > 1 ? "es" : ""}, fixed at creation` : "the addresses in the allowlist, fixed at creation");
    for (const p of payees.slice(0, 6)) console.log(`  ${" ".repeat(16)}${p}`);
    if (daa !== null) {
      const left = B("expires_at") - daa;
      line("expires", left > 0n ? `in ${left} blocks (~${left / 10n / 60n} min)` : "expired — the balance returns to the principal");
      if (daa < notBefore) line("not before", `${notBefore - daa} blocks to go. Until then every spend is refused.`);
    }
    console.log(
      `\n  These are not settings. They are in the script that unlocks the coin,\n` +
        `  and the network checks them on every spend.\n`,
    );
    break;
  }

  case "pay": {
    const url = rest.find((a) => a.startsWith("http"));
    if (!url) die("warda pay <url>   — the endpoint that answers 402.", 2);
    const cfg = readConfig();
    const grant = flag("grant") ?? cfg.grant;
    const payees = flag("payees") ?? cfg.payees;
    const out = flag("out") ?? cfg.purchases ?? "purchases";
    if (!grant || !payees) {
      die("no grant remembered here. Run `warda grant --payees <file>` first, or pass --grant and --payees.");
    }
    process.exit(
      run(
        "agents/tools/buy.ts",
        [
          url,
          "--id",
          flag("id") ?? cfg.id ?? "MY-AGENT",
          "--grant",
          grant!,
          "--recipients",
          payees!,
          "--out",
          out,
          ...(has("json") ? ["--json"] : []),
          ...(has("expect-refusal") ? ["--expect-refusal"] : []),
          /* A compute endpoint prices the work, so the quote request has to
             carry it. Without this the CLI can only ask vendors whose price is
             a property of the URL. */
          ...(flag("data") ? ["--data", flag("data")!] : []),
          ...(flag("content-type") ? ["--content-type", flag("content-type")!] : []),
          ...rpcArgs(cfg),
        ],
        { WARDA_SK: agentSecret(cfg) },
      ),
    );
    break;
  }

  case "activity": {
    const cfg = readConfig();
    const dir = flag("out") ?? cfg.purchases ?? "purchases";
    if (!existsSync(dir)) die(`nothing yet — ${dir} does not exist. \`warda pay <url>\` writes there.`);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    if (!files.length) die(`nothing yet in ${dir}.`);
    console.log();
    for (const f of files.slice(-Number(flag("n", "20")))) {
      const r = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
      const mark = r.outcome === "bought" ? "✔" : r.outcome === "refused" ? "✗" : "•";
      /* The amount lives under `quoted` because it is what the vendor asked for,
         not what this process decided to pay: a receipt that recorded its own
         intention would agree with itself after a mispayment. */
      const q = r.quoted ?? {};
      const amt = q.amountSompi ? `${formatKas(BigInt(q.amountSompi))} KAS` : "—";
      console.log(
        `  ${mark} ${String(r.at ?? "").slice(0, 19).replace("T", " ")}  ${amt.padStart(10)}  ` +
          `${String(r.outcome ?? "?").padEnd(15)}${r.txid ? String(r.txid).slice(0, 12) + "…  " : ""}${r.url ?? ""}`,
      );
      /* A refusal without its reason is the failure this project keeps meeting:
         an outcome you cannot act on. One line here, the full text in the file. */
      if (r.outcome !== "bought" && (r.reason || r.error)) {
        console.log(`      ${r.reason ?? ""}${r.reason && r.error ? " · " : ""}${String(r.error ?? "").split("\n")[0]}`);
      }
    }
    console.log(`\n  ${files.length} attempt${files.length > 1 ? "s" : ""} in ${dir}. Refusals are recorded too:\n  a purchase log that only records successes is a sales brochure.\n`);
    break;
  }

  case "find": {
    const cfg = readConfig();
    const grant = rest.find((a) => a.endsWith(".json")) ?? cfg.grant;
    if (!grant) die("warda find <grant.json>   — or run it where `warda grant` remembered one.");
    const vendor = flag("vendor") ?? (cfg.payees && existsSync(cfg.payees)
      ? readFileSync(cfg.payees, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean)[0]
      : undefined);
    if (!vendor) die("warda find needs --vendor <address>: a grant is found again through a transaction that spent it.");
    process.exit(
      run("sdk/tools/follow-grant.ts", [
        grant!,
        "--vendor",
        vendor!,
        ...rpcArgs(cfg),
        ...(has("write") ? ["--write"] : []),
      ]),
    );
    break;
  }

  /* A key you cannot find is an agent that is over, and the chain cannot tell
     you which it is: an address whose secret is lost looks exactly like one
     whose secret is safe. Offline, and it reports a PATH — never the secret it
     found. A tool that echoed private keys into a terminal, and from there
     into a shell history, would be a worse problem than the one it solves. */
  case "which-key":
    process.exit(run("sdk/tools/which-key.ts", rest));
    break;

  /* Not bundled with the tools above. The MCP server is its own published
     package with its own protocol surface and its own version, and an agent
     framework that asks for `warda mcp` should get the server it would have
     got from @warda_protocol/mcp directly — not a copy frozen into whichever
     CLI happens to be installed. So: the repo runs it from source, and the
     package resolves the real dependency and runs its bin. */
  case "mcp": {
    if (!BUNDLED) process.exit(run("mcp/src/server.ts", rest));
    let bin: string;
    try {
      bin = fileURLToPath(
        new URL("dist/server.js", pathToFileURL(
          createRequire(import.meta.url).resolve("@warda_protocol/mcp/package.json"),
        )),
      );
    } catch {
      die(
        "the MCP server is not installed.\n" +
          "  It ships separately, because it versions separately:\n" +
          "    npm install @warda_protocol/mcp",
        2,
      );
    }
    const r = spawnSync(process.execPath, [bin, ...rest], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  default:
    die(`unknown command: ${verb}\n\n${HELP}`, 2);
}
