/**
 * Which payments have been served, kept where every instance can see it.
 *
 * A serverless function is many processes. An in-memory store forgets on the
 * next cold start and is invisible to the instance beside it, so the same
 * payment could buy a record twice. The buyer loses nothing by that and the
 * seller loses a record; small, but "one payment, one record" is the promise,
 * so it lives in Postgres — the same Neon database the console's accounts use,
 * in a table of its own.
 */
import { neon } from "@neondatabase/serverless";
import type { SpentStore } from "@warda_protocol/vendor";

let ready: Promise<unknown> | null = null;

export function postgresSpent(url: string): SpentStore {
  const sql = neon(url);
  const q = (text: string, params: unknown[] = []) => sql.query(text, params);
  const init = () =>
    (ready ??= q("create table if not exists growth_spent (txid text primary key, at timestamptz not null default now())"));
  return {
    async has(txid) {
      await init();
      const rows = (await q("select 1 from growth_spent where txid = $1", [txid])) as unknown[];
      return rows.length > 0;
    },
    async add(txid) {
      await init();
      await q("insert into growth_spent (txid) values ($1) on conflict do nothing", [txid]);
    },
  };
}
