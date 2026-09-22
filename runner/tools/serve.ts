/**
 * Run the runner on this machine: the API on a port, and the tick in-process.
 *
 *   node --experimental-strip-types runner/tools/serve.ts
 *
 * Reads runner/.env, then ops/node.env (for WARDA_RPC_JSON; without it the
 * runner uses the public resolvers). Required: DATABASE_URL,
 * RUNNER_TICK_SECRET (≥16 chars), RUNNER_FEE_PAYEE, and either the Turnkey
 * variables (TURNKEY_ORGANIZATION_ID + TURNKEY_KEY_FILE or the two API key
 * vars) or RUNNER_MASTER_KEY for the envelope vault. Optional: PORT (8787),
 * RUNNER_TICK_MS (20000), RUNNER_BASE_URL, RUNNER_SIGNUP_CODE, fees,
 * TELEGRAM_BOT_TOKEN, RUNNER_OWNER_TELEGRAM. Wiring lives in src/boot.ts, the
 * same code the hosted runner runs.
 */
import { createServer } from "node:http";
import { boot, nodeHandler } from "../src/boot.ts";
import { loadEnv } from "./env.ts";

loadEnv();
loadEnv(new URL("../../ops/node.env", import.meta.url).pathname);

const port = Number(process.env.PORT ?? 8787);
const runner = await boot(process.env, { baseUrl: `http://localhost:${port}` });
console.error(`vault    : ${runner.vault}`);
console.error(`chain    : ${runner.chain === "node" ? "your node (WARDA_RPC_JSON)" : "public resolvers, over borsh"}`);
createServer(nodeHandler(runner.api, runner.baseUrl)).listen(port, () => console.error(`runner   : ${runner.baseUrl}`));

let ticking = false;
setInterval(async () => {
  if (ticking) return; // a slow tick is skipped, never overlapped
  ticking = true;
  try {
    const r = await runner.tick();
    for (const a of r.funded) console.error(`funded   : ${a} — deposit turned into its grant`);
    if (r.started.length || r.missed) console.error(`tick     : ${r.started.length} run(s), ${r.missed} missed`);
  } catch (e) {
    console.error(`tick     : ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}, Number(process.env.RUNNER_TICK_MS ?? 20_000));
