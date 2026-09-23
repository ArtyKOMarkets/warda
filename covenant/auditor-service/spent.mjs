/**
 * Which payments have already been served.
 *
 * A coin at `PAY_TO` is a fact that stays true. Nothing about it expires, so a
 * buyer who paid once can present the same `X-PAYMENT` header forever and
 * every check in the vendor package passes every time. The only thing that
 * closes it is a seller remembering which transaction ids it has served, which
 * is state, which is why `SpentStore` is an interface the caller supplies
 * rather than something `priced()` can do on its own.
 *
 * The default `priced()` falls back to is `inMemorySpent()`, which is correct
 * for exactly one process and forgets on restart. This service restarts — a
 * new `scan` binary, a machine rebooting, a tunnel reconnecting — and every
 * restart would reopen every payment ever made to it. So the set is written
 * down.
 *
 * ## A file, and the shape of host that makes that right
 *
 * This service is one long-lived process behind a tunnel, because it shells
 * out to a Rust binary and cannot be serverless. For that host a file is the
 * whole answer: appends are atomic, the reader is the writer, and there is no
 * database to operate.
 *
 * It is NOT the answer for two processes. `has()` answers from a set loaded at
 * startup, so a second instance would not see the first's writes and would
 * serve a replay. That is a property of the deployment, not a bug to fix here
 * — if this ever runs in more than one place, `postgresSpent` in
 * `growth/deploy/lib/spent.ts` is the same interface against Neon, and it is
 * a one-line swap at the call site.
 *
 * ## What "recorded" means, exactly
 *
 * `settle` awaits `add()` BEFORE delivering, so a crash between the two costs
 * the buyer a purchase rather than leaving a payment replayable forever. This
 * honours that ordering as far as a file can: `add()` resolves after the
 * append syscall returns, which is not the same as after the disk has it. A
 * kernel panic in that window loses the record. Saying so is cheaper than
 * an fsync per sale and more honest than implying durability nobody measured.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const TXID = /^[0-9a-f]{64}$/;

export function fileSpent(path) {
  const seen = new Set();

  /* Read once, synchronously, before the server listens. A store that loads
     in the background answers `has()` with "no" until it finishes, and the
     window where that is wrong is exactly the window after a restart. */
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.trim().toLowerCase();
      /* Anything that is not a transaction id is not a record of a sale.
         Skipping it beats both trusting it and refusing to start: the file is
         append-only and the ids in it are still good. */
      if (TXID.test(t)) seen.add(t);
    }
  }

  let made = null;

  return {
    has: (txid) => seen.has(String(txid).toLowerCase()),

    async add(txid) {
      const t = String(txid).toLowerCase();
      made ??= mkdir(dirname(path), { recursive: true });
      await made;
      /* The file first, the set second. If the append throws, `settle` has not
         been told the payment was recorded, and it refuses the sale rather
         than delivering something it cannot remember selling. */
      await appendFile(path, `${t}\n`, "utf8");
      seen.add(t);
    },

    /** For the startup line: a store that silently loaded nothing looks
     *  exactly like a store that loaded correctly and had nothing to load. */
    count: () => seen.size,
  };
}
