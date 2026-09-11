/**
 * Finding a purchase that was paid for and never delivered.
 *
 * Exit 4 — "the money is gone, do NOT retry" — was honest and useless. It told
 * the operator not to run the command again while offering no other way to get
 * what they had already bought, so the choices were to lose the purchase or to
 * pay for it twice. Both are wrong and one of them is expensive.
 *
 * The purchase log already survived the process. It just did not hold the one
 * value that could finish the transaction: the X-PAYMENT header, which existed
 * only inside `wardaFetch` and only for the length of the call. It is recorded
 * now, as soon as the payment settles and before delivery is attempted, and
 * this reads the newest unfinished one back.
 *
 * Separate from buy.ts because this is the part with branches worth testing,
 * and buy.ts cannot be imported without a node, a grant and a key.
 */
import { readFileSync, readdirSync } from "node:fs";

export interface Pending {
  /** The record this came from, so a successful redemption can close it. */
  file: string;
  header: string;
  txid: string;
  amountSompi: string;
  payTo?: string;
}

/**
 * The three outcomes that mean money moved and goods did not.
 *
 * `bought` is finished. `refused` and `failed` never paid. Resuming any of
 * those would be a second purchase wearing a recovery's clothes, which is the
 * exact mistake this module exists to prevent — so the set is allow-list
 * shaped, and an outcome nobody has thought of yet is not resumable.
 */
export const UNFINISHED = new Set(["paid-pending", "paid-but-refused", "paid-then-failed"]);

export function findResumable(dir: string, forUrl: string): Pending | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    // No directory yet is the ordinary case on a first run, not an error.
    return null;
  }
  /* Newest first. The file names are ISO timestamps, so a reverse sort is
     chronological. If two runs both paid and neither delivered, the later
     proof is the one still owed; redeeming the earlier one here would deliver
     against the wrong debt and leave the newer one looking unpaid. */
  for (const f of files.reverse()) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    } catch {
      // A truncated record is a record written by a process that died. It is
      // evidence of exactly the failure this handles, and it is unreadable, so
      // there is nothing to do but keep looking.
      continue;
    }
    if (rec.url !== forUrl) continue;
    if (rec.resolvedBy) continue;
    if (!UNFINISHED.has(String(rec.outcome))) continue;
    const proof = rec.proof as Record<string, unknown> | undefined;
    if (!proof?.header || !proof?.txid) continue;
    return {
      file: `${dir}/${f}`,
      header: String(proof.header),
      txid: String(proof.txid),
      amountSompi: String(proof.amountSompi ?? ""),
      payTo: proof.payTo ? String(proof.payTo) : undefined,
    };
  }
  return null;
}

/**
 * The body of a purchase record, with the proof attached whatever happened.
 *
 * Pure, and separate from the file write, because the bug this exists to
 * prevent was not in the writing. Every record for one run shares a path, so
 * the last write wins — and on a failed purchase the last write is the catch
 * block, which did not carry the proof. The paid-pending record that existed
 * to survive a failure was therefore destroyed BY the failure, and the header
 * with it. Exit 4 left a txid and nothing to redeem it with: the same
 * unrecoverable purchase as before, now wearing a recovery's clothes.
 *
 * Attaching it here rather than at each call site means no future outcome can
 * forget. A record that names a payment must carry the means to finish it.
 */
export function withProof(
  base: Record<string, unknown>,
  proof: Pick<Pending, "header" | "txid" | "amountSompi" | "payTo"> | undefined,
): Record<string, unknown> {
  if (!proof) return { ...base };
  return {
    proof: {
      header: proof.header,
      txid: proof.txid,
      amountSompi: proof.amountSompi,
      payTo: proof.payTo ?? null,
    },
    ...base,
  };
}
