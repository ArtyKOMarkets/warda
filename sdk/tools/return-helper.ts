/**
 * The owner's half of returning a hosted helper's budget to its parent.
 *
 *   npx @warda_protocol/cli return return.json --key your-revocation.key
 *
 * The runner built the settlement and signed the parent's half with the
 * parent's agent key. The helper's half needs the REVOCATION key — the owner's,
 * which the runner never holds. This rebuilds the transaction from the
 * document on this machine, checks that the digest the runner asks for is the
 * digest of THAT transaction (so nothing else can be slipped in), says what it
 * does, signs, and sends only the signature back. The key never leaves here.
 *
 *   --dry-run   check and explain; sign and send nothing
 */
import { readFileSync } from "node:fs";
import { fromHex, toHex } from "../src/bytes.ts";
import { buildUnsignedReabsorb } from "../src/reabsorb.ts";
import { agentPublicKey, signDigest, verifyDigest } from "../src/sign.ts";
import { type CovenantTemplate, type GrantState } from "../src/template.ts";
import { templateFor } from "../src/templates.ts";

const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const path = process.argv.slice(2).find((a) => a.endsWith(".json"));
if (!path) { console.error("usage: warda return return.json --key your-revocation.key [--dry-run]"); process.exit(2); }
const doc = JSON.parse(readFileSync(path, "utf8"));
const d = doc.document ?? doc;
if (d.kind !== "warda-return" || d.version !== 1) { console.error(`${path} is not a Warda return document`); process.exit(2); }
/* The document says which covenant it was built under, so USE it rather than
   insisting it be the current one.
 *
 * This read `if (d.template !== templateFingerprint(<the packaged template>))
 * … update @warda_protocol/cli`, which was a correct check with the wrong
 * remedy: after a covenant freeze every return document for a still-running v4
 * grant fails it, and no version of the CLI fixes that — the document is right
 * and the tool was looking at the wrong bytes. The archives ship in the package.
 * A document naming a covenant that is genuinely not here still refuses, with a
 * message that names it. */
let TEMPLATE: CovenantTemplate;
try {
  TEMPLATE = templateFor({ covenant: d.template }, `${path}`);
} catch (e) {
  console.error(String((e as Error).message));
  process.exit(1);
}
const BIG = ["budgetTotal", "maxPerSpend", "epochLimit", "epochLength", "notBefore", "expiresAt", "delegationDepth", "spentTotal", "reserved", "epochIndex", "epochSpent"];
const st = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BIG.includes(k) ? BigInt(String(v)) : v])) as unknown as GrantState;
const coin = (c: { txid: string; index: number; value: string; blockDaaScore: string; isCoinbase: boolean; covenantId: string }) => ({
  outpointTransactionId: fromHex(c.txid), outpointIndex: c.index, value: BigInt(c.value),
  blockDaaScore: BigInt(c.blockDaaScore), isCoinbase: c.isCoinbase, covenantId: fromHex(c.covenantId),
});
const parentState = st(d.parentState), childState = st(d.childState);
const built = buildUnsignedReabsorb({
  template: TEMPLATE, authority: d.authority, parentState, childState, prevRoot: d.prevRoot,
  parentUtxo: coin(d.parentUtxo), childUtxo: coin(d.childUtxo), fee: BigInt(d.fee), computeBudget: d.computeBudget,
});
if (toHex(built.childSighash) !== d.childSighash) {
  console.error("REFUSED: the digest the runner asks you to sign is not the digest of the transaction this document describes. Nothing was signed.");
  process.exit(1);
}
const kas = (s: bigint) => (Number(s) / 1e8).toString();
console.log(`\n  ${d.says}\n`);
console.log(`  helper   ${d.child.agent}  budget ${kas(childState.budgetTotal)} KAS, spent ${kas(childState.spentTotal)} KAS`);
console.log(`  parent   ${d.parent.agent}  reserve ${kas(parentState.reserved)} → ${kas(built.successorState.reserved)} KAS`);
console.log(`  coin     ${kas(built.recovered)} KAS lands in ${d.parent.agent}'s grant (network fee ${kas(BigInt(d.fee))} KAS)`);
console.log(`  output   the parent's own covenant — nobody else is paid by this transaction\n`);
if (process.argv.includes("--dry-run")) { console.log("  dry run: nothing signed, nothing sent."); process.exit(0); }
const keyPath = flag("key");
if (!keyPath) { console.error("--key <file>: your revocation key (64 hex characters)"); process.exit(2); }
const secret = fromHex(readFileSync(keyPath, "utf8").trim());
if (toHex(agentPublicKey(secret)) !== d.authority.revocationKey) {
  console.error(`REFUSED: ${keyPath} is not the revocation key these grants name (${d.authority.revocationKey.slice(0, 16)}…). Nothing was signed.`);
  process.exit(1);
}
const sig = signDigest(built.childSighash, secret);
if (!verifyDigest(sig, built.childSighash, fromHex(d.authority.revocationKey))) { console.error("the signature did not verify"); process.exit(1); }
const res = await fetch(`${String(d.runner).replace(/\/$/, "")}/v1/returns/${d.id}/signature`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: toHex(sig) }),
});
/* Typed at the boundary rather than trusted: `res.json()` is `unknown`, and
   the four reads below are the only thing this tool prints. A shape stated
   here is a shape the compiler can hold us to; `unknown` spread across four
   template holes is four silent `undefined`s if the runner ever renames a
   field. Every one is optional because this is a remote answer and the error
   path reaches the first of them. */
type ReturnAck = { error?: string; recoveredKas?: string | number; parent?: string; txid?: string };
const out = (await res.json().catch(() => ({}))) as ReturnAck;
if (!res.ok) { console.error(`the runner refused: ${out.error ?? res.status}`); process.exit(1); }
console.log(`  done. ${out.recoveredKas} KAS is back in ${out.parent}'s grant.\n  transaction ${out.txid}`);
