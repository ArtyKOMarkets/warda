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
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Agent, fileStore, toRecipientSet } from "@warda_protocol/agent";
import { fromHex } from "@warda_protocol/kaspa";

const flag = (n: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};

const manifestPath = flag("grant");
const recipientsPath = flag("recipients");
const url = flag("url", "https://demo.kaspa-x402.org/exact")!;
const statusPath = flag("status");
const secretHex = process.env.WARDA_AGENT_SK;

if (!manifestPath || !recipientsPath) {
  console.error("usage: interop.ts --grant <manifest.json> --recipients <payees.txt> [--url <u>] [--status <f>]");
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
      if (e.type === "quote") console.error(`quoted   : ${e.requirement.amountSompi} sompi to ${e.requirement.payTo}`);
      if (e.type === "paid") console.error(`paid     : ${e.result.txid}`);
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
  if (!response.ok) process.exit(4);
  console.error(`remaining: ${agent.manifest.grant_value} sompi in the grant`);
} catch (e) {
  const why = (e as Error).message;
  console.error(why);
  /* A refusal by the grant's own limits is not an interop failure, and
     recording it as one would make the monitor cry wolf about the covenant
     doing its job. The budget running out is the expected end of this agent. */
  const refused = /allowlist|budget|cap|epoch|expire|notBefore/i.test(why);
  status({ ok: false, refusedByGrant: refused, error: why });
  process.exit(refused ? 3 : 1);
} finally {
  await agent.close();
}
