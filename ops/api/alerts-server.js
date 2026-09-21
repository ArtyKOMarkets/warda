/**
 * Every account's alert rules, evaluated once per call. Called by
 * /api/account?op=cron — from Vercel's cron and from any machine that holds
 * CRON_SECRET (ops/alerts.sh on the node host can call it every 15 minutes).
 *
 * The same contract as ops/alerts.ts, which runs beside a node: it notifies
 * and never acts; only CHANGES are sent, including the change back; a rule
 * that cannot be read says so once and is never reported as fine.
 *
 * It reads through the verifier, which reads a node. It enforces nothing.
 *
 * Rule shapes (all amounts in sompi, as strings):
 *   balance-at-or-above { address, atOrAbove }
 *   budget-low          { grantKey, below }
 *   expiring            { grantKey, days }
 *   spending-anomaly    { grantKey, factor? = 2 }   last 24h vs the 7 days before
 * Every rule may carry { note, network = "testnet-10" }.
 */
const VERIFY = process.env.WARDA_VERIFY || "https://verify.wardaprotocol.com";
const DAY = 86400000, DAA_PER_DAY = 864000;

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) throw new Error((j && (j.message || j.error)) || "verifier answered " + r.status);
  return j;
}
const kas = (sompi) => {
  const n = BigInt(sompi), w = n / 100000000n, f = (n % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return w.toString() + (f ? "." + f : "");
};

export async function evaluate(q, opts) {
  const started = Date.now();
  const rules = await q(`select r.account_id, r.id, r.rule, r.state, a.telegram_chat_id
                         from rules r join accounts a on a.id = r.account_id
                         order by r.account_id, r.id limit 1000`);
  const grants = await q("select account_id, key, manifest from grants");
  const byKey = new Map(grants.map((g) => [g.account_id + "|" + g.key, g.manifest]));
  const readings = new Map();   // account|grantKey -> { remaining, daa } | Error

  async function readGrant(acc, key, network) {
    const k = acc + "|" + key;
    if (readings.has(k)) return readings.get(k);
    const m = byKey.get(k);
    let v;
    if (!m) v = new Error("the rule names a tracked grant this account no longer has");
    else {
      try {
        const j = await getJson(VERIFY + "/v1/verify", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ manifest: m, network: network || "testnet-10" }),
        });
        const r = j.result || {};
        if (!r.found) v = new Error("nothing at the address this manifest derives — it moved, or ended");
        else v = { remaining: BigInt(r.remaining.sompi), daa: Number((j.readFrom || {}).virtualDaaScore || 0), expiresAt: Number(m.expires_at) };
      } catch (e) { v = e; }
    }
    readings.set(k, v);
    return v;
  }

  /* One snapshot per tracked grant per hour: the history the anomaly rule
     reads, and the history a tracked grant's chart will read. */
  const seen = new Set();
  for (const g of grants) {
    if (Date.now() - started > 40000) break;
    const k = g.account_id + "|" + g.key;
    if (seen.has(k)) continue; seen.add(k);
    const [last] = await q("select at from snapshots where account_id = $1 and grant_key = $2 order by at desc limit 1", [g.account_id, g.key]);
    if (last && Date.now() - new Date(last.at).getTime() < 55 * 60000) continue;
    const v = await readGrant(g.account_id, g.key);
    if (!(v instanceof Error)) {
      await q("insert into snapshots (account_id, grant_key, remaining_sompi) values ($1, $2, $3) on conflict do nothing",
        [g.account_id, g.key, v.remaining.toString()]);
    }
  }
  await q("delete from snapshots where at < now() - interval '30 days'");

  let sent = 0, changed = 0, evaluated = 0;
  for (const row of rules) {
    if (Date.now() - started > 50000) break;
    const r = row.rule || {};
    let state, say;
    try {
      if (r.kind === "balance-at-or-above") {
        const j = await getJson(VERIFY + "/v1/grant/" + encodeURIComponent(r.address));
        const total = BigInt((j.result && j.result.found && j.result.total && j.result.total.sompi) || "0");
        state = total >= BigInt(r.atOrAbove) ? "firing" : "clear";
        say = state === "firing" ? `${r.address} holds ${kas(total)} KAS — at or above your ${kas(r.atOrAbove)}.`
          : `${r.address} is back below ${kas(r.atOrAbove)} KAS (${kas(total)} now).`;
      } else if (r.kind === "budget-low") {
        const v = await readGrant(row.account_id, r.grantKey, r.network);
        if (v instanceof Error) throw v;
        state = v.remaining < BigInt(r.below) ? "firing" : "clear";
        say = state === "firing" ? `Grant ${r.grantKey}: ${kas(v.remaining)} KAS of authority left — under your ${kas(r.below)}.`
          : `Grant ${r.grantKey} is above ${kas(r.below)} KAS again (${kas(v.remaining)}).`;
      } else if (r.kind === "expiring") {
        const v = await readGrant(row.account_id, r.grantKey, r.network);
        if (v instanceof Error) throw v;
        const left = (v.expiresAt - v.daa) / DAA_PER_DAY;
        state = left < Number(r.days) ? "firing" : "clear";
        say = state === "firing" ? (left <= 0 ? `Grant ${r.grantKey} has ended. Its balance is the principal's to reclaim.`
          : `Grant ${r.grantKey} ends in ${left < 1 ? Math.round(left * 24) + " hours" : left.toFixed(1) + " days"}.`)
          : `Grant ${r.grantKey} has more than ${r.days} days left.`;
      } else if (r.kind === "spending-anomaly") {
        const snaps = await q(`select at, remaining_sompi from snapshots where account_id = $1 and grant_key = $2
                               and at > now() - interval '8 days' order by at`, [row.account_id, r.grantKey]);
        const pts = snaps.map((s) => ({ t: new Date(s.at).getTime(), v: BigInt(String(s.remaining_sompi).split(".")[0]) }));
        const now = pts[pts.length - 1];
        const at = (t) => { let best = null; for (const p of pts) if (p.t <= t) best = p; return best; };
        const dayAgo = now && at(now.t - DAY);
        const first = pts[0];
        /* Three days of baseline before the last day, or no verdict. A rate
           from one data point is a coincidence with a number on it. */
        if (!now || !dayAgo || !first || dayAgo.t - first.t < 3 * DAY) {
          state = "insufficient";
          say = "";
        } else {
          const last24 = Number(dayAgo.v - now.v);
          const baseDays = (dayAgo.t - first.t) / DAY;
          const perDay = Number(first.v - dayAgo.v) / baseDays;
          const factor = Number(r.factor || 2);
          state = last24 > 0 && last24 > factor * Math.max(perDay, 1) ? "firing" : "clear";
          say = state === "firing"
            ? `Grant ${r.grantKey} spent ${kas(BigInt(Math.round(last24)))} KAS in the last 24 hours — ${perDay > 0 ? (last24 / perDay).toFixed(1) + "×" : "far above"} its usual ${kas(BigInt(Math.round(perDay)))} KAS a day.`
            : `Grant ${r.grantKey} is back to its usual spending.`;
        }
      } else {
        state = "undecided"; say = "Unknown rule kind.";
      }
    } catch (e) {
      state = "undecided";
      say = `Rule "${row.id}" could not be read: ${e.message}. This is no reading — not "fine".`;
    }
    evaluated++;

    const was = row.state;
    if (state === was) continue;
    changed++;
    /* Only a change a person can act on is sent: into firing, back out of
       firing, or into "could not read". Leaving "insufficient" is quiet. */
    const notify = state === "firing" || (state === "clear" && was === "firing") || state === "undecided";
    let text = null;
    if (notify && say) {
      text = (r.note ? r.note + "\n\n" : "") + say + "\n\n— Warda Console. This notifies; it never acts.";
      if (opts.telegramToken && row.telegram_chat_id) {
        try {
          const t = await fetch(`https://api.telegram.org/bot${opts.telegramToken}/sendMessage`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: row.telegram_chat_id, text, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(10000),
          });
          if (t.ok) sent++;
        } catch { /* recorded below either way */ }
      }
    }
    await q("update rules set state = $3, state_at = now(), last_message = coalesce($4, last_message) where account_id = $1 and id = $2",
      [row.account_id, row.id, state, text]);
  }
  return { evaluated, changed, sent, snapshots: seen.size, ms: Date.now() - started };
}
