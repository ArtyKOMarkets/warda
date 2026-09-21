#!/usr/bin/env node
/**
 * Is each fund route's probe-able leg actually open? Reads it from the chain.
 *
 *   node ops/check-routes.mjs           read, and write the result into site/src/routes.json
 *   node ops/check-routes.mjs --check   read and report; change nothing
 *
 * Today one leg can be probed: Igra's Hyperlane warp routes stop when Igra's
 * pausable ISM or pausable hook is paused, and both answer `paused()`
 * (OpenZeppelin Pausable, selector 0x5c975abb) on Igra's own RPC. Paused on
 * 20 September 2026 with no stated reason and no date — so the way to know it
 * has reopened is to ask the contract, not to wait for an announcement.
 *
 * A read that fails is NOT an answer. The leg keeps its last status, the file
 * is left alone, and the exit code says the probe did not run — "we could not
 * reach the RPC" and "the bridge is open" must never look alike.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = resolve(root, "site/src/routes.json");
const check = process.argv.includes("--check");
const routes = JSON.parse(readFileSync(file, "utf8"));
const legs = routes.networks.mainnet.legs;

async function call(rpc, to, data) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return j.result;
}

let failed = 0, changed = 0;
for (const [id, leg] of Object.entries(legs)) {
  const p = leg.probe;
  if (!p || !Array.isArray(p.paused)) continue;
  try {
    const answers = [];
    for (const addr of p.paused) {
      const res = await call(p.rpc, addr, "0x5c975abb");
      if (!/^0x[0-9a-f]{64}$/i.test(res || "")) throw new Error(`${addr} answered ${res}, not a bool`);
      answers.push({ addr, paused: BigInt(res) !== 0n });
    }
    const paused = answers.some((a) => a.paused);
    const status = paused ? "paused" : "live";
    console.log(`${id}: ${status} — ` + answers.map((a) => `${a.addr.slice(0, 10)}… ${a.paused ? "paused" : "open"}`).join(", "));
    if (leg.status !== status) {
      changed++;
      leg.status = status;
      if (paused) leg.since = new Date().toISOString().slice(0, 10);
      else {
        delete leg.since;
        leg.why = "Open: neither Igra's pausable ISM nor its hook reports paused. Check Hyperlane has listed Igra's routes again before sending a large amount.";
      }
    }
  } catch (e) {
    failed++;
    console.error(`${id}: NOT READ — ${e.message}. Its status stays "${leg.status}"; this is no reading, not an answer.`);
  }
}

if (!check && !failed) {
  routes.checkedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(file, JSON.stringify(routes, null, 2) + "\n");
  console.log(`routes: written (${changed} changed). Rebuild the site to publish it.`);
}
process.exit(failed ? 2 : 0);
