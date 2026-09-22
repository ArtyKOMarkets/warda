/* Every CLI command this console prints. It signs nothing, so a control here
   is the exact command that does the thing, who must sign it, and whether the
   chain would allow it now. ops/check-commands.mjs checks each verb and flag
   against cli/warda.ts — a revoke button printing a flag the CLI ignores is a
   button that silently does not revoke. */
/* warda-commands */
export const CMDS = {
  revoke: "warda revoke grant.json --key revocation.key --submit",
  revokeDry: "warda revoke grant.json --key revocation.key",
  reclaim: "warda reclaim grant.json --key principal.key --submit",
  topup: "warda topup --grant grant.json --key funder.key",
  topupDry: "warda topup --grant grant.json --key funder.key --dry-run",
  find: "warda find grant.json --vendor PAYEE --write",
  balance: "warda balance grant.json",
  ret: "warda return return.json --key revocation.key",
  grant: "warda grant --payees payees.txt --budget 10 --max-per-spend 1 --epoch-limit 2 --days 30 --revocation KEY --relay --out grant.json",
  key: "warda key --out revocation.key",
  consolidate: "warda wallet consolidate --key funder.key --submit",
};
/* end warda-commands */

export const SAY: Record<string, string> = {
  revoke: "Signed by the revocation key, at any moment. The balance goes back to the principal from the next block. Without --submit it builds the transaction, shows it, and sends nothing.",
  reclaim: "Signed by the principal, once the chain has passed the grant's expiry.",
  topup: "Issues a successor from KAS the funder already holds, with this grant's limits unless you say otherwise. It does not end this one — revoke it or let it expire.",
  find: "A grant's address changes with every payment. This follows it through a payment to one of its payees and rewrites the manifest.",
};

export function commandFor(k: "revoke" | "reclaim" | "topup" | "find", payee?: string | null): string {
  if (k === "revoke") return `${CMDS.revokeDry}        # look first\n${CMDS.revoke}`;
  if (k === "topup") return `${CMDS.topupDry}   # look first\n${CMDS.topup}`;
  if (k === "find") return CMDS.find.replace("PAYEE", payee || "<a payee it paid>");
  return CMDS.reclaim;
}
