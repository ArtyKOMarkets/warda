#!/usr/bin/env node
/**
 * Agent #005 — buys from a vendor nobody here controls, on a schedule.
 *
 *   node --experimental-strip-types agents/tools/interop.ts \
 *     --grant agent-005/grant.json --recipients x402/demo/kaspa-x402-recipients.txt \
 *     --url https://demo.kaspa-x402.org/exact --status site/src/interop-status.json
 *
 * ## Why this agent exists
 *
 * Paying a third party once is an anecdote. The interop win on 14 September
 * was real and it was also a single transaction on a single afternoon, and
 * nothing here would notice if their facilitator changed tomorrow — which is
 * the same shape as every other claim this project has had to go back and
 * correct. An agent that buys from them every day turns it into something that
 * decays LOUDLY.
 *
 * It is also the first thing other than `buy.ts` to hold a grant through
 * `@warda_protocol/agent`, which is the only way to find out whether that
 * package takes the right arguments.
 *
 * ## What it demonstrates, by doing rather than claiming
 *
 *   no node        `--borsh`: read and spend through a public resolver
 *   the wallet     one object holds the grant, signs, and keeps the record
 *   the relay      their `exact` scheme takes only an ordinary payment, so the
 *                  grant funds a single-use key and that key pays
 *
 * Roughly a hundred lines, most of them this comment. The previous way to do
 * the same thing was six hundred lines of CLI, and the difference is the
 * argument for the package.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Agent, fileStore, toRecipientSet } from "@warda_protocol/agent";
import { fromHex } from "@warda_protocol/kaspa";
import { withProof } from "./resume.ts";

const flag = (n: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};

const manifestPath = flag("grant");
const recipientsPath = flag("recipients");
const url = flag("url", "https://demo.kaspa-x402.org/exact")!;
const statusPath = flag("status");
/**
 * The purchase log — one file per attempt, refusals included.
 *
 * This is the repository's existing record format, not a new one. I wrote a
 * bespoke `*.unredeemed.json` here first, which was a mistake in a specific
 * way: `resume.ts` already defines what a purchase record looks like, attaches
 * the proof to EVERY outcome through `withProof`, and knows how to find an
 * unfinished one and close a debt. A second format meant the one agent most
 * likely to be refused by a stranger wrote its receipts somewhere none of that
 * machinery could see — and its first undelivered payment was invisible to the
 * tooling built for exactly that case.
 *
 * It is also what `dashboard.ts --purchases` reads, so the agent's page
 * reconciles what the chain says against what this wrote. Without it the page
 * reports money leaving the grant "with no surviving record of why", which
 * would be false in the most unflattering possible direction.
 */
const outDir = flag("out");
const secretHex = process.env.WARDA_AGENT_SK;

if (!manifestPath || !recipientsPath) {
  console.error(
    "usage: interop.ts --grant <manifest.json> --recipients <payees.txt>\n" +
      "                  [--url <u>] [--status <f>] [--out <purchases dir>]",
  );
  process.exit(2);
}
if (!secretHex) {
  console.error("WARDA_AGENT_SK is required: this agent signs its own spends.");
  process.exit(2);
}

/**
 * The status file is written on EVERY outcome, including the failures.
 *
 * A monitor that only writes when it succeeds is indistinguishable from a
 * monitor that is not running — which this repo has already paid for once, in
 * a cron job that was removed by not being asked for again and whose absence
 * was invisible because a job that never runs writes no log. The site renders
 * nothing for a reading older than a day, so a silent death shows up as the
 * claim quietly disappearing rather than as a stale green.
 */
const status = (fields: Record<string, unknown>): void => {
  if (!statusPath) return;
  writeFileSync(
    statusPath,
    JSON.stringify({ checkedAt: new Date().toISOString(), vendor: url, ...fields }, null, 2) + "\n",
  );
};

/**
 * The receipt, captured from the event rather than from the return value.
 *
 * `agent.fetch` throws when the vendor refuses, so the purchase that most
 * needs recording is the one whose return value never arrives. The header on
 * the `paid` event is the only artifact that can redeem a payment which
 * settled and was not served, and it exists for exactly one moment: agent
 * #005's first purchase went that way and the header was discarded, leaving a
 * paid transaction with nothing to present it with.
 */
let receipt: { txid: string; amountSompi: string; header: string } | undefined;
/* The quote, kept because the RECORD needs it and the response does not. */
let quoted: { payTo: string; amountSompi: string } | undefined;

/**
 * One file per attempt, whatever happened.
 *
 * The same shape `buy.ts` writes, so `resume.ts`, `dashboard.ts` and anyone
 * reading the directory see one format. `withProof` attaches the header to
 * EVERY outcome rather than to the successful ones — a record that names a
 * payment has to carry the means to finish it, and the failure that rule
 * exists for is a catch block overwriting the paid record with a poorer one.
 */
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const record = (outcome: Record<string, unknown>): void => {
  if (!outDir) return;
  mkdirSync(outDir, { recursive: true });
  const path = `${outDir}/${stamp}.json`;
  writeFileSync(
    path,
    JSON.stringify(
      {
        _comment:
          "Written by agents/tools/interop.ts. One file per attempt, refusals included: a " +
          "purchase log that only records successes is a sales brochure.",
        at: startedAt.toISOString(),
        agent: "WARDA-005",
        url,
        /* `quoted` and `txid`, in the shape dashboard.ts reads them.
         *
         * It was `amountSompi` and `feeSompi` at the top level, which is a
         * perfectly good record and not the one anything else here parses:
         * dashboard.ts takes the amount from `quoted.amountSompi` and the
         * payee from `quoted.payTo`. So agent #005's page showed a purchase
         * with no amount and no payee, its reconciliation could not attribute
         * the payment it had a receipt for, and the page went on reporting
         * money that left "with no surviving record of why" while the record
         * sat in the directory beside it.
         *
         * I wrote a commit saying this file used the format that already
         * existed. It used the outcome vocabulary and `withProof` and not the
         * two fields anything reads. Adopting a format means the fields, not
         * the spirit. */
        quoted: quoted ?? null,
        txid: receipt?.txid ?? null,
        ...withProof(outcome, receipt),
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`recorded : ${path}`);
};

const members = readFileSync(recipientsPath, "utf8").split(/\r?\n/);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const recipients = toRecipientSet(members);
if (recipients.rootHex !== manifest.recipients_root) {
  console.error(
    `these recipients hash to ${recipients.rootHex}, but the grant commits to ` +
      `${manifest.recipients_root}. This is the wrong list for this grant.`,
  );
  process.exit(2);
}

const agent = await Agent.open({
  store: fileStore(manifestPath),
  recipients: members,
  sign: fromHex(secretHex.trim()),
  /* No node. The sixteen public resolvers serve borsh, and the four health
     checks run against whichever stranger answers first — which matters more
     here, not less, because nobody chose it. */
  borsh: true,
  networkId: process.env.WARDA_NETWORK ?? "testnet-10",
});

try {
  const { response, paid } = await agent.fetch(url, undefined, {
    /* Their `exact` scheme takes only a version-0 transaction with a
       key-controlled input and no covenant, so a covenant spend cannot BE the
       payment. The grant pays a single-use key and that key pays them. */
    relay: true,
    onEvent: (e) => {
      if (e.type === "quote") {
        quoted = { payTo: e.requirement.payTo, amountSompi: e.requirement.amountSompi.toString() };
        console.error(`quoted   : ${e.requirement.amountSompi} sompi to ${e.requirement.payTo}`);
      }
      if (e.type === "paid") {
        receipt = {
          txid: e.result.txid,
          amountSompi: e.result.amountSompi.toString(),
          header: e.header,
        };
        console.error(`paid     : ${e.result.txid}`);
      }
      /* Their node has not seen it yet. Printed because a silent twenty-second
         pause reads as a hang, and because the reason is the finding. */
      if (e.type === "settling") console.error(`settling : attempt ${e.attempt}, waiting ${e.delayMs}ms`);
      if (e.type === "done") console.error(`status   : ${e.status}`);
    },
  });

  const body = await response.text();
  console.error(`served   : ${response.ok ? "yes" : "NO"} (${response.status})`);
  status({
    ok: response.ok,
    httpStatus: response.status,
    txid: paid?.txid ?? null,
    paidSompi: paid?.amountSompi.toString() ?? null,
    feeSompi: agent.fee.toString(),
    remaining: agent.manifest.grant_value,
    body: body.slice(0, 400),
  });
  record({
    outcome: response.ok ? "bought" : "paid-but-refused",
    httpStatus: response.status,
    amountSompi: paid?.amountSompi.toString() ?? null,
    feeSompi: agent.fee.toString(),
    remaining: agent.manifest.grant_value,
    body: body.slice(0, 400),
  });
  if (!response.ok) process.exit(4);
  console.error(`remaining: ${agent.manifest.grant_value} sompi in the grant`);
} catch (e) {
  const why = (e as Error).message;
  console.error(why);
  /* A refusal by the grant's own limits is not an interop failure, and
     recording it as one would make the monitor cry wolf about the covenant
     doing its job. The budget running out is the expected end of this agent. */
  const refused = /allowlist|budget|cap|epoch|expire|notBefore/i.test(why);
  /* The receipt goes in even here — especially here. A failure carrying the
     txid and the header is a debt somebody can collect; the same failure
     without them is an anecdote about losing money. */
  status({
    ok: false,
    refusedByGrant: refused,
    error: why,
    txid: receipt?.txid ?? null,
    paidSompi: receipt?.amountSompi ?? null,
    remaining: agent.manifest.grant_value,
  });
  /* The header is NOT in the status file. That file is served from the site,
     and the header redeems the purchase: anyone holding it could present it
     and collect goods this grant paid for. The txid there is chain data and
     public either way; this is the half that is not, so it goes only into the
     purchase log, which is local. */
  record({
    /* `paid-then-failed` is one of resume.ts's UNFINISHED outcomes, so a
       record written here is a debt the existing tooling can find. A refusal
       by the grant's own limits spent nothing, and must not look like one. */
    outcome: refused ? "refused" : receipt ? "paid-then-failed" : "failed",
    refusedByGrant: refused,
    error: why,
    remaining: agent.manifest.grant_value,
  });
  if (receipt && !refused) {
    console.error(
      `debt     : ${receipt.txid} is paid and undelivered. The proof is in the purchase\n` +
        `           log above. Do NOT re-run to compensate — that buys it twice.`,
    );
  }
  process.exit(refused ? 3 : 1);
} finally {
  await agent.close();
}
