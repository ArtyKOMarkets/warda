/**
 * Is the runner's Turnkey user still NOT a root user?
 *
 *   node --experimental-strip-types runner/tools/turnkey-whoami.ts
 *
 * ## Why this is worth its own tool
 *
 * Every safety claim in `runner/DESIGN.md` rests on one sentence: "The
 * runner's key is a NON-ROOT Turnkey user — policies do not apply to root
 * users." If `warda-runner` is ever added to the root quorum, the scoped
 * policy stops applying to it and a leaked runner credential can export every
 * agent wallet. Nothing would look different. The policy would still be
 * listed, still say what it says, and mean nothing.
 *
 * `turnkey-lockdown.ts` established the property once, on 22 September, and
 * nothing has re-checked it since — which is the same shape as everything else
 * found here this week: a fact that was true when it was written down, with
 * nothing arranged to notice it changing.
 *
 * ## What it does and does not prove
 *
 * It reads. It reports the runner's user, whether that user appears in the
 * organisation's root quorum, and which policies name it.
 *
 * If the read itself is refused, it says SO rather than passing: "could not
 * check" and "checked and fine" are different answers, and collapsing them is
 * how a monitor comes to mean nothing. Read-only throughout — it creates
 * nothing, so it leaves no pending activity behind, which is why it is safe to
 * run as often as you like.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const keyPath = join(homedir(), ".warda", "turnkey-runner.json");
if (!existsSync(keyPath)) {
  console.error(`${keyPath} does not exist — the runner has no restricted key yet.`);
  process.exit(2);
}
const rk = JSON.parse(readFileSync(keyPath, "utf8")) as {
  organizationId: string; publicKey: string; privateKey: string; user?: string; userId?: string;
};

const { Turnkey } = await import("@turnkey/sdk-server");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = new Turnkey({
  apiBaseUrl: process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com",
  apiPublicKey: rk.publicKey,
  apiPrivateKey: rk.privateKey,
  defaultOrganizationId: rk.organizationId,
}).apiClient() as any;

const org = rk.organizationId;
let userId = rk.userId ?? "";
try {
  const who = await api.getWhoami({ organizationId: org });
  userId = who.userId ?? userId;
  console.log(`runner user : ${who.username ?? rk.user ?? "(unnamed)"}  ${userId}`);
} catch (e) {
  console.error(`could not read whoami with the runner's key: ${(e as Error).message}`);
  process.exit(1);
}

let verdict = "unknown";
try {
  /* getOrganizationConfigs, not getOrganization. The API has a
     GetOrganization endpoint and the SDK client does not expose it — the
     types are generated from the whole API surface, the client is not, and
     the first version of this tool guessed from the types and called a
     function that does not exist. It reported "could not check" and exited 3,
     which is the behaviour this was written to have and the only reason the
     mistake was not a green tick.

     The configs carry `quorum: { threshold, userIds }`, which is the root
     quorum — the same numbers the dashboard's Root Quorum page shows. */
  const cfg = await api.getOrganizationConfigs({ organizationId: org });
  const quorum = cfg?.configs?.quorum;
  if (!quorum) throw new Error("the organisation configs carried no quorum");
  const members: string[] = quorum.userIds ?? [];
  console.log(`root quorum : ${members.length} member(s), threshold ${quorum.threshold ?? "?"}`);
  verdict = members.includes(userId) ? "IN" : "out";
} catch (e) {
  console.error(
    `\n? could not read the organisation's root quorum with the runner's key:\n` +
      `    ${String((e as Error).message).replace(/\s+/g, " ").slice(0, 160)}\n` +
      `  That is not a pass. Check it in the dashboard — Root Quorum — and make sure\n` +
      `  the only member is a human.`,
  );
  process.exit(3);
}

if (verdict === "IN") {
  console.error(
    `\n✗ the runner's user IS a member of the root quorum.\n\n` +
      `  Policies do not apply to root users, so the scoped policy this project relies on\n` +
      `  applies to nothing. A leaked runner credential can export every agent wallet —\n` +
      `  which is every agent's private key, and the grants they hold.\n\n` +
      `  Remove it from the quorum in the dashboard. Everything runner/DESIGN.md says\n` +
      `  about what a leaked runner credential cannot do is false until you do.`,
  );
  process.exit(1);
}
console.log(`root member : no — policies apply to it, which is what everything else assumes`);

try {
  const ps = (await api.getPolicies({ organizationId: org })).policies as
    { policyId: string; policyName: string; condition?: string }[];
  const mine = ps.filter((p) => (p.condition ?? "").includes(userId) || p.policyName.startsWith("warda-runner"));
  console.log(`policies    : ${mine.length} naming this user`);
  for (const p of mine) console.log(`    ${p.policyId}  ${p.policyName}`);
} catch {
  console.log(`policies    : not readable with this key (not an error — it may sign, not administer)`);
}
