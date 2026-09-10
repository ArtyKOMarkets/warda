/**
 * Does Warda's 402 client understand kaspai.win's 402?
 *
 *   node --experimental-strip-types ops/interop-kaspai.ts
 *
 * SPENDS NOTHING. It asks their gateway for a quote and stops. No key is read,
 * no transaction is built, no grant is touched — a 402 challenge is free, and
 * everything worth learning first is in the challenge.
 *
 * ## Why this is the first step and not a payment
 *
 * kaspai.win settles on Kaspa MAINNET. Every Warda grant so far is testnet-10,
 * so paying them at all means creating a grant with real KAS behind it — and a
 * grant's allowlist is fixed at creation, so it has to name their address
 * BEFORE any money moves. Their payTo is server configuration rather than a
 * per-request address (kaspa-x402's server picks it from config), which is the
 * reason this can work at all; a gateway that rotated its payee could never be
 * paid by a Warda grant, and no amount of goodwill would change that.
 *
 * So the order is: read their quote, prove our parser understands it, and only
 * then decide whether to put real money behind an allowlist naming them.
 *
 * ## What a pass looks like
 *
 * parsePaymentRequired() is the SAME function @warda_protocol/x402 uses on a
 * live purchase — not a copy written to agree with them. If it returns a
 * requirement here, Warda can read their quote; if it throws, the message says
 * exactly which part of the shape we disagree on, which is the useful bug
 * report either way.
 */
import { parsePaymentRequired, SCHEME_EXACT } from "@warda_protocol/x402";
import { formatKas } from "@warda_protocol/core";

const GATEWAY = process.env.KASPAI_GATEWAY ?? "https://kaspai.win";
const ENDPOINT = `${GATEWAY.replace(/\/$/, "")}/compute`;

/* Their own client posts {prompt, model?} and sends X-Client. Copied from
   kaspa-x402's requestCompute so the challenge we get is the challenge a
   normal caller gets, not one shaped by an unusual request. */
const REQUEST = { prompt: "ping", model: "kaspa-fast-1" };

const line = (s = "") => console.log(s);

line(`POST ${ENDPOINT}`);
line(`     ${JSON.stringify(REQUEST)}`);
line();

let res: Response;
try {
  res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Client": "warda-interop-probe" },
    body: JSON.stringify(REQUEST),
  });
} catch (e) {
  console.error(`could not reach ${ENDPOINT}: ${(e as Error).message}`);
  process.exit(1);
}

line(`HTTP ${res.status} ${res.statusText}`);

if (res.status !== 402) {
  /* Not a failure of interop — a failure to get to the question. Print enough
     that the next person does not have to re-run it blind. */
  const text = await res.text();
  console.error(
    `\nexpected 402, got ${res.status}. Their client expects 402 here too, so this is\n` +
      `either a changed path, a gateway that is down, or a request they rejected before\n` +
      `pricing it. The body:\n\n${text.slice(0, 800)}`,
  );
  process.exit(1);
}

const body = await res.json();
line();
line("their challenge, verbatim:");
line(JSON.stringify(body, null, 2).split("\n").map((l) => "  " + l).join("\n"));
line();

let req;
try {
  req = parsePaymentRequired(body);
} catch (e) {
  console.error("Warda's parser REFUSED their quote:\n");
  console.error("  " + (e as Error).message);
  console.error(
    "\nThat is the interop bug, and it is ours to describe precisely: the shape above\n" +
      "is what a kaspa-x402 gateway actually sends.",
  );
  process.exit(3);
}

line("Warda read it as:");
line(`  scheme     ${req.scheme}${req.scheme === SCHEME_EXACT ? "" : "   ← not the scheme this client implements"}`);
line(`  network    ${req.network}`);
line(`  asset      ${req.asset}`);
line(`  payTo      ${req.payTo}`);
line(`  amount     ${formatKas(req.amountSompi)} KAS  (${req.amountSompi} sompi)`);
line(`  nonce      ${req.nonce}`);
if (req.maxTimeoutSeconds) line(`  timeout    ${req.maxTimeoutSeconds}s`);
if (req.facilitator?.url) line(`  facilitator ${req.facilitator.url}`);
line();

/* The three things that decide whether a grant could ever pay this, stated as
   requirements rather than as a verdict — the grant does not exist yet. */
line("what a grant would have to be, to pay this:");
line(`  network        ${req.network}` + (req.network.includes("test") ? "" : "   ← REAL money"));
line(`  allowlist      must contain ${req.payTo}`);
line(`                 and it is fixed at creation, so this address must be known first`);
line(`  max-per-spend  at least ${formatKas(req.amountSompi)} KAS`);
line();
line("Nothing was spent. No key was read.");
