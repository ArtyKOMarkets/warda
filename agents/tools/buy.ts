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

import { closeDebt, findResumable, withProof, type Pending } from "./resume.ts";

import { openChain } from "../../sdk/tools/chain.ts";
/* Nine imports down to two. Everything dropped here — RecipientSet,
   EMPTY_RESERVE, decodeAddress, toHex, templateIdFor, the covenant template
   itself — existed to rebuild a grant this file no longer builds. */
import { fromHex, externalSigner } from "@warda_protocol/kaspa";
import { Agent, fileStore, toRecipientSet } from "@warda_protocol/agent";

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
      "       [--content-type t]  default application/json, with --data\n" +
      "       [--no-resume]       buy again instead of redeeming an unfinished purchase\n" +
      "       [--settle-attempts n]  give up after n presentations. 1 makes exit 4 on\n" +
      "                     purpose, which is how the resume path gets tested\n" +
      "       [--signer <cmd>]    sign with another process instead of WARDA_SK. The\n" +
      "                     digest arrives as hex on its stdin; it answers with 64\n" +
      "                     bytes of BIP340 hex on stdout. No secret reaches this tool\n\n" +
      "Every flag above the blank line is required. This tool is shared by all the agents,\n" +
      "so an omitted one would spend a grant you did not mean to spend.\n\n" +
      "Exit codes, which are the API when you call this from another language:\n" +
      "  0  bought          the vendor served it\n" +
      "  3  refused         the covenant said no. NOTHING was spent\n" +
      "  4  paid, unserved  the money settled and the vendor did not serve — including\n" +
      "                     when it never answered at all. Run the SAME command again:\n" +
      "                     it re-presents the proof and pays nothing\n" +
      "  1  failed          see stderr\n" +
      "  2  usage",
  );
  process.exit(2);
}

/**
 * The key, or something that holds it.
 *
 * `--signer "<command>"` hands the digest to another process and never sees a
 * secret — which is the only way anybody runs this for real. WARDA_SK stays
 * the default because a tutorial should not need an HSM.
 */
/* The guard forty lines below already refuses an empty key — but the compiler
   cannot see through it, and `?? ""` would satisfy the compiler by signing with
   nothing if that guard ever moved. This refuses instead, which is what the
   guard means. */
const requireSecret = (v: string | undefined): string => {
  if (!v || !v.trim()) throw new Error("no agent key: WARDA_SK is empty. Refusing to sign with nothing.");
  return v.trim();
};

const signerCmd = flag("signer");
const secretHex = signerCmd ? "" : process.env.WARDA_SK;
if (!signerCmd && !secretHex) {
  console.error(`WARDA_SK must be ${agentId}'s own key — the one its grant names, not the funder's.`);
  process.exit(1);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const members = readFileSync(recipientsPath, "utf8").split(/\r?\n/);

/**
 * A pre-flight, not a duplicate of the wallet's check.
 *
 * `Agent.open` checks the allowlist against the manifest's root too, and it
 * has to — it is an invariant of holding a grant, not a courtesy to a CLI.
 * This one runs BEFORE a node is dialled, so the most common configuration
 * mistake costs a hash instead of a connection, and exits 1 rather than
 * writing a failure record for something that never reached the chain.
 *
 * Both call `toRecipientSet`, so the parsing that produces the root — the part
 * where a stray comment or a mixed-case address would diverge — exists once.
 */
const recipients = toRecipientSet(members);
if (recipients.rootHex !== m.recipients_root) {
  console.error(
    `these recipients hash to ${recipients.rootHex}, but the grant commits to ` +
      `${m.recipients_root}. This is the wrong list for this grant.`,
  );
  process.exit(1);
}

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
        /* The proof rides on every record that has one — see withProof, and
           the failure it exists to prevent. */
        ...withProof(result, seen.proof),
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`recorded : ${path}`);
};

const pending = has("no-resume") ? null : findResumable(outDir, url);
if (pending) {
  console.error(
    `resuming : ${pending.txid} — this URL was paid for and never delivered.\n` +
      `           Re-presenting that proof. NOTHING will be paid; if the vendor still\n` +
      `           refuses, this exits non-zero rather than buying it again.\n` +
      `           Pass --no-resume to make a fresh purchase instead.`,
  );
}

/* One mutable object rather than three `let`s: assignments made inside a
   callback are invisible to the compiler's narrowing, so plain locals read
   back as `null` no matter what the callback did. Declared out here because
   the catch block needs the txid as much as the success path does. */
const seen: { payTo?: string; amountSompi?: bigint; txid?: string; proof?: Pending } = {};
/* A resume emits no `paid` event, because nothing is paid — so seed the proof
   from the debt being redeemed, or the record this run writes would carry no
   way to redeem it and the only copy would be the older file. */
if (pending) { seen.proof = pending; seen.txid = pending.txid; }

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

/* `open`, not `connect`, and the difference is the resolver.
   
   `connect` takes an explicit url, then WARDA_RPC_JSON, then localhost. It
   never asks a resolver — so WARDA_RESOLVER, which the README and /start both
   offer as the way to work without running kaspad, silently did nothing here
   and this fell through to a node on 127.0.0.1 that is not there. "You do not
   have to run a node" was true for looking and false for spending, which is
   the wrong way round: reading a wrong answer costs a refresh, and paying from one spends the money.
   
   `open` also interrogates whatever it reaches — synced, utxo-indexed, right
   network, covenants understood — before handing it back. Every one of those
   failures returns a plausible answer rather than an error: a node without a
   utxo index reports a grant as empty, which is indistinguishable from
   drained. That check matters more with real money, not less. */
const { client: node, transport } = await openChain({
  url: flag("rpc") ?? process.env.WARDA_RPC_JSON,
  resolver: flag("resolver"),
  networkId: process.env.WARDA_NETWORK,
});
if (transport === "borsh") console.error(`reading and spending over borsh, via ${node.url}`);
try {
  /**
   * The wallet, not a payer.
   *
   * `@warda_protocol/agent` is this orchestration as a package: it holds the
   * grant, signs, and — the part that matters — owns the manifest, writing it
   * only after a purchase is both paid AND delivered. That advance used to
   * live at the bottom of this file, which meant every integration that wanted
   * to buy something had to re-derive it from six hundred lines of CLI, and
   * the fee arithmetic in particular is the kind that drifts silently.
   *
   * What stays here is everything that is a command line's job: flags,
   * purchase records, resume and debt-closing, the timelock refusal in words,
   * and exit codes that mean something to a caller in another language.
   */
  const agent = await Agent.open({
    store: fileStore(manifestPath),
    recipients: members,
    sign: signerCmd
      ? externalSigner({ command: signerCmd, publicKey: m.agent })
      : fromHex(requireSecret(secretHex)),
    chain: node,
  });

  /**
   * The timelock, checked before anything is built.
   *
   * The covenant enforces `claimedDaa >= notBefore` and would refuse the
   * transaction anyway, which is the guarantee. This check exists so the
   * refusal is legible: a node's script-verification failure is a true answer
   * and an unreadable one, and an agent that cannot say why it did not buy
   * something has not really reported anything.
   *
   * Read off the wallet rather than from a second copy of the grant. This file
   * used to rebuild the whole GrantState from the manifest — fifteen fields,
   * one of them a derived template id — purely to reach `notBefore` and to
   * hand a grant to the payer. Both come from the wallet now, so the grant is
   * assembled once, by the package whose job that is.
   */
  const dag = await node.getBlockDagInfo();
  const daa = dag.virtualDaaScore;
  const notBefore = agent.state.notBefore;
  if (daa < notBefore) {
    const short = notBefore - daa;
    const refusal =
      `agent #002 may not spend until DAA ${notBefore} and the network is at ${daa} — ` +
      `${short} short, roughly ${Math.round(Number(short) / 10)} seconds at ten blocks per ` +
      `second. This is not a policy in this process: the covenant checks the claimed DAA score ` +
      `against ${notBefore} on every spend, so no version of this program can bring the ` +
      `payment forward, and neither can whoever issued the grant.`;
    console.error(refusal);
    record({ outcome: "refused", reason: "timelock", virtualDaaScore: daa.toString(), notBefore: notBefore.toString(), refusal });
    process.exit(has("expect-refusal") ? 0 : 3);
  }

  console.error(`buying   : ${url}`);

  const { response: res } = await agent.fetch(url, requestBody === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: requestBody,
  }, {
    /**
     * A relay hop, which is what a kaspa-x402 v2 vendor requires.
     *
     * Ignored by a v1 vendor. For a v2 one it is the only way a payment can be
     * made at all — their `exact` scheme takes only a version-0 transaction
     * with a key-controlled input and no covenant, so a covenant spend cannot
     * BE the payment. The grant pays the agent's own key and an ordinary
     * transaction goes from there to the vendor.
     *
     * It costs the allowlist for that one hop: the covenant stops constraining
     * who is ultimately paid. That is why it is typed here as well as at
     * genesis, rather than being inferred from the vendor speaking v2.
     */
    relay: has("relay"),
    /* Overridable because it is the one fee in this protocol that cannot be
       corrected after the fact: it is fixed by the funding transaction, which
       is already broadcast by the time a node could price this one. Measure it
       with sdk/tools/measure-relay-fee.ts rather than guessing. */
    ...(flag("relay-fee") ? { relayFeeSompi: BigInt(flag("relay-fee")!) } : {}),
    /**
     * How many times to re-present the proof before giving up.
     *
     * Exposed for one reason: it is the only way to produce a genuine
     * paid-and-undelivered purchase on purpose. Settlement takes a few
     * seconds, so `--settle-attempts 1` presents the proof once, gets the
     * vendor's "still broadcasting" 402, and exits 4 with a real txid and a
     * real header — which is exactly the state the resume path exists to
     * recover, and otherwise can only be reached by killing the process at
     * the right moment or by a vendor going down mid-purchase.
     *
     * Testing recovery by arranging the failure beats testing it by waiting
     * for one.
     */
    ...(flag("settle-attempts") ? { maxSettleAttempts: Number(flag("settle-attempts")) } : {}),
    /* Present the old proof instead of buying. `wardaFetch` cannot reach its
       payer down this path at all, which is the property that makes an
       automatic resume safe to do without asking. */
    ...(pending ? { resume: { header: pending.header, txid: pending.txid, amountSompi: pending.amountSompi, payTo: pending.payTo } } : {}),
    /* Carry the proof onto THIS run's record too. A resume emits no `paid`
       event — nothing was paid — so without this the record it writes has no
       proof on it, and the debt would survive only in the older file. Two
       copies of one debt is better than nought, and `resolvedBy` keeps the
       chain of custody readable either way. */
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
        seen.proof = {
          file: "",
          header: e.header,
          txid: e.result.txid,
          amountSompi: e.result.amountSompi.toString(),
          payTo: seen.payTo,
        };
        console.error(`  paid   : ${e.result.txid}`);
        /**
         * Written here, not after delivery.
         *
         * Everything between this line and the record at the bottom of the
         * file can fail — the vendor can hang, the process can be killed, the
         * host can go away — and until now all of it discarded the header,
         * which exists only inside wardaFetch and only for the length of the
         * call. That window was the whole bug: the money was on chain and the
         * one artefact that could still redeem it was in nobody's hands.
         *
         * The final record overwrites this one at the same path, so a run that
         * completes leaves a single file, as before.
         */
        record({
          outcome: "paid-pending",
          quoted: seen.payTo ? { payTo: seen.payTo, amountSompi: seen.amountSompi?.toString() ?? null } : null,
          txid: e.result.txid,
          note: "Paid; delivery not yet confirmed. Re-run the same command to re-present this proof.",
        });
      }
      if (e.type === "resuming") console.error(`  proof  : re-presenting, nothing will be paid`);
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
    resumedFrom: pending?.txid ?? null,
    response: body,
  });

  /**
   * Close the old debt ONLY if it was actually collected.
   *
   * This ran on every delivery attempt, `res.ok` or not. So a resume that
   * re-presented a proof and got another 503 — a vendor still down, which is
   * the whole reason the debt existed — stamped the record as resolved, the
   * proof stopped being findable, and the NEXT run bought the thing again.
   * A recoverable debt turned into a lost one by the machinery built to
   * recover it, and it cost a real 0.03 KAS to find.
   *
   * A debt is closed by delivery. Nothing else closes it.
   */
  if (pending && res.ok) {
    /* By TXID, across every file. A debt can have several records — the
       purchase, plus one per failed resume, each carrying the proof forward so
       losing a single file does not lose the debt. Stamping only the file that
       was read left the other copies open, and the next run offered a payment
       that had already been collected. */
    const closed = closeDebt(outDir, pending.txid, {
      at: new Date().toISOString(),
      status: res.status,
      record: `${stamp}.json`,
    });
    if (closed > 1) console.error(`closed    : ${closed} records of this one payment`);
  }

  /**
   * A resume advances nothing, because a resume spent nothing.
   *
   * `payer.state` here is whatever was loaded from the manifest — no payment
   * was built, so nothing moved it — and the arithmetic below would subtract a
   * fee for a transaction this run did not make. The manifest was already
   * advanced by the run that paid, IF that run got far enough; if it did not,
   * the manifest is behind the chain and no amount of guessing here fixes
   * that. `warda find --write` reconciles it against the grant's actual
   * successor, which is the tool that exists for this and knows the answer
   * rather than assuming it.
   */
  if (pending) {
    console.error(
      `manifest : untouched — this run paid nothing. If the grant's state is behind,\n` +
        `           reconcile it with \`warda find --write\` rather than by hand.`,
    );
  } else {

  /* Already written, by the wallet, at the only moment it is safe to: after
     the vendor served. The grant has MOVED — its address is a hash of its
     state — and a record left behind sends the next run to an address the
     payment consumed, which every tool reports as "no UTXO at <address>": a
     message that names three causes, none of them this one. */
  console.error(`manifest : advanced to spent_total=${agent.manifest.spent_total}`);
  }

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
  /**
   * A payment that landed and then failed leaves the manifest behind.
   *
   * The advance happens after delivery, so anything that throws between the
   * two — a vendor that never serves, a killed process, `--settle-attempts 1`
   * — leaves the chain one spend ahead of the file. The grant has moved to its
   * successor and the manifest still names the address that payment consumed,
   * so the NEXT attempt to build anything reports "no UTXO at …" and reads as
   * a grant that vanished.
   *
   * Resuming does not care: it builds no transaction and reads no UTXO. Every
   * other action does, and the reconcile is a tool rather than an edit,
   * because the successor address is derived from state this process no longer
   * has.
   */
  if (seen.txid) {
    console.error(
      `\n  The manifest is now BEHIND the chain by this payment. Re-running this same\n` +
        `  command re-presents the proof and needs no manifest. Anything else — another\n` +
        `  purchase, a balance — needs it reconciled first:\n\n` +
        `    warda find --write\n`,
    );
  }
  record({
    outcome: seen.txid ? "paid-then-failed" : "failed",
    txid: seen.txid ?? null,
    quoted: seen.payTo ? { payTo: seen.payTo, amountSompi: seen.amountSompi?.toString() ?? null } : null,
    error: why,
  });
  /**
   * Money moved, so this is a 4 and not a 1.
   *
   * Exit 4 means "paid, unserved": do not retry blindly, the debt is
   * recoverable. Exit 1 means "failed, see stderr", which a caller reasonably
   * reads as "nothing happened". Settlement exhausting THROWS — the vendor
   * answered 402 until the attempts ran out — and that landed here, reporting
   * a spent payment with the code for a generic failure.
   *
   * Found by the offline harness on its first full run, against a vendor told
   * to accept payment and never deliver. The same shape cost 0.03 KAS to find
   * in production a week earlier, by a different route.
   */
  process.exit(seen.txid ? 4 : 1);
} finally {
  node.close();
}
