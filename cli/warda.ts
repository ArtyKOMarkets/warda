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
  /**
   * "borsh" to reach the chain through a public resolver instead of a node.
   *
   * Remembered rather than asked each time, because it is a decision about
   * whose node you believe — made once, deliberately, by `warda node --borsh`.
   */
  transport?: "json" | "borsh";
}
const readConfig = (): Config =>
  existsSync(CONFIG) ? (JSON.parse(readFileSync(CONFIG, "utf8")) as Config) : {};
const writeConfig = (c: Config) => {
  mkdirSync(".warda", { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
};

/**
 * Days in, blocks out. Kaspa is ten blocks a second.
 *
 * Validated rather than coerced: `--days thirty` through `Number()` is `NaN`,
 * `Math.round(NaN)` is `NaN`, and `"NaN"` reaches genesis as a term. Genesis
 * would refuse it, but the message would be about a window rather than about
 * the word the person actually typed.
 */
const days = (v: string): number => {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) die(`--days: "${v}" is not a number of days above zero.`, 2);
  return Math.round(n * 24 * 60 * 60 * 10);
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

/**
 * How the child reaches the chain: an explicit flag, then the remembered one,
 * then the env — or `--borsh`, which needs no node at all.
 *
 * `--borsh` is forwarded rather than translated. The tools decide what it
 * means; this only has to stop swallowing it, which is what a fixed list of
 * forwarded flags would have done.
 */
const rpcArgs = (cfg: Config): string[] => {
  const url = flag("rpc") ?? cfg.rpc ?? process.env.WARDA_RPC_JSON;
  /* BOTH, when both are given. --borsh picks the transport; --rpc names an
     endpoint on it, which skips resolver discovery — and that combination is
     the only way through when the resolvers are unreachable. Returning early
     on --borsh dropped the url silently, so the one escape hatch that works
     was reachable from `warda node` and from nowhere else. */
  if (has("borsh") || cfg.transport === "borsh") {
    return flag("rpc") ? ["--borsh", "--rpc", flag("rpc")!] : ["--borsh"];
  }
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

/**
 * `topup.ts` says a successor is due with this, and nothing else does.
 *
 * Deliberately outside the 1-4 range `warda help` documents, where 3 means the
 * covenant refused and 4 means paid and not served. A decision to create
 * something is not one of the protocol's refusals and should never be readable
 * as one.
 */
const TOPUP_DUE = 70;

/**
 * The next path in a numbered series: grant.json -> grant-2.json,
 * grant-006.json -> grant-007.json, and never one that already exists.
 *
 * A top-up writes a NEW manifest and a NEW agent key rather than replacing
 * either. The old manifest is the only description of a grant that may still
 * hold coin and can still be revoked, and an agent key that is replaced leaves
 * the grant naming it spendable by nobody.
 */
const successorPath = (p: string): string => {
  const dot = p.lastIndexOf(".");
  const ext = dot > 0 ? p.slice(dot) : "";
  const stem = dot > 0 ? p.slice(0, dot) : p;
  const numbered = /^(.*?)(\d+)$/.exec(stem);
  const base = numbered ? numbered[1]! : `${stem}-`;
  const width = numbered ? numbered[2]!.length : 1;
  let n = numbered ? Number(numbered[2]) : 1;
  let out: string;
  do {
    n += 1;
    out = `${base}${String(n).padStart(width, "0")}${ext}`;
  } while (existsSync(out));
  return out;
};

const HELP = `warda — bounded spending authority for an agent, on Kaspa.

  warda node     [--borsh]      is a node worth believing? (run this first)
                 [--grant <address>]  also check it reports covenant ids
                                --borsh reaches a public resolver instead, so
                                nothing here needs a kaspad of your own
  warda key      [--out f.key]  a new keypair, and its address
  warda wallet   [consolidate]  an ordinary key: what it holds, what it can fund
  warda fund     --payees <f>   buy a grant with an asset you already hold.
                 --rate <p>     what one KAS costs you, as you traded it. Never
                                fetched: a price this tool went and got would be
                                a number Warda vouches for.
                 [--asset USDC] [--venue Kraken] [--wait]
  warda grant    --payees <f>   create a grant. Limits in KAS.
                 [--relay]      also allow the agent to pay itself, which is
                                what buying from an x402 exact vendor needs
                                [--budget 10] [--max-per-spend 1] [--epoch-limit 2]
                                [--days 30]    how long the grant runs. After
                                that the balance is the principal's to reclaim
                                [--key <funder.key>, or set WARDA_SK]
  warda topup    [--below 1]    the budget is running out. Issue the successor
                                from KAS the funder already holds, with the old
                                grant's limits unless you say otherwise.
                                Below what? Default: its own per-payment cap —
                                under that it cannot make a payment of the size
                                it was authorised for. [--budget 10] [--dry-run]
  warda balance                 what may this agent spend right now?
  warda pay      <url>          buy something behind an HTTP 402
                 [--relay]      required by kaspa-x402 v2 vendors, whose
                                scheme cannot accept a covenant spend
                                [--data <json|@file>] POST it, when the price
                                is of the work rather than of the URL
                                [--signer "<cmd>"] sign in another process, so
                                no secret is ever in a file this reads
                                [--task "<label>"] why it paid, for cost per
                                task in the console. Kept in the purchase log
                                only; never sent to the vendor or the chain
  warda activity                every attempt, refusals included
  warda find                    the grant moved. Where is it now?
  warda revoke   [grant.json]   STOP IT NOW. Signed by the revocation key,
                                available at any moment. [--key <revocation.key>]
  warda reclaim  [grant.json]   the term is over, bring the remainder home.
                                Signed by the principal, after expiry.
  warda fee      relay          what the network charges for a relayed payment.
                                Measured, not estimated — it is the one fee here
                                that cannot be corrected after the fact.
  warda which-key --address <a> [paths…]   which file holds the key for it?
  warda mcp                     serve the grant over MCP (stdio)

Everything after \`warda grant\` remembers the grant, the allowlist and the key
in .warda/config.json, so it needs no flags. Override any of them per command.
\`warda node --borsh\` is remembered the same way, once it has worked.

--borsh needs two optional packages and no node:

  npm install @warda_protocol/borsh @kluster/kaspa-wasm

It does not remove the question of whose node you believe — it answers it on
your behalf, which is why it is a flag you type rather than what happens when
you say nothing. The same four health checks run either way.

The whole thing, from nothing:

  $ warda node --borsh                    # or --rpc ws://127.0.0.1:18210
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
    /* --borsh is honoured for THIS run whether or not it is remembered, so the
       command can be used to try a transport without adopting it. */
    const status = run("sdk/tools/check-node.ts", [
      ...rpcArgs(cfg),
      /* An ADDRESS, never a manifest path. The covenant check probes a UTXO,
         and a grant's address is a function of its state rather than a field
         in the file — so there is nothing here to read it out of, and passing
         the path produced "not a valid Kaspa address" on every run that had a
         grant remembered. The address is printed when the grant is created and
         by `warda find`. */
      ...(grant?.startsWith("kaspa") ? ["--grant", grant] : []),
      ...rest.filter((a) => a.startsWith("--resolver")),
    ]);

    /* Remembered only on SUCCESS, and remembered here rather than in a separate
       command, because `warda node` is where somebody finds out whether a
       transport works for them. The first version wrote the choice before
       running the check — so a --borsh that could not reach a single resolver
       still left every later command defaulting to it, which is how a failed
       experiment becomes the configuration. */
    if (status === 0) {
      if (has("borsh") && cfg.transport !== "borsh") {
        writeConfig({ ...cfg, transport: "borsh" });
        console.error(`\nRemembered in ${CONFIG}: --borsh is now the default here.`);
      } else if (flag("rpc") && cfg.transport === "borsh") {
        writeConfig({ ...cfg, transport: "json", rpc: flag("rpc") });
        console.error(`\nRemembered in ${CONFIG}: back to your own node.`);
      }
    }
    process.exit(status);
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

  /**
   * Buy the grant before bounding it.
   *
   * Two commands' worth of work in one, and deliberately not one command's
   * worth of magic: `fund.ts` prints the two steps nobody here can see, waits
   * for the coin, and then this runs exactly the same quickstart invocation
   * `warda grant` runs. Nothing about the grant is different for having been
   * funded this way, which is the point — the rail ends where the covenant
   * begins.
   */
  case "fund": {
    const payees = flag("payees") ?? flag("recipients");
    if (!payees) {
      die(
        "warda fund --payees <file> --budget <KAS> --rate <price of one KAS>\n\n" +
          "  Same allowlist rules as `warda grant`: one address per line, fixed at\n" +
          "  creation, and it IS the authority rather than a config.",
        2,
      );
    }
    if (!existsSync(payees!)) die(`--payees: no such file: ${payees}`, 2);

    const cfg = readConfig();
    const funder = flag("key");
    const funderEnv: NodeJS.ProcessEnv = funder
      ? { WARDA_SK: readFileSync(funder, "utf8").trim() }
      : {};

    /* The budget plus what genesis reserves for its own fee. Under-asking here
       leaves somebody watching a wait loop that can never finish, holding
       almost exactly the right amount. */
    const budgetSompi = BigInt(sompi(flag("budget", "10")!, "budget"));
    const feeSompi = BigInt(sompi(flag("fee", "0.01")!, "fee"));

    const funded = run("sdk/tools/fund.ts", [
      "--required", String(budgetSompi + feeSompi),
      "--rate", flag("rate") ?? "",
      ...(flag("asset") ? ["--asset", flag("asset")!] : []),
      ...(flag("venue") ? ["--venue", flag("venue")!] : []),
      ...(has("wait") ? ["--wait"] : []),
      ...(flag("prefix") ? ["--prefix", flag("prefix")!] : []),
      ...(flag("network") ? ["--network", flag("network")!] : []),
      ...rpcArgs(cfg),
    ], funderEnv);
    if (funded !== 0) process.exit(funded);
    if (!has("wait")) process.exit(0);

    console.error("\nbounding what arrived…");
    /* Falls through to `grant` ON PURPOSE — through `topup`, whose body is a
       no-op for any verb but its own. Copying quickstart's invocation here
       would be a second place for its arguments to drift, and the whole claim
       of this verb is that the grant it produces is not special. */
  }
  // eslint-disable-next-line no-fallthrough

  /**
   * `warda topup` — the successor, issued from KAS the funder already holds.
   *
   * `warda fund` automates nothing about the rare step on purpose: selling an
   * asset and withdrawing the proceeds needs an exchange key with withdrawal
   * permission, and that key in a cron job is a worse thing to own than the
   * problem it solves. This is the other end, and it is the opposite kind of
   * step — frequent, unattended, and needing no price, no venue and nobody's
   * word for anything. A grant is a fixed budget; an agent that is working
   * runs out of one, always at the least convenient moment.
   *
   * Three things happen here and none of them is new. The manifest is advanced
   * from the chain, because a grant's address moves on every spend and a
   * top-up decided from a stale one either starves a working agent or funds a
   * second grant beside a live one. `topup.ts` then reads what is left and
   * whether the funder's own coins can pay for the next one. If they can, this
   * falls through to `grant` with the predecessor's own limits as the defaults
   * — the same invocation, so a topped-up grant is not a different kind of
   * grant.
   *
   * What it does NOT do is end the predecessor. Revocation is the emergency
   * stop, and its key is worth something precisely because it is not online; a
   * schedule that fires it on the most routine event in an agent's life is
   * that key online, every day. The remainder is named, and ending it is left
   * to a person.
   */
  case "topup": {
    if (verb === "topup") {
      const cfg = readConfig();
      const grant = flag("grant") ?? rest.find((a) => a.endsWith(".json")) ?? cfg.grant;
      if (!grant) {
        die(
          "warda topup — no grant to top up.\n\n" +
            "  Run it where `warda grant` remembered one, or pass --grant <grant.json>.",
        );
      }
      /* Named and missing is a DIFFERENT problem from not named, and saying
         "no grant to top up" for a path that was right there in the command is
         how somebody spends a minute looking for the config instead of at
         their working directory. */
      if (!existsSync(grant)) die(`--grant: no such file: ${grant}`, 2);
      const payees = flag("payees") ?? cfg.payees;
      if (!payees || !existsSync(payees)) {
        die(
          "warda topup needs the allowlist the successor will commit to.\n\n" +
            "  --payees <file>   the same list, or the one it should be now. It is not a\n" +
            "  config: the root of this file is compiled into the new grant, and a grant\n" +
            "  whose list nothing downstream can reproduce is spendable by nobody.",
          2,
        );
      }

      /* Best effort, and its exit code is IGNORED on purpose. Following a grant
         needs a payment still sitting where the covenant put it; a vendor that
         has since moved its coin makes this fail, and that is not a reason to
         refuse — topup.ts checks the manifest against the chain itself and
         refuses there, where the refusal can say which of the two it is. */
      const vendor = readFileSync(payees!, "utf8")
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*$/, "").trim())
        .filter(Boolean)[0];
      if (vendor && !has("no-follow")) {
        console.error("following the grant to where it actually is…");
        run("sdk/tools/follow-grant.ts", [grant!, "--vendor", vendor, "--write", ...rpcArgs(cfg)]);
      }

      const m = JSON.parse(readFileSync(grant!, "utf8"));
      const funderKey = flag("key");
      const funderEnv: NodeJS.ProcessEnv = funderKey
        ? { WARDA_SK: readFileSync(funderKey, "utf8").trim() }
        : {};

      const budgetSompi = flag("budget")
        ? sompi(flag("budget")!, "budget")
        : String(m.budget ?? 0);
      const feeSompi = sompi(flag("fee", "0.01")!, "fee");

      const decided = run(
        "sdk/tools/topup.ts",
        [
          "--grant", grant!,
          "--budget", budgetSompi,
          "--fee", feeSompi,
          ...(flag("below") ? ["--below", sompi(flag("below")!, "below")] : []),
          ...(has("dry-run") ? ["--dry-run"] : []),
          ...(flag("prefix") ? ["--prefix", flag("prefix")!] : []),
          ...(flag("network") ? ["--network", flag("network")!] : []),
          ...rpcArgs(cfg),
        ],
        funderEnv,
      );
      /* 0 is "nothing is due", which is the ordinary outcome of a scheduled run
         and not a failure. 70 is the one code that means go on. */
      if (decided !== TOPUP_DUE) process.exit(decided);

      /**
       * The successor's defaults, pushed into `rest` rather than passed.
       *
       * `grant` below reads its arguments from exactly one place, and that is
       * worth keeping: a second invocation of quickstart is a second set of
       * defaults to drift. So this fills in what the caller did not say, from
       * the grant being replaced, and then lets the one invocation run.
       *
       * `--out` and `--agent-out` get NEW paths, always. Overwriting the old
       * manifest would destroy the only description of a grant that still
       * holds coin and can still be revoked; overwriting the agent key is the
       * mistake quickstart already refuses, and it would refuse this too.
       */
      if (!flag("out")) rest.push("--out", successorPath(grant!));
      if (!flag("agent-out")) rest.push("--agent-out", successorPath(cfg.agentKey ?? "agent.key"));
      if (!flag("payees")) rest.push("--payees", payees!);
      if (!flag("budget")) rest.push("--budget", `${m.budget}sompi`);
      if (!flag("max-per-spend")) rest.push("--max-per-spend", `${m.max_per_spend}sompi`);
      if (!flag("epoch-limit")) rest.push("--epoch-limit", `${m.epoch_limit}sompi`);
      /* Carried forward only when it is a real separation. Defaulted, the
         revocation key IS the principal, and passing it back would turn a
         default into something that looks like a choice somebody made. */
      if (!flag("revocation") && m.revocation && m.revocation !== m.principal) {
        rest.push("--revocation", m.revocation);
      }
      console.error("issuing the successor…");
    }
    /* Falls through to `grant` ON PURPOSE, for the same reason `fund` does. */
  }
  // eslint-disable-next-line no-fallthrough

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
      /* Tells quickstart which of its two closing forms to print. Without it
         the last line of a successful run names a repository path that a
         global install does not have. */
      "--via",
      "warda",
      ...(flag("prefix") ? ["--prefix", flag("prefix")!] : []),
      ...(flag("network") ? ["--network", flag("network")!] : []),
      /* Without this the revocation key can only ever equal the principal
         from the CLI, and the separation exists precisely for the case where
         the principal key is the thing that went wrong. */
      ...(flag("revocation") ? ["--revocation", flag("revocation")!] : []),
      /* The term, in DAYS here and blocks underneath. Same rule as --budget
         taking KAS rather than sompi: 30 is a number somebody can check by
         eye and 25920000 is a number nobody can. Kaspa is ten blocks a second,
         and the conversion happens here, once, where it is written down. */
      ...(flag("days") ? ["--window", String(days(flag("days")!))] : []),
      /* Puts the agent's own address on the allowlist, so it can reach an
         x402 `exact` vendor through a relay hop. It costs the allowlist for
         that hop and nothing else; quickstart says so at the point of use. */
      ...(has("relay") ? ["--relay"] : []),
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
      transport: has("borsh") ? "borsh" : cfg.transport,
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
    const viaBorsh = has("borsh") || cfg.transport === "borsh";
    if (viaBorsh) {
      /* A read, so no covenant-carrying build is needed here — but going
         through the same transport the rest of the CLI uses is what keeps
         "what may I spend right now" answerable without a node. */
      try {
        const { BorshReader } = await import("@warda_protocol/borsh");
        const reader = await BorshReader.open({ networkId: flag("network") ?? "testnet-10" });
        try {
          daa = (await reader.getBlockDagInfo()).virtualDaaScore;
        } finally {
          await reader.close();
        }
      } catch {
        /* Same silence as the JSON path below: a balance that cannot reach the
           chain reports the limits and says the headroom is unknown. */
      }
    } else if (url) {
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
          /* An unfinished purchase is redeemed by re-running the same command;
             this opts out of that and buys again. It has to be forwarded or
             the escape hatch is unreachable from the CLI. */
          ...(has("no-resume") ? ["--no-resume"] : []),
          /* A relay hop. Ignored by a v1 vendor and required by a v2 one —
             their exact scheme cannot take a covenant spend. Costs the
             allowlist for that hop, which is why it is typed rather than
             inferred from the vendor. */
          ...(has("relay") ? ["--relay"] : []),
          ...(flag("relay-fee") ? ["--relay-fee", flag("relay-fee")!] : []),
          ...(flag("settle-attempts") ? ["--settle-attempts", flag("settle-attempts")!] : []),
          /* Sign without holding the key: name a command and the vendor's own
             CLI does the authentication it already knows how to do. */
          ...(flag("signer") ? ["--signer", flag("signer")!] : []),
          /* A compute endpoint prices the work, so the quote request has to
             carry it. Without this the CLI can only ask vendors whose price is
             a property of the URL. */
          ...(flag("data") ? ["--data", flag("data")!] : []),
          ...(flag("content-type") ? ["--content-type", flag("content-type")!] : []),
          /* A label for cost per task. It goes into the purchase record only. */
          ...(flag("task") ? ["--task", flag("task")!] : []),
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
  /**
   * The two ways a grant ends, and the reason they are here.
   *
   * Revoke is the emergency stop: available at any moment, signed by the
   * revocation key, for an agent that has been compromised or is behaving in
   * a way the rules permit and the principal does not like. It has lived in
   * `sdk/tools/build-exit.ts` since it was written — which means that until
   * now, stopping a running agent required a git clone and npm install. That
   * is the one thing on this protocol that must be reachable in a hurry, and
   * it was the only thing that needed the most setup.
   *
   * Reclaim is the scheduled end: available once the chain has passed
   * `expiresAt`, signed by the principal, bringing the remainder home.
   *
   * Neither races an in-flight spend. Both make the remaining balance
   * unreachable from the next block on; a payment already in the mempool may
   * still land first. That is a property of a UTXO covenant rather than a gap
   * here — there is no way to express "and cancel anything outstanding".
   */
  case "revoke":
  case "reclaim": {
    const cfg = readConfig();
    const grant = rest.find((a) => a.endsWith(".json")) ?? cfg.grant;
    if (!grant) {
      die(
        `warda ${verb} <grant.json>   — or run it where \`warda grant\` remembered one.\n\n` +
          (verb === "revoke"
            ? "  The emergency stop. Signed by the REVOCATION key, available at any moment.\n" +
              "  The remaining balance goes back to the principal."
            : "  The scheduled end. Signed by the PRINCIPAL key, available only once the\n" +
              "  chain has passed the grant's expiry."),
        2,
      );
    }
    /* The key by path, like `warda grant --key`, because the key that ends a
       grant is deliberately not the one the agent holds and is deliberately
       not in this directory's config. Asking for it in the environment is how
       an emergency stop gets typed wrong at the worst moment. */
    const keyPath = flag("key");
    const env: NodeJS.ProcessEnv = keyPath
      ? { WARDA_SK: readFileSync(keyPath, "utf8").trim() }
      : {};
    process.exit(
      run(
        "sdk/tools/build-exit.ts",
        [
          grant!,
          verb === "revoke" ? "--revoke" : "--reclaim",
          ...(has("submit") ? ["--submit"] : []),
          ...(flag("fee") ? ["--fee", flag("fee")!] : []),
          ...(flag("prefix") ? ["--prefix", flag("prefix")!] : []),
          ...(flag("network") ? ["--network", flag("network")!] : []),
          ...rpcArgs(cfg),
        ],
        env,
      ),
    );
    break;
  }

  case "fee": {
    /* Only one thing to measure so far, and it is named rather than default:
       "warda fee" with no argument should not quietly measure something. */
    if (rest[0] !== "relay") {
      die("warda fee relay   — what the network charges for a relayed payment.", 2);
    }
    const cfg = readConfig();
    process.exit(
      run("sdk/tools/measure-relay-fee.ts", [
        ...rpcArgs(cfg),
        ...(flag("fee") ? ["--fee", flag("fee")!] : []),
        ...(flag("network") ? ["--network", flag("network")!] : []),
      ], { WARDA_SK: agentSecret(cfg) }),
    );
    break;
  }

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
