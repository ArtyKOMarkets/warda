/**
 * An agent buying something, and writing down what happened.
 *
 *   source ops/node.env
 *   WARDA_SK=$(cat covenant/deploy/agent-003.key) \
 *     node --experimental-strip-types agents/tools/buy.ts \
 *     https://warda-demo-api.vercel.app/digest \
 *     --id WARDA-003 \
 *     --grant x402/demo/agent-003-grant.json \
 *     --recipients x402/demo/agent-003-recipients.txt \
 *     --out agent-003/purchases
 *
 * Shared by every agent here rather than copied into each. It lived in
 * agent-002/ and was about to be duplicated for #003 and #004; three copies of
 * a payment loop is three places for the manifest-advance to drift, and the
 * one that drifts is the one nobody is looking at.
 *
 * ## Why this is not just `x402/demo/buy.ts`
 *
 * The payment mechanics are identical and are not copied: this calls the same
 * `wardaFetch` through the same `WardaPayer`. What is different is what has to
 * be RECORDED. buy.ts prints a response and updates a manifest, which is right
 * for a demo of a payment. #002's whole output is the purchase itself, so
 * every attempt — including the refused ones — is written to `purchases/` as a
 * file, and a refusal is as much a result as a receipt.
 *
 * That asymmetry is the point of the agent. #001 spends money in order to do
 * something else; #002's work IS the spending, so its log has to survive the
 * process rather than scroll past in a terminal.
 *
 * ## Nothing here decides whether the payment is allowed
 *
 * The covenant did that before the transaction existed, and the two limits
 * that matter to #002 cannot be relaxed by editing this file:
 *
 *   - it may pay exactly one address, fixed at genesis;
 *   - it may not pay at all before its `not_before` DAA score, which is
 *     checked by the script that unlocks the coin.
 *
 * The second one is why a run before the timelock expires writes a refusal
 * file and exits non-zero rather than waiting. An agent that quietly slept
 * until it was allowed to spend would look identical from outside to one with
 * no timelock at all, and the record is the product here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  NodeClient,
  RecipientSet,
  EMPTY_RESERVE,
  decodeAddress,
  fromHex,
  toHex,
  templateIdFor,
  type CovenantTemplate,
  type GrantState,
} from "@warda_protocol/kaspa";
import { WardaPayer, wardaFetch } from "@warda_protocol/x402";
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const url = process.argv.slice(2).find((a) => a.startsWith("http")) ?? "https://warda-demo-api.vercel.app/digest";

/* A GET was enough for every vendor this was written against, whose price is a
   property of the URL. It is not enough in general: a compute endpoint prices
   the WORK, so the request that gets quoted has to carry the prompt, and a
   gateway that expects a POST answers a GET with 404 or 405 rather than a 402 —
   which looks exactly like a vendor that is down.

   `--data @file` because a prompt is not a thing to fight a shell over.

   The body is sent on BOTH requests, unchanged. The 402 flow asks twice — once
   to learn the price, once with proof — and a vendor prices what it was asked;
   a second request carrying different work is a different job than the one that
   was paid for. wardaFetch already buffers it for exactly this reason. */
const dataFlag = flag("data");
const requestBody =
  dataFlag === undefined
    ? undefined
    : dataFlag.startsWith("@")
      ? readFileSync(dataFlag.slice(1), "utf8")
      : dataFlag;
const contentType = flag("content-type") ?? "application/json";
if (requestBody !== undefined && contentType.includes("json")) {
  try {
    JSON.parse(requestBody);
  } catch (e) {
    console.error(
      `--data is not valid JSON (${(e as Error).message}).\n` +
        `  Pass --content-type if it is meant to be something else; a vendor that is sent\n` +
        `  a malformed body prices nothing and this would spend the round trip to find out.`,
    );
    process.exit(2);
  }
}

const agentId = flag("id");
const manifestPath = flag("grant");
const recipientsPath = flag("recipients");
const outDir = flag("out");
if (!agentId || !manifestPath || !recipientsPath || !outDir) {
  /* No defaults. This file used to default to agent #002's grant and #002's
     purchase directory, which was harmless while it lived in agent-002/ and is
     a loaded gun now that three agents share it: a missing flag would pay from
     the wrong grant and file the receipt under the wrong agent. */
  console.error(
    "usage: buy.ts <url> --id WARDA-00N --grant <manifest.json> --recipients <file> --out <dir>\n" +
      "       [--json]            the whole result on stdout, for a caller in another language\n" +
      "       [--expect-refusal]  exit 0 when the covenant refuses, for a deliberate probe\n" +
      "       [--data <json|@f>]  POST this body instead of GET. @file reads a file\n" +
      "       [--content-type t]  default application/json, with --data\n\n" +
      "Every flag above the blank line is required. This tool is shared by all the agents,\n" +
      "so an omitted one would spend a grant you did not mean to spend.\n\n" +
      "Exit codes, which are the API when you call this from another language:\n" +
      "  0  bought          the vendor served it\n" +
      "  3  refused         the covenant said no. NOTHING was spent\n" +
      "  4  paid, unserved  the money is gone. Do NOT retry — that pays twice\n" +
      "  1  failed          see stderr\n" +
      "  2  usage",
  );
  process.exit(2);
}

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error(`WARDA_SK must be ${agentId}'s own key — the one its grant names, not the funder's.`);
  process.exit(1);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
/* The template comes from the package, not from a path beside this file:
   the published CLI carries this tool as bundled JS with no sdk/ directory
   above it, and a template read from a guessed path is how a tool derives a
   plausible address for a covenant nobody deployed. */
const template = covenantTemplate as CovenantTemplate;

const members = readFileSync(recipientsPath, "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean)
  .map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase()));
const recipients = new RecipientSet(members);
if (recipients.rootHex !== m.recipients_root) {
  console.error(
    `these recipients hash to ${recipients.rootHex}, but the grant commits to ` +
      `${m.recipients_root}. This is the wrong list for this grant.`,
  );
  process.exit(1);
}

const authority = { principalKey: m.principal, revocationKey: m.revocation ?? m.principal };
const state: GrantState = {
  agentKey: m.agent,
  budgetTotal: BigInt(m.budget),
  maxPerSpend: BigInt(m.max_per_spend),
  epochLimit: BigInt(m.epoch_limit),
  epochLength: BigInt(m.epoch_length),
  recipientsRoot: m.recipients_root,
  notBefore: BigInt(m.not_before),
  expiresAt: BigInt(m.expires_at),
  delegationDepth: BigInt(m.delegation_depth ?? 2),
  templateId: templateIdFor(template, authority),
  spentTotal: BigInt(m.spent_total ?? 0),
  reserved: BigInt(m.reserved ?? 0),
  epochIndex: BigInt(m.epoch_index ?? 0),
  epochSpent: BigInt(m.epoch_spent ?? 0),
  reserveRoot: m.reserve_root ?? EMPTY_RESERVE,
};

mkdirSync(outDir, { recursive: true });
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const record = (result: Record<string, unknown>) => {
  const path = `${outDir}/${stamp}.json`;
  writeFileSync(
    path,
    JSON.stringify(
      {
        _comment:
          "Written by agent-002/tools/buy.ts. One file per attempt, refusals included: a " +
          "purchase log that only records successes is a sales brochure.",
        at: startedAt.toISOString(),
        agent: agentId,
        url,
        ...result,
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`recorded : ${path}`);
};

/* One mutable object rather than three `let`s: assignments made inside a
   callback are invisible to the compiler's narrowing, so plain locals read
   back as `null` no matter what the callback did. Declared out here because
   the catch block needs the txid as much as the success path does. */
const seen: { payTo?: string; amountSompi?: bigint; txid?: string } = {};

/* Two chains, and nothing was checking they were the same one.
   
   A quote names the network it settles on — kaspa-x402 writes "kaspa:mainnet",
   kaspad reports "kaspa-mainnet" — and this tool spends on whatever chain its
   node is on. Those were never compared, so both mismatches were reachable and
   neither announces itself:
   
   A mainnet vendor paid from a testnet node broadcasts a transaction they will
   never see. The money is worthless, so this direction only wastes the call.
   
   A TESTNET vendor paid from a mainnet node spends real money to satisfy a
   quote priced in coins that are not. Nothing rejects it: the payee script is
   the same bytes either way — the prefix lives only in the address text — so
   it broadcasts, confirms, and the vendor never sees it because they are not
   watching that chain. Exit 4, unrecoverable, and it is the cheap direction of
   a mistake that is not cheap.
   
   Compared on the tail after the separator, because the two sides disagree on
   punctuation and neither spelling is wrong. */
const sameChain = (quoted: string, node: string): boolean => {
  const tail = (s: string) => s.trim().toLowerCase().replace(/^kaspa[:-]/, "");
  return tail(quoted) === tail(node);
};

const node = await NodeClient.connect({ url: flag("rpc") ?? process.env.WARDA_RPC_JSON });
try {
  /**
   * The timelock, checked before anything is built.
   *
   * The covenant enforces `claimedDaa >= notBefore` and would refuse the
   * transaction anyway, which is the guarantee. This check exists so the
   * refusal is legible: a node's script-verification failure is a true answer
   * and an unreadable one, and an agent that cannot say why it did not buy
   * something has not really reported anything.
   */
  const dag = await node.getBlockDagInfo();
  const daa = dag.virtualDaaScore;
  if (daa < state.notBefore) {
    const short = state.notBefore - daa;
    const refusal =
      `agent #002 may not spend until DAA ${state.notBefore} and the network is at ${daa} — ` +
      `${short} short, roughly ${Math.round(Number(short) / 10)} seconds at ten blocks per ` +
      `second. This is not a policy in this process: the covenant checks the claimed DAA score ` +
      `against ${state.notBefore} on every spend, so no version of this program can bring the ` +
      `payment forward, and neither can whoever issued the grant.`;
    console.error(refusal);
    record({ outcome: "refused", reason: "timelock", virtualDaaScore: daa.toString(), notBefore: state.notBefore.toString(), refusal });
    process.exit(has("expect-refusal") ? 0 : 3);
  }

  const payer = new WardaPayer({
    grant: { template, authority, state, recipients },
    node,
    sign: fromHex(secretHex.trim()),
  });

  console.error(`buying   : ${url}`);

  const res = await wardaFetch(url, requestBody === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: requestBody,
  }, {
    payer,
    onEvent: (e) => {
      if (e.type === "quote") {
        seen.payTo = e.requirement.payTo;
        seen.amountSompi = e.requirement.amountSompi;
        console.error(`  quoted : ${e.requirement.amountSompi} sompi to ${e.requirement.payTo}`);
        /* Thrown from the quote handler, which wardaFetch emits before it
           builds anything — so this refuses while the money is still ours. */
        if (e.requirement.network && !sameChain(e.requirement.network, dag.network)) {
          throw new Error(
            `this vendor settles on "${e.requirement.network}" and this node is on ` +
              `"${dag.network}". Nothing was paid.\n` +
              `  A payment built here would be a valid transaction on the wrong chain: the ` +
              `payee script is\n  identical either way, so it would broadcast and confirm, ` +
              `and they would never see it.`,
          );
        }
      }
      if (e.type === "paid") {
        seen.txid = e.result.txid;
        console.error(`  paid   : ${e.result.txid}`);
      }
      if (e.type === "settling") console.error(`  settling, retrying in ${e.delayMs}ms with the SAME proof`);
      if (e.type === "done") console.error(`  status : ${e.status}`);
    },
  });

  /**
   * Text first, then JSON.
   *
   * `res.json()` THROWS on a body that is not JSON, and a serverless host
   * answering 500 sends an HTML error page. That throw landed in the catch
   * below, which records `outcome: "failed"` and the parser's complaint —
   * losing the transaction id of a payment that had already settled. Which is
   * precisely the failure the comment under this block warns about, written
   * two screens above the code that caused it.
   *
   * So the body is read as text, parsed if it can be, and kept verbatim if it
   * cannot. A vendor that takes the money and answers with a stack trace still
   * owes this agent a record of what it paid and to whom.
   */
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { notJson: text.slice(0, 500), contentType: res.headers.get("content-type") };
  }

  /* Written BEFORE the manifest, and before anything is printed. A purchase
     that succeeded and was not recorded is indistinguishable afterwards from
     one that never happened, and the money is gone either way. */
  record({
    outcome: res.ok ? "bought" : "paid-but-refused",
    status: res.status,
    quoted: seen.payTo ? { payTo: seen.payTo, amountSompi: seen.amountSompi?.toString() ?? null } : null,
    txid: seen.txid ?? null,
    /* Who the vendor says sold it, recorded verbatim and NOT trusted: the
       checkable fact is which address the money reached, and that is `quoted`
       above, matched against this grant's allowlist by the covenant itself. */
    sellerClaimed: (body as Record<string, unknown>)?.seller ?? null,
    response: body,
  });

  /* The grant has MOVED — its address is a hash of its state. Write the new
     state back or the next run looks for it where it used to be, which every
     tool reports as "no UTXO at <address>": a message that names three causes,
     none of them this one. */
  const s = payer.state;
  /* Numbers, not strings — genesis, advance-manifest and follow-grant all
     write numbers here, and a manifest that changes shape depending on which
     tool touched it last is a manifest every reader has to guess at. */
  const advanced = {
    ...m,
    spent_total: Number(s.spentTotal),
    reserved: Number(s.reserved),
    epoch_index: Number(s.epochIndex),
    epoch_spent: Number(s.epochSpent),
    /* Payment AND fee. The budget is charged the payment; the coin loses both,
       and a grant_value advanced by only the payment drifts by one fee per
       purchase until the dashboard refuses to publish it. */
    grant_value: Number(BigInt(m.grant_value) - (seen.amountSompi ?? 0n) - payer.fee),
  };
  writeFileSync(manifestPath, JSON.stringify(advanced, null, 1) + "\n");
  console.error(`manifest : advanced to spent_total=${advanced.spent_total}`);

  /**
   * `--json`: the whole result, not just what the vendor said.
   *
   * stdout carried the response body, which is right for a human reading a
   * terminal and not enough for a program. A caller in another language — and
   * a shell script, and Python through `subprocess` — needs to know what it
   * PAID and to whom, and those were only ever on stderr as log lines. Anyone
   * integrating had to scrape them.
   *
   * The default is unchanged, because the demos and the docs print the body.
   */
  if (has("json")) {
    process.stdout.write(
      JSON.stringify(
        {
          agent: agentId,
          url,
          outcome: res.ok ? "bought" : "paid-but-refused",
          status: res.status,
          txid: seen.txid ?? null,
          paidSompi: seen.amountSompi?.toString() ?? null,
          payTo: seen.payTo ?? null,
          body,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
  }
  if (!res.ok) process.exit(4);
} catch (e) {
  const why = (e as Error).message;
  console.error(why);
  /* `seen` may hold a txid even here: everything after `payer.pay` can throw
     with the money already on chain. A failure record without it is a payment
     nothing in this repository remembers making. */
  record({
    outcome: seen.txid ? "paid-then-failed" : "failed",
    txid: seen.txid ?? null,
    quoted: seen.payTo ? { payTo: seen.payTo, amountSompi: seen.amountSompi?.toString() ?? null } : null,
    error: why,
  });
  process.exit(1);
} finally {
  node.close();
}
