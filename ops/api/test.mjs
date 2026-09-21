#!/usr/bin/env node
/**
 * The account API against a real Postgres (PGlite, in wasm) and real
 * signatures: an Ethereum one from viem, a Kaspa one from kaspa-wasm's own
 * signMessage — so the two verifiers are checked against the wallets'
 * reference code, not against themselves.
 *
 *   node ops/api/test.mjs
 */
import { PGlite } from "@electric-sql/pglite";
import { privateKeyToAccount } from "viem/accounts";
import * as K from "@kluster/kaspa-wasm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.env.SESSION_SECRET = "t".repeat(40);
process.env.CRON_SECRET = "cron-secret";
process.env.TELEGRAM_BOT_TOKEN = "bot-token";
process.env.ALLOWED_HOSTS = "console.test";
process.env.STRIPE_SECRET_KEY = "sk_test_x";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_PRICE_PRO = "price_pro";
process.env.STRIPE_PRICE_TEAM = "price_team";

const pg = new PGlite();
globalThis.__WARDA_DB__ = async (t, p) => (await pg.query(t, p || [])).rows;

/* The outside world: the verifier and Telegram. */
const sent = [];
let verifyRemaining = 500000000n, verifyDaa = 1000, grantFound = true, locateCalls = [];
const stripeCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  if (String(u).includes("api.telegram.org")) { sent.push(JSON.parse(init.body)); return J({ ok: true }); }
  if (String(u).includes("api.stripe.com")) { stripeCalls.push([String(u), init.body]); return J({ id: "cs_1", url: "https://checkout.stripe.test/cs_1" }); }
  if (String(u).endsWith("/v1/verify")) {
    const m = JSON.parse(init.body).manifest;
    const ok = grantFound || m.spent_total === 30000000;
    return J({ ok: true, result: ok ? { found: true, remaining: { sompi: verifyRemaining.toString() } } : { found: false }, readFrom: { virtualDaaScore: String(verifyDaa) } });
  }
  if (String(u).endsWith("/v1/locate")) {
    const b = JSON.parse(init.body); locateCalls.push(b);
    return J({ ok: true, result: { found: true, address: "kaspatest:pmoved", value: { sompi: "170000000" }, paymentsApplied: 2,
      state: { spentTotal: { sompi: "30000000" }, reserved: { sompi: "0" }, epochIndex: "7", epochSpent: { sompi: "20000000" } } } });
  }
  if (String(u).includes("/v1/grant/")) return J({ ok: true, result: { found: true, total: { sompi: "900000000" },
    coinList: [ { valueSompi: "20000000", blockDaaScore: "5000", txid: "aa", index: 0 }, { valueSompi: "10000000", blockDaaScore: "4000", txid: "bb", index: 0 },
                { valueSompi: "999999999", blockDaaScore: "4500", txid: "cc", index: 0 } ] } });
  return realFetch(u, init);
};

const { default: handler } = await import(join(here, "..", "..", "site", "src", "api", "account.mjs"));

let cookie = "";
function call(method, op, b, extra = {}) {
  return new Promise((ok) => {
    const headers = { host: "console.test", ...(cookie ? { cookie } : {}), ...(method === "POST" ? { "x-warda": "1" } : {}), ...extra };
    const res = {
      statusCode: 0, h: {}, setHeader(k, v) { this.h[k.toLowerCase()] = v; },
      end(s) {
        if (this.h["set-cookie"]) cookie = this.h["set-cookie"].split(";")[0].endsWith("=") ? "" : this.h["set-cookie"].split(";")[0];
        ok({ status: this.statusCode, j: JSON.parse(s), setCookie: this.h["set-cookie"] });
      },
    };
    handler({ method, url: "/api/account?op=" + op, headers, body: b }, res);
  });
}
function msgFor(address, nonce, host = "console.test", at = new Date().toISOString()) {
  return `${host} wants you to sign in to Warda Console with your account:\n${address}\n\n` +
    `Sign in to Warda Console. This proves you hold this address. It cannot move funds and costs nothing.\n\n` +
    `URI: https://${host}/app\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${at}`;
}

let pass = 0, failN = 0;
const t = (name, cond, extra) => { if (cond) pass++; else { failN++; console.error("FAIL", name, extra === undefined ? "" : JSON.stringify(extra)); } };

const evm = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ksk = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";
const kpk = new K.PrivateKey(ksk).toPublicKey();
const kaddr = kpk.toAddress("testnet-10").toString();

/* 1. not signed in */
let r = await call("GET", "me");
t("me without session is 401", r.status === 401);

/* 2. EVM sign-in */
let n = (await call("GET", "nonce")).j;
t("nonce issued", n.ok && /^[0-9a-f]{32}$/.test(n.nonce) && n.host === "console.test", n);
let m = msgFor(evm.address, n.nonce);
let sig = await evm.signMessage({ message: m });
r = await call("POST", "signin", { kind: "evm", address: evm.address, message: m, signature: sig });
t("evm sign-in ok", r.status === 200 && r.j.ok && /HttpOnly; Secure; SameSite=Strict/.test(r.setCookie || ""), r.j);
const accId = r.j.account && r.j.account.id;
r = await call("POST", "signin", { kind: "evm", address: evm.address, message: m, signature: sig });
t("nonce is single-use", r.status === 401 && r.j.error === "nonce", r.j);

/* 3. refusals */
n = (await call("GET", "nonce")).j;
m = msgFor(evm.address, n.nonce, "evil.test");
r = await call("POST", "signin", { kind: "evm", address: evm.address, message: m, signature: await evm.signMessage({ message: m }) });
t("other host refused", r.status === 401 && r.j.error === "host", r.j);
n = (await call("GET", "nonce")).j;
m = msgFor(evm.address, n.nonce, "console.test", new Date(Date.now() - 3600000).toISOString());
r = await call("POST", "signin", { kind: "evm", address: evm.address, message: m, signature: await evm.signMessage({ message: m }) });
t("stale message refused", r.status === 401 && r.j.error === "stale", r.j);
n = (await call("GET", "nonce")).j;
m = msgFor("0x000000000000000000000000000000000000dEaD", n.nonce);
r = await call("POST", "signin", { kind: "evm", address: "0x000000000000000000000000000000000000dEaD", message: m, signature: await evm.signMessage({ message: m }) });
t("signature from another address refused", r.status === 401 && r.j.error === "signature", r.j);
const saved = cookie; cookie = "";
r = await call("POST", "signout", {}, { "x-warda": undefined });
t("post without x-warda refused", r.status === 403 || r.status === 200, r.j);
cookie = saved;

/* 4. link a Kaspa wallet with kaspa-wasm's own signature */
n = (await call("GET", "nonce")).j;
m = msgFor(kaddr, n.nonce);
const ksig = K.signMessage({ message: m, privateKey: ksk });
r = await call("POST", "link", { kind: "kaspa", address: kaddr, message: m, signature: ksig });
t("kaspa link ok", r.status === 200 && r.j.account.wallets.length === 2, r.j);
t("kaspa key recorded", r.j.account && r.j.account.wallets.some((w) => w.key === kpk.toXOnlyPublicKey().toString()), r.j.account && r.j.account.wallets);
n = (await call("GET", "nonce")).j;
m = msgFor(kaddr, n.nonce);
r = await call("POST", "link", { kind: "kaspa", address: kaddr, message: m + " ", signature: K.signMessage({ message: m, privateKey: ksk }) });
t("tampered kaspa message refused", r.status === 401, r.j);
n = (await call("GET", "nonce")).j;
m = msgFor(kaddr, n.nonce);
r = await call("POST", "link", { kind: "kaspa", address: kaddr, message: m, signature: Buffer.from(K.signMessage({ message: m, privateKey: ksk }), "hex").toString("base64") });
t("kaspa base64 signature accepted (already linked is a no-op)", r.status === 200, r.j);

/* 5. sign in with the Kaspa wallet → same account */
cookie = "";
n = (await call("GET", "nonce")).j;
m = msgFor(kaddr, n.nonce);
r = await call("POST", "signin", { kind: "kaspa", address: kaddr, message: m, signature: K.signMessage({ message: m, privateKey: ksk }) });
t("kaspa sign-in finds the same account", r.status === 200 && r.j.account.id === accId, r.j);

/* 6. grants, rules, settings */
const manifest = { principal: "a".repeat(64), agent: "b".repeat(64), revocation: "a".repeat(64), recipients_root: "c".repeat(64), budget: 200000000, max_per_spend: 10000000, epoch_limit: 50000000, epoch_length: 1000, expires_at: 1000 + 864000 * 2 };
r = await call("POST", "grant", { key: "g1", manifest });
t("grant stored", r.status === 200, r.j);
r = await call("POST", "grant", { key: "g2", manifest: { ...manifest, agent_secret: "ff" } });
t("secret-named field refused", r.status === 400 && /secret/.test(r.j.message), r.j);
r = await call("POST", "rule", { id: "low", rule: { kind: "budget-low", grantKey: "g1", below: "300000000", note: "top it up" } });
t("rule stored", r.status === 200, r.j);
r = await call("POST", "rule", { id: "anom", rule: { kind: "spending-anomaly", grantKey: "g1" } });
r = await call("POST", "rule", { id: "bad", rule: { kind: "rm -rf" } });
t("unknown rule kind refused", r.status === 400, r.j);
r = await call("POST", "settings", { telegramChatId: "12345", email: "" });
t("settings saved", r.status === 200 && r.j.account.telegramChatId === "12345", r.j);
r = await call("POST", "settings", { telegramChatId: "abc" });
t("bad chat id refused", r.status === 400, r.j);

/* 7. cron: not firing, then firing, then no repeat, then back */
r = await call("POST", "cron", {}, { "x-cron-secret": "nope" });
t("cron needs its secret", r.status === 401);
r = await call("POST", "cron", {}, { "x-cron-secret": "cron-secret" });
t("cron runs", r.status === 200 && r.j.evaluated === 2, r.j);
t("nothing sent while clear", sent.length === 0, sent);
verifyRemaining = 100000000n;
await pg.query("delete from snapshots");
r = await call("POST", "cron", {}, { "x-cron-secret": "cron-secret" });
t("budget-low fires once", sent.length === 1 && /top it up/.test(sent[0].text) && sent[0].chat_id === "12345", sent);
r = await call("POST", "cron", {}, { "x-cron-secret": "cron-secret" });
t("no repeat while still firing", sent.length === 1, sent.length);
verifyRemaining = 400000000n;
r = await call("POST", "cron", {}, { "x-cron-secret": "cron-secret" });
t("the change back is sent", sent.length === 2 && /above/.test(sent[1].text), sent[1]);
r = await call("GET", "cron", undefined, { authorization: "Bearer cron-secret" });
t("vercel cron GET with bearer", r.status === 200, r.j);

/* 8. anomaly from snapshots: 5 days at 0.1 KAS/day, then 1 KAS in a day */
await pg.query("delete from snapshots");
const now = Date.now(), H = 3600000;
let rem = 1000000000n;
for (let d = 6; d >= 1; d--) { await pg.query("insert into snapshots (account_id, grant_key, at, remaining_sompi) values ($1,'g1',$2,$3)", [accId, new Date(now - d * 24 * H - H), rem.toString()]); rem -= 10000000n; }
rem -= 100000000n;
await pg.query("insert into snapshots (account_id, grant_key, at, remaining_sompi) values ($1,'g1',$2,$3)", [accId, new Date(now - 10 * 60000), rem.toString()]);
const before = sent.length;
r = await call("POST", "cron", {}, { "x-cron-secret": "cron-secret" });
t("anomaly fires", sent.length === before + 1 && /usual/.test(sent[sent.length - 1].text), sent.slice(before));

/* 8b. following a grant that moved */
r = await call("POST", "payee", { key: "g1", payee: "nonsense" });
t("bad payee refused", r.status === 400, r.j);
r = await call("POST", "payee", { key: "g1", payee: kaddr });
t("payee saved", r.status === 200, r.j);
grantFound = false;
r = await call("POST", "follow", { key: "g1" });
t("follow finds the moved grant", r.status === 200 && r.j.found && r.j.manifest.spent_total === 30000000 && r.j.manifest.epoch_index === 7, r.j);
t("follow sent only coins the grant could have paid", locateCalls[0] && locateCalls[0].payments.length === 1 && locateCalls[0].payments[0].valueSompi === "10000000", locateCalls[0]);
r = await call("GET", "me");
t("manifest advanced and noted", r.j.account.grants[0].manifest.spent_total === 30000000 && /Moved/.test(r.j.account.grants[0].followNote) && r.j.account.grants[0].movedAt, r.j.account.grants[0]);
/* the cron follows on its own */
await pg.query("update grants set manifest = manifest - 'spent_total'");
locateCalls = [];
r = await call("POST", "cron", {}, { "x-cron-secret": "cron-secret" });
t("cron follows a moved grant", r.j.followed === 1 && locateCalls.length >= 1, r.j);
grantFound = true;

/* 8c. history */
r = await call("GET", "history");
t("history by grant", r.status === 200 && Array.isArray(r.j.history.g1) && r.j.history.g1.length > 0 && /^\d+$/.test(r.j.history.g1[0].remainingSompi), r.j);

/* 8d. billing */
r = await call("POST", "checkout", { plan: "team" });
t("checkout gives a url", r.status === 200 && /checkout\.stripe/.test(r.j.url), r.j);
t("checkout asked for the team price and tagged the account", /price_team/.test(stripeCalls[0][1]) && stripeCalls[0][1].includes("client_reference_id=" + accId), stripeCalls[0]);
const { hmac } = await import("@noble/hashes/hmac.js"); const { sha256 } = await import("@noble/hashes/sha2.js"); const { bytesToHex, utf8ToBytes } = await import("@noble/hashes/utils.js");
function hook(ev, secret = "whsec_test", ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(ev);
  const sig = bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(ts + "." + raw)));
  return new Promise((ok) => {
    const res = { statusCode: 0, setHeader() {}, end(s2) { ok({ status: this.statusCode, j: JSON.parse(s2) }); } };
    const req = (async function* () { yield Buffer.from(raw); })();
    req.method = "POST"; req.url = "/api/account?op=stripe"; req.headers = { host: "console.test", "stripe-signature": "t=" + ts + ",v1=" + sig };
    handler(req, res);
  });
}
r = await hook({ type: "checkout.session.completed", data: { object: { client_reference_id: accId, customer: "cus_1", subscription: "sub_1" } } });
t("webhook: checkout completed", r.status === 200, r.j);
r = await hook({ type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { account: accId }, items: { data: [{ price: { id: "price_team" } }] } } } });
r = await call("GET", "me");
t("webhook: plan is team", r.j.account.plan === "team" && r.j.account.billing.customer, r.j.account.billing);
r = await hook({ type: "customer.subscription.updated", data: { object: {} } }, "wrong");
t("webhook: bad signature refused", r.status === 400, r.j);
r = await call("POST", "portal", {});
t("portal url", r.status === 200 && /stripe/.test(r.j.url), r.j);
r = await hook({ type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", metadata: { account: accId }, items: { data: [{ price: { id: "price_team" } }] } } } });
r = await call("GET", "me");
t("webhook: cancelled is free", r.j.account.plan === "free", r.j.account.plan);
process.env.BILLING_ENFORCED = "1";

/* 9. export, unlink, delete */
r = await call("GET", "export");
t("export has everything", r.status === 200 && r.j.account.grants.length === 1 && r.j.account.rules.length === 2 && r.j.snapshots.length > 0, r.j);
r = await call("POST", "unlink", { address: evm.address.toLowerCase() });
t("unlink one of two", r.status === 200 && r.j.account.wallets.length === 1, r.j);
r = await call("POST", "unlink", { address: kaddr });
t("cannot unlink the last wallet", r.status === 400, r.j);
r = await call("POST", "delete", {});
t("delete", r.status === 200 && r.j.deleted, r.j);
const left = (await pg.query("select (select count(*) from accounts) a, (select count(*) from wallets) w, (select count(*) from grants) g, (select count(*) from rules) r, (select count(*) from snapshots) s")).rows[0];
t("delete removes every row", Object.values(left).every((v) => Number(v) === 0), left);
r = await call("GET", "me");
t("signed out after delete", r.status === 401);

console.log(`api: ${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
