/**
 * Create (or bring up to date) the runner's tables in the database named by
 * DATABASE_URL — runner/.env locally, the project's env on Vercel.
 *
 *   node --experimental-strip-types runner/tools/migrate.ts
 *
 * Idempotent: every statement is `create … if not exists`. Prints the host
 * and the tables, never the credentials.
 */
import { Pool } from "@neondatabase/serverless";
import { migrate } from "../src/store-pg.ts";
import { loadEnv } from "./env.ts";

loadEnv();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (runner/.env or the environment)");
  process.exit(2);
}
const pool = new Pool({ connectionString: url });
try {
  await migrate(pool);
  const { rows } = await pool.query(
    `select table_name from information_schema.tables where table_name like 'runner_%' order by 1`,
  );
  console.log(`migrated ${new URL(url).host}`);
  for (const r of rows) console.log(`  ${r.table_name}`);
} finally {
  await pool.end();
}
