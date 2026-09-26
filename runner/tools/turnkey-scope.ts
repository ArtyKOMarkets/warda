/**
 * Narrow the runner's Turnkey policy from an ACTIVITY to an ACTIVITY ON A RESOURCE.
 *
 *   node --experimental-strip-types runner/tools/turnkey-scope.ts
 *   node --experimental-strip-types runner/tools/turnkey-scope.ts --dry-run
 *
 * ## What is wrong today
 *
 * `runner/DESIGN.md` used to promise `SIGN_RAW_PAYLOAD` "on agent wallets
 * only". The deployed condition names activity types and nothing else:
 *
 *     activity.type == 'ACTIVITY_TYPE_CREATE_WALLET'
 *       || activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'
 *
 * so the runner's key may sign with ANY wallet the organisation holds. That
 * the organisation holds only agent wallets makes the gap harmless and the
 * property accidental, which is not the same as safe — the first treasury
 * wallet somebody creates in that org is signable by a key that exists to
 * spend agent grants.
 *
 * ## Why not tags
 *
 * `MAINNET.md` §3.4 says "agent wallets tagged and the policy conditioned on
 * the tag". Turnkey's policy language does not offer that: `tags` is a field
 * of the `PrivateKey` struct, and `Wallet` and `WalletAccount` have no tags
 * field at all. The runner creates WALLETS. So the prescribed fix is not
 * expressible, and the item said "done means" about something that cannot be
 * done — which is worth more than the fix itself, because a before-mainnet
 * list whose remedies are impossible is a list that stalls without saying why.
 *
 * What the language does offer for a wallet is `label`, string equality, and
 * range slicing. The runner names every wallet it creates `warda-<agent>`
 * (`runner/src/vault-turnkey.ts`), so the prefix IS the resource scope:
 *
 *     wallet.label[0..6] == 'warda-'
 *
 * Narrower than today and weaker than a tag: the runner may create wallets, so
 * it can mint a `warda-` label at will. What it closes is the wallet somebody
 * ELSE put in the organisation, which is the whole of the exposure.
 *
 * ## Why this tool exists rather than a dashboard click
 *
 * Two reasons, and the first is the important one.
 *
 * A condition that never matches denies everything, and the runner would stop
 * signing — a production outage introduced by a security fix. Nothing in the
 * documentation promises that `wallet` is populated for
 * `SIGN_RAW_PAYLOAD_V2`; it says "the target wallet used in sign + export
 * requests", which reads right and is not a guarantee. So this PROVES the
 * positive case after narrowing and rolls the policy back if it fails.
 *
 * And a refusal means nothing unless you can name what it is a refusal of. So
 * before narrowing anything, it creates a wallet the new condition will
 * exclude and signs with it, and REQUIRES that to succeed. If signing with a
 * non-agent wallet is already refused, the gap is not what this is fixing and
 * nothing should be changed on that belief.
 *
 * Order: prove the gap, narrow, prove the gap is closed, prove the runner
 * still works, prove nothing else opened. Roll back on any of the last three.
 *
 * Reads root credentials from runner/.env and the runner's own key from
 * ~/.warda/turnkey-runner.json. Prints no secret.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./env.ts";
import { credentialsFile } from "../src/vault-turnkey.ts";

loadEnv();
const DRY = process.argv.includes("--dry-run");

/** The scope. Kept here, in one place, and checked against DESIGN.md by
 *  ops/check-runner.mjs so the prose and the policy cannot drift. */
export const AGENT_PREFIX = "warda-";
export const SCOPED_CONDITION =
  "activity.type == 'ACTIVITY_TYPE_CREATE_WALLET' || " +
  `(activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && wallet.label[0..${AGENT_PREFIX.length}] == '${AGENT_PREFIX}')`;

if (DRY) {
  console.log("the condition this would install:\n");
  console.log("  " + SCOPED_CONDITION.replace(" || ", "\n    || "));
  console.log(`\nnothing was read from Turnkey and nothing was changed.`);
  process.exit(0);
}

const file = process.env.TURNKEY_KEY_FILE ? credentialsFile(process.env.TURNKEY_KEY_FILE) : {};
const org = process.env.TURNKEY_ORGANIZATION_ID || file.TURNKEY_ORGANIZATION_ID;
const runnerKeyPath = join(homedir(), ".warda", "turnkey-runner.json");
if (!existsSync(runnerKeyPath)) {
  console.error(`${runnerKeyPath} does not exist — run runner/tools/turnkey-lockdown.ts first.`);
  process.exit(2);
}
const rk = JSON.parse(readFileSync(runnerKeyPath, "utf8")) as { publicKey: string; privateKey: string; userId?: string };

/* The ROOT key. It is needed for exactly three things: reading the policy,
   creating the decoy wallet the runner must be refused, and updating the
   policy. Everything that has to be DENIED is attempted with the runner's key,
   because a refusal earned by the wrong credential proves nothing. */
const rootPub = process.env.TURNKEY_API_PUBLIC_KEY || file.TURNKEY_API_PUBLIC_KEY;
const rootPriv = process.env.TURNKEY_API_PRIVATE_KEY || file.TURNKEY_API_PRIVATE_KEY;
if (!org || !rootPub || !rootPriv) {
  console.error(
    "runner/.env needs TURNKEY_ORGANIZATION_ID and the ROOT key (TURNKEY_KEY_FILE),\n" +
      "which turnkey-lockdown.ts told you to take offline. This is the one job it is\n" +
      "still needed for; put it back for this run and remove it again afterwards.",
  );
  process.exit(2);
}

const { Turnkey } = await import("@turnkey/sdk-server");
const base = process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com";
const clientFor = (pub: string, priv: string) =>
  new Turnkey({ apiBaseUrl: base, apiPublicKey: pub, apiPrivateKey: priv, defaultOrganizationId: org })
    .apiClient() as unknown as Record<string, (a: unknown) => Promise<never>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const root = clientFor(rootPub, rootPriv) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runner = clientFor(rk.publicKey, rk.privateKey) as any;

const step = (s: string) => console.log(`• ${s}`);
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const P2TR = "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR";
const ACCOUNT = {
  curve: "CURVE_SECP256K1",
  pathFormat: "PATH_FORMAT_BIP32",
  path: "m/86'/1'/0'/0/0",
  addressFormat: P2TR,
};

/**
 * Sign 32 random bytes with a wallet account.
 *
 * THREE answers, not two, and the third is the one this tool got wrong on its
 * first live run. It asked "was it refused?" and treated every error as a
 * policy refusal — so an organisation whose signing was disabled for being
 * over a plan limit read as "the policy already denies this", and the tool
 * reported a conclusion about the policy from an error that had nothing to do
 * with it.
 *
 * That is the exact failure `covenant/AUDIT.md` opens by warning about, in a
 * different medium: a refusal proves something only when you can name what it
 * is a refusal OF. Turnkey names it — code 7 is the policy engine, code 8 is
 * the account — and the distinction was thrown away by `catch (e)`.
 */
/* One shape, not a union.
   It was `{ ok: true } | { ok: false; denied; why }`, which reads better and does
   not typecheck at the call sites: those go `if (v.ok) await rollback(...)` and
   then read `v.denied`, and an AWAITED never-returning call does not narrow — TS
   only treats a direct call to a never-returning function as terminating. Three
   errors, in a tool that had never been compiled because it is deliberately not
   run from here. A flat record makes `denied` and `why` legal to read whatever
   `ok` says, and `ok: true` fills them with the only honest values. */
type Verdict = { ok: boolean; denied: boolean; why: string };

function classify(message: string): { denied: boolean; why: string } {
  const why = message.replace(/\s+/g, " ").trim();
  /* Turnkey's gRPC codes come through in the message. 7 PERMISSION_DENIED is
     the policy engine saying no, which is the only refusal that means
     anything here. 8 RESOURCE_EXHAUSTED is the account — a plan limit, a
     quota, billing — and says nothing about what the key may do. */
  const denied = /error 7\b|permission denied|not authorized|policy/i.test(why);
  return { denied, why };
}

async function canSign(address: string): Promise<Verdict> {
  try {
    await runner.signRawPayload({
      signWith: address,
      payload: Buffer.from(randomBytes(32)).toString("hex"),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NO_OP",
    });
    return { ok: true, denied: false, why: "the signature was ACCEPTED" };
  } catch (e) {
    return { ok: false, ...classify(String((e as Error).message)) };
  }
}

/* ---- the policy as it stands ------------------------------------------- */
const policies = (await root.getPolicies({ organizationId: org })).policies as
  { policyId: string; policyName: string; condition?: string; notes?: string }[];
const mine = policies.filter((p) => p.policyName.startsWith("warda-runner"));
if (mine.length !== 1) {
  console.error(
    `expected exactly one policy named "warda-runner…", found ${mine.length}.\n` +
      `  ${mine.map((p) => `${p.policyId} ${p.policyName}`).join("\n  ") || "(none)"}\n` +
      `Narrowing the wrong policy, or one of several, is not something to guess at.`,
  );
  process.exit(1);
}
const policy = mine[0]!;
const before = policy.condition ?? "";
step(`policy ${policy.policyId}: ${policy.policyName}`);
console.log(`    condition now: ${before}`);
if (before === SCOPED_CONDITION) {
  console.log("\nalready scoped. Nothing to do.");
  process.exit(0);
}

/* ---- 1. the gap, demonstrated ------------------------------------------ */
const decoyName = `not-an-agent-${stamp}`;
const decoy = await root.createWallet({ walletName: decoyName, accounts: [ACCOUNT] });
const decoyAddress: string = decoy.addresses[0];
step(`root created "${decoyName}" — a wallet the runner has no business signing with`);

const gap = await canSign(decoyAddress);
if (!gap.ok && !gap.denied) {
  console.error(
    `\n✗ signing did not work AT ALL, and not because of the policy:\n\n` +
      `    ${gap.why}\n\n` +
      `  This says nothing about what the runner's key is permitted to do, so there is\n` +
      `  nothing here to narrow and nothing was changed. It does say something more\n` +
      `  urgent: if the organisation cannot sign, THE RUNNER CANNOT SIGN — every agent\n` +
      `  transaction it is asked to build fails at the last step. Fix that first and run\n` +
      `  this again. Delete the wallet "${decoyName}".`,
  );
  process.exit(1);
}
if (!gap.ok) {
  console.error(
    `\n✗ the runner's key is ALREADY refused by POLICY on a non-agent wallet: ${gap.why}\n` +
      `  Then the gap this tool exists to close is not the gap you have, and the policy\n` +
      `  should not be rewritten on a belief that just turned out to be wrong. Nothing\n` +
      `  was changed. Delete the wallet "${decoyName}".`,
  );
  process.exit(1);
}
step(`the runner signed with it — the gap is real, not theoretical`);

/* ---- 2. narrow ---------------------------------------------------------- */
await root.updatePolicy({
  policyId: policy.policyId,
  policyCondition: SCOPED_CONDITION,
  policyNotes:
    `Scoped to wallets labelled ${AGENT_PREFIX}* on 25 September 2026 by runner/tools/turnkey-scope.ts. ` +
    `Wallet has no tags field in Turnkey's policy language, so the label prefix is the resource scope.`,
});
step("policy updated");

/* `Promise<never>`, so that `if (v.ok) await rollback(...)` NARROWS.
   It did not, and the file stopped typechecking the moment `Verdict` grew a
   second shape: after the `if`, `after` was still the union, so reading
   `.denied` was an error. Declaring what this actually does — it exits —
   is both the fix and the truth. */
const rollback = async (why: string): Promise<never> => {
  await root.updatePolicy({ policyId: policy.policyId, policyCondition: before });
  console.error(`\n✗ ${why}`);
  console.error(`  The policy has been ROLLED BACK to:\n    ${before}`);
  console.error(`  The runner is signing as it was. Delete the wallet "${decoyName}".`);
  process.exit(1);
};

/* ---- 3. the gap is closed ---------------------------------------------- */
const after = await canSign(decoyAddress);
if (after.ok) {
  await rollback("the runner can STILL sign with a non-agent wallet. The condition did not bind.");
}
if (!after.denied) {
  /* The refusal this tool exists to produce has to come from the POLICY. An
     account-level failure would refuse an agent wallet just as readily, so
     accepting it here would report a scope that was never installed. */
  await rollback(
    `the runner was refused on "${decoyName}", but not by the policy:\n    ${after.why}\n` +
      `  A refusal for the wrong reason proves nothing about the condition just installed.`,
  );
}
step(`refused BY POLICY on "${decoyName}" (${after.why.slice(0, 70)}…)`);

/* ---- 4. and the runner still works ------------------------------------- */
/* The half that makes this safe to run. A condition that matches nothing
   passes step 3 perfectly and takes the runner down. */
const liveName = `${AGENT_PREFIX}scope-probe-${stamp}`;
const live = await runner.createWallet({ walletName: liveName, accounts: [ACCOUNT] });
const liveAddress: string = live.addresses[0];
const still = await canSign(liveAddress);
if (!still.ok) {
  await rollback(
    `the runner can no longer sign with an AGENT wallet either (${still.why}).\n` +
      `  Most likely \`wallet\` is not populated for SIGN_RAW_PAYLOAD_V2, which the\n` +
      `  documentation implies and does not promise. This is exactly why it was tried.`,
  );
}
step(`still signs with "${liveName}" — agent wallets unaffected`);

/* ---- 5. nothing else opened -------------------------------------------- */
const probes: [string, () => Promise<unknown>][] = [
  ["export a wallet", () => runner.exportWallet({ walletId: live.walletId, targetPublicKey: rk.publicKey })],
  ["delete wallets", () => runner.deleteWallets({ walletIds: [live.walletId], deleteWithoutExport: true })],
  ["write itself a wider policy", () => runner.createPolicy({
    policyName: "warda-runner-scope-probe", effect: "EFFECT_ALLOW", consensus: "false", condition: "false",
    notes: "Probe from runner/tools/turnkey-scope.ts. Allows nothing to nobody. Reject it.",
  })],
  ["add a user tag", () => runner.createUserTag({ userTagName: "warda-runner-scope-probe", userIds: [] })],
  ["update the policy it is bound by", () => runner.updatePolicy({ policyId: policy.policyId, policyCondition: "true" })],
];
const allowed: string[] = [];
for (const [what, run] of probes) {
  try {
    await run();
    allowed.push(what);
  } catch {
    step(`refused: ${what}`);
  }
}
if (allowed.length) {
  await rollback(`narrowing the condition ALLOWED ${allowed.length} thing(s) it should not: ${allowed.join(", ")}`);
}

console.log(`
Done. The policy now reads:

  ${SCOPED_CONDITION.replace(" || ", "\n    || ")}

In the Turnkey dashboard:
  • Wallets: delete "${decoyName}" and "${liveName}". Both are empty.
  • Reject any pending activity named "warda-runner-scope-probe".
  • Take the root API key offline again.

And in runner/DESIGN.md the promise is now one the policy keeps.`);
