/**
 * /api/account — console accounts. Bundled by ops/api/build.mjs into
 * site/src/api/account.mjs; do not edit the bundle.
 *
 * What an account is: one or more wallet addresses that proved, by signing a
 * plain-text message, that they belong together — plus what that person chose
 * to keep in sync (grant manifests, alert rules, where alerts go).
 *
 * What it never holds: a private key, a seed, an agent key, a card number, or
 * money. Signing in is a message signature; it cannot move a coin, and no
 * method that can is ever requested for it.
 *
 *   GET  ?op=nonce                    a single-use nonce, valid 5 minutes
 *   POST ?op=signin   {kind, address, message, signature, publicKey?}
 *   POST ?op=link     same, while signed in: add a wallet to this account
 *   POST ?op=signout
 *   GET  ?op=me                       account, wallets, grants, rules, settings
 *   POST ?op=grant    {key, manifest}      PUT one tracked grant
 *   POST ?op=ungrant  {key}
 *   POST ?op=rule     {id, rule}           PUT one alert rule
 *   POST ?op=unrule   {id}
 *   POST ?op=settings {email?, telegramChatId?}
 *   GET  ?op=export                   everything stored about this account
 *   POST ?op=delete                   the account and everything under it
 *   POST ?op=cron                     evaluate every rule; header x-cron-secret
 *   POST ?op=payee    {key, payee}        a payee the grant pays, so the server can follow it
 *   POST ?op=follow   {key}               find where a tracked grant moved, now
 *   GET  ?op=history                      hourly snapshots of every synced grant, 30 days
 *   POST ?op=checkout {plan}              a Stripe Checkout URL for pro or team
 *   POST ?op=portal                       a Stripe billing-portal URL
 *   POST ?op=stripe                       Stripe's webhook (signature-checked)
 *
 * Environment:
 *   DATABASE_URL (or POSTGRES_URL)  Neon / Vercel Postgres
 *   SESSION_SECRET                  32+ random characters; signs the cookie
 *   CRON_SECRET                     required by op=cron
 *   TELEGRAM_BOT_TOKEN              optional; without it alerts are recorded, not sent
 *   ALLOWED_HOSTS                   optional, comma-separated; default: the request's host
 *   STRIPE_SECRET_KEY               billing; without it every account stays on its plan
 *   STRIPE_WEBHOOK_SECRET           verifies Stripe's webhook
 *   STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM   the two subscription prices
 *   BILLING_ENFORCED                "1" to require a paid plan for sync and server alerts;
 *                                   until then everybody is on the beta, which has both
 */
import { neon } from "@neondatabase/serverless";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, randomBytes } from "@noble/hashes/utils.js";
import { decodeAddress } from "../../sdk/src/address.ts";
import { evaluate, follow } from "./alerts-server.js";

const SECRET = process.env.SESSION_SECRET || "";
const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const COOKIE = "warda_session";
const SESSION_DAYS = 30;
const LIMITS = { grants: 200, rules: 100, manifestBytes: 4096, ruleBytes: 2048 };

/* ---- the database ------------------------------------------------------------
   One function, q(text, params) → rows, so tests can hand in PGlite and
   production uses Neon's HTTP driver. The schema is created on first use —
   idempotent, and cheap enough to run once per cold start. */
let dbq = null, ready = null;
function db() {
  if (globalThis.__WARDA_DB__) dbq = globalThis.__WARDA_DB__;
  if (!dbq) { const sql = neon(DB_URL); dbq = (t, p) => sql.query(t, p || []); }
  if (!ready) ready = migrate(dbq);
  return ready.then(() => dbq);
}
const SCHEMA = [
  `create table if not exists accounts (
     id uuid primary key default gen_random_uuid(),
     created_at timestamptz not null default now(),
     plan text not null default 'beta',
     email text,
     telegram_chat_id text)`,
  `create table if not exists wallets (
     address text primary key,
     account_id uuid not null references accounts(id) on delete cascade,
     family text not null,
     key_hex text,
     added_at timestamptz not null default now())`,
  `create index if not exists wallets_account on wallets(account_id)`,
  `create table if not exists nonces (
     nonce text primary key,
     expires_at timestamptz not null)`,
  `create table if not exists grants (
     account_id uuid not null references accounts(id) on delete cascade,
     key text not null,
     manifest jsonb not null,
     added_at timestamptz not null default now(),
     primary key (account_id, key))`,
  `create table if not exists rules (
     account_id uuid not null references accounts(id) on delete cascade,
     id text not null,
     rule jsonb not null,
     state text,
     state_at timestamptz,
     last_message text,
     primary key (account_id, id))`,
  `create table if not exists snapshots (
     account_id uuid not null references accounts(id) on delete cascade,
     grant_key text not null,
     at timestamptz not null default now(),
     remaining_sompi numeric not null,
     primary key (account_id, grant_key, at))`,
];
/* Added after the first release; `if not exists` keeps them safe to re-run. */
SCHEMA.push(
  `alter table accounts add column if not exists stripe_customer text`,
  `alter table accounts add column if not exists stripe_subscription text`,
  `alter table accounts add column if not exists plan_status text`,
  `alter table grants add column if not exists payee text`,
  `alter table grants add column if not exists moved_at timestamptz`,
  `alter table grants add column if not exists follow_note text`,
);
async function migrate(q) { for (const s of SCHEMA) await q(s); }

/* ---- replies ------------------------------------------------------------------ */
function send(res, status, body, cookie) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  if (cookie) res.setHeader("set-cookie", cookie);
  res.end(JSON.stringify(body));
}
const fail = (res, status, error, message, cookie) => send(res, status, { ok: false, error, message }, cookie);
class Refuse extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } }

async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 16384) throw new Refuse(413, "body", "Request too large."); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/* ---- sessions -------------------------------------------------------------------
   A signed cookie, not a sessions table: base64url({a, e}) + "." + HMAC. It is
   httpOnly, Secure and SameSite=Strict, and every POST must also carry
   x-warda: 1 — a header a cross-site form cannot send. */
const b64u = (u8) => Buffer.from(u8).toString("base64url");
function mac(s) { return b64u(hmac(sha256, utf8ToBytes(SECRET), utf8ToBytes(s))); }
function makeSession(accountId) {
  const p = b64u(utf8ToBytes(JSON.stringify({ a: accountId, e: Date.now() + SESSION_DAYS * 86400000 })));
  return `${COOKIE}=${p}.${mac(p)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}
const clearSession = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
function sessionOf(req) {
  const raw = String(req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [p, m] = raw.slice(COOKIE.length + 1).split(".");
  if (!p || !m || mac(p) !== m) return null;
  try {
    const j = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    return j.e > Date.now() && typeof j.a === "string" ? j.a : null;
  } catch { return null; }
}

/* ---- the sign-in message ------------------------------------------------------------
   Plain text, in the EIP-4361 shape so an Ethereum wallet shows it as a sign-in
   rather than as an opaque blob. The server re-reads every field it relies on
   from the text that was signed — never from a field sent beside it. */
function hostsFor(req) {
  const env = (process.env.ALLOWED_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return env.length ? env : [String(req.headers["x-forwarded-host"] || req.headers.host || "")];
}
function parseMessage(text) {
  const lines = String(text || "").split("\n");
  const m = /^(\S+) wants you to sign in to Warda Console with your account:$/.exec(lines[0] || "");
  const field = (name) => { const l = lines.find((x) => x.startsWith(name + ": ")); return l ? l.slice(name.length + 2).trim() : null; };
  return { host: m && m[1], address: (lines[1] || "").trim(), nonce: field("Nonce"), issuedAt: field("Issued At") };
}

/* ---- signatures -------------------------------------------------------------------- */
function eip191(message) {
  const m = utf8ToBytes(message);
  return keccak_256(new Uint8Array([...utf8ToBytes("\x19Ethereum Signed Message:\n" + m.length), ...m]));
}
function evmRecover(message, sigHex) {
  const s = hexToBytes(String(sigHex).replace(/^0x/, ""));
  if (s.length !== 65) throw new Refuse(400, "signature", "An Ethereum signature is 65 bytes.");
  let v = s[64]; if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Refuse(400, "signature", "Unrecognised signature recovery byte.");
  const sig = secp256k1.Signature.fromBytes(s.slice(0, 64), "compact").addRecoveryBit(v);
  const pub = sig.recoverPublicKey(eip191(message)).toBytes(false);
  return "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}
/* rusty-kaspa's personal message: blake2b-256 keyed "PersonalMessageSigningHash",
   BIP340 Schnorr. Checked against kaspa-wasm's own signMessage in the tests. */
function kaspaHash(message) {
  return blake2b(utf8ToBytes(message), { dkLen: 32, key: utf8ToBytes("PersonalMessageSigningHash") });
}
function kaspaSigBytes(sig) {
  const s = String(sig || "").trim();
  if (/^[0-9a-f]{128}$/i.test(s)) return hexToBytes(s);
  const b = Buffer.from(s, "base64");
  if (b.length === 64) return new Uint8Array(b);
  if (b.length === 65) return new Uint8Array(b.subarray(1)); // a leading recovery/type byte
  throw new Refuse(400, "signature", "A Kaspa message signature is 64 bytes, as hex or base64.");
}
function kaspaVerify(message, address, sig) {
  let d;
  try { d = decodeAddress(address); } catch (e) { throw new Refuse(400, "address", "The Kaspa address does not decode: " + e.message); }
  if (d.version !== 0) throw new Refuse(400, "address", "Only a Schnorr (version 0) Kaspa address can sign in.");
  if (!schnorr.verify(kaspaSigBytes(sig), kaspaHash(message), d.payload)) {
    throw new Refuse(401, "signature", "The signature does not verify for this address and message.");
  }
  return { key: bytesToHex(d.payload), prefix: d.prefix };
}

async function proveWallet(req, q, b) {
  const kind = b.kind === "evm" ? "evm" : b.kind === "kaspa" ? "kaspa" : null;
  if (!kind) throw new Refuse(400, "kind", "kind must be evm or kaspa.");
  const msg = String(b.message || "");
  if (msg.length > 1500) throw new Refuse(400, "message", "Sign-in message too long.");
  const m = parseMessage(msg);
  if (!m.host || hostsFor(req).indexOf(m.host) < 0) throw new Refuse(401, "host", "This message was written for another site.");
  const claimed = String(b.address || "").trim();
  if (!claimed || m.address.toLowerCase() !== claimed.toLowerCase()) throw new Refuse(401, "address", "The signed message names a different address.");
  const at = Date.parse(m.issuedAt || "");
  if (!isFinite(at) || Math.abs(Date.now() - at) > 10 * 60000) throw new Refuse(401, "stale", "The sign-in message is too old. Sign in again.");
  if (!m.nonce) throw new Refuse(401, "nonce", "The message has no nonce.");
  const used = await q("delete from nonces where nonce = $1 and expires_at > now() returning nonce", [m.nonce]);
  if (!used.length) throw new Refuse(401, "nonce", "That sign-in request was already used or has expired. Sign in again.");
  if (kind === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(claimed)) throw new Refuse(400, "address", "An Ethereum address is 0x and 40 hex characters.");
    const who = evmRecover(msg, b.signature);
    if (who.toLowerCase() !== claimed.toLowerCase()) throw new Refuse(401, "signature", "The signature is from a different address.");
    return { address: claimed.toLowerCase(), family: "evm", key: null };
  }
  const v = kaspaVerify(msg, claimed, b.signature);
  return { address: claimed, family: "kaspa", key: v.key };
}

/* ---- Stripe, by its REST API ---------------------------------------------------------
   No SDK: three calls and a signature check. Card data never reaches this
   server — Checkout and the portal are Stripe's own pages. */
async function stripe(method, path, params) {
  const r = await fetch("https://api.stripe.com" + path, {
    method, headers: { authorization: "Bearer " + process.env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : new URLSearchParams(params || {}).toString(), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Refuse(502, "stripe", "Stripe: " + ((j && j.error && j.error.message) || r.status));
  return j;
}
async function rawBody(req) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 262144) throw new Refuse(413, "body", "Too large."); chunks.push(c); }
  if (n) return Buffer.concat(chunks).toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body && Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  throw new Refuse(400, "body", "The webhook body was already parsed by the host; set NODEJS_HELPERS=0 for this project.");
}
function verifyStripe(raw, header) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!secret) throw new Refuse(503, "billing", "STRIPE_WEBHOOK_SECRET is not set.");
  const parts = {}; header.split(",").forEach((kv) => { const i = kv.indexOf("="); if (i > 0) (parts[kv.slice(0, i)] = parts[kv.slice(0, i)] || []).push(kv.slice(i + 1)); });
  const t = Number((parts.t || [])[0]);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw new Refuse(400, "signature", "Stale or missing webhook timestamp.");
  const want = bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(t + "." + raw)));
  if (!(parts.v1 || []).some((v) => v === want)) throw new Refuse(400, "signature", "Webhook signature does not verify.");
  return JSON.parse(raw);
}
function planOfPrice(id) {
  if (id && id === process.env.STRIPE_PRICE_TEAM) return "team";
  if (id && id === process.env.STRIPE_PRICE_PRO) return "pro";
  return null;
}
async function onStripe(q, ev) {
  const o = (ev.data && ev.data.object) || {};
  if (ev.type === "checkout.session.completed") {
    const acc = o.client_reference_id || (o.metadata && o.metadata.account);
    if (acc) await q("update accounts set stripe_customer = coalesce($2, stripe_customer), stripe_subscription = coalesce($3, stripe_subscription) where id = $1",
      [acc, o.customer || null, o.subscription || null]);
    return;
  }
  if (/^customer\.subscription\.(created|updated|deleted)$/.test(ev.type)) {
    const acc = o.metadata && o.metadata.account;
    const price = o.items && o.items.data && o.items.data[0] && o.items.data[0].price && o.items.data[0].price.id;
    const live = ev.type !== "customer.subscription.deleted" && ["active", "trialing", "past_due"].indexOf(o.status) >= 0;
    const plan = live ? (planOfPrice(price) || "pro") : "free";
    const where = acc ? ["id = $1", acc] : ["stripe_customer = $1", o.customer];
    await q(`update accounts set plan = $2, plan_status = $3, stripe_subscription = $4, stripe_customer = coalesce(stripe_customer, $5) where ${where[0]}`,
      [where[1], plan, o.status || null, live ? o.id : null, o.customer || null]);
  }
}

/* ---- validation of what is stored -------------------------------------------------------- */
const SECRETISH = /secret|priv|seed|mnemonic|passphrase|password|^sk$|_sk$|^wif$/i;
function checkManifest(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Refuse(400, "manifest", "A manifest is a JSON object.");
  for (const k of Object.keys(m)) {
    if (SECRETISH.test(k) && m[k] != null && m[k] !== "") throw new Refuse(400, "manifest", `It has a field called "${k}". A manifest never holds a secret, so it was not stored.`);
  }
  for (const k of ["principal", "agent", "revocation", "recipients_root"]) {
    if (!/^[0-9a-f]{64}$/i.test(String(m[k] || ""))) throw new Refuse(400, "manifest", k + ": expected 64 hex characters.");
  }
  if (JSON.stringify(m).length > LIMITS.manifestBytes) throw new Refuse(400, "manifest", "Manifest too large.");
}
const KINDS = ["balance-at-or-above", "budget-low", "expiring", "spending-anomaly"];
function checkRule(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Refuse(400, "rule", "A rule is a JSON object.");
  if (KINDS.indexOf(r.kind) < 0) throw new Refuse(400, "rule", "kind must be one of " + KINDS.join(", ") + ".");
  if (JSON.stringify(r).length > LIMITS.ruleBytes) throw new Refuse(400, "rule", "Rule too large.");
}
/* ---- plans -----------------------------------------------------------------------
   While BILLING_ENFORCED is unset every account is on the beta, which has
   everything. Once it is set, the beta ends: sync and server alerts need Pro
   or Team, and a free account keeps everything that runs in the browser. */
const ENFORCED = process.env.BILLING_ENFORCED === "1";
const PAID = { pro: true, team: true };
function hasPaid(plan) { return !ENFORCED || !!PAID[plan]; }
function billingInfo(a) {
  return {
    enabled: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_PRO),
    enforced: ENFORCED, plan: a.plan, status: a.plan_status || null, customer: !!a.stripe_customer,
    prices: { pro: "$29 / month", team: "$199 / month" },
  };
}
async function needPaid(q, acc, what) {
  if (!ENFORCED) return;
  const [a] = await q("select plan from accounts where id = $1", [acc]);
  if (!a || !PAID[a.plan]) throw new Refuse(402, "plan", what + " needs Pro or Team. Everything in the browser stays free.");
}

const idOk = (s) => typeof s === "string" && /^[\w.:-]{1,128}$/.test(s);

async function me(q, acc) {
  const [a] = await q("select id, created_at, plan, plan_status, stripe_customer, email, telegram_chat_id from accounts where id = $1", [acc]);
  if (!a) return null;
  const wallets = await q("select address, family, key_hex, added_at from wallets where account_id = $1 order by added_at", [acc]);
  const grants = await q("select key, manifest, added_at, payee, moved_at, follow_note from grants where account_id = $1 order by added_at", [acc]);
  const rules = await q("select id, rule, state, state_at, last_message from rules where account_id = $1 order by id", [acc]);
  return {
    id: a.id, createdAt: a.created_at, plan: a.plan, email: a.email, telegramChatId: a.telegram_chat_id,
    telegramReady: !!process.env.TELEGRAM_BOT_TOKEN,
    billing: billingInfo(a), paid: hasPaid(a.plan),
    wallets: wallets.map((w) => ({ address: w.address, family: w.family, key: w.key_hex, addedAt: w.added_at })),
    grants: grants.map((g) => ({ key: g.key, manifest: g.manifest, addedAt: g.added_at, payee: g.payee, movedAt: g.moved_at, followNote: g.follow_note })),
    rules: rules.map((r) => ({ id: r.id, rule: r.rule, state: r.state, stateAt: r.state_at, lastMessage: r.last_message })),
  };
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const op = url.searchParams.get("op") || "";
  if (!SECRET || SECRET.length < 32) return fail(res, 503, "not_configured", "Accounts are not set up on this site yet (SESSION_SECRET). The console works without one.");
  if (!DB_URL && !globalThis.__WARDA_DB__) return fail(res, 503, "not_configured", "Accounts are not set up on this site yet (no database). The console works without one.");
  try {
    if (req.method === "POST" && op !== "cron" && op !== "stripe" && req.headers["x-warda"] !== "1") throw new Refuse(403, "csrf", "Missing x-warda header.");
    const q = await db();

    if (req.method === "GET" && op === "nonce") {
      await q("delete from nonces where expires_at < now()");
      const nonce = bytesToHex(randomBytes(16));
      await q("insert into nonces (nonce, expires_at) values ($1, now() + interval '5 minutes')", [nonce]);
      return send(res, 200, { ok: true, nonce, host: hostsFor(req)[0], issuedAt: new Date().toISOString() });
    }

    if (req.method === "POST" && op === "cron") {
      const want = process.env.CRON_SECRET || "";
      const got = String(req.headers["x-cron-secret"] || String(req.headers.authorization || "").replace(/^Bearer /, ""));
      if (!want || got !== want) throw new Refuse(401, "cron", "Not authorised.");
      const r = await evaluate(q, { telegramToken: process.env.TELEGRAM_BOT_TOKEN || "" });
      return send(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && op === "cron") {
      /* Vercel's own cron sends a GET with Authorization: Bearer CRON_SECRET. */
      const want = process.env.CRON_SECRET || "";
      if (!want || String(req.headers.authorization || "") !== "Bearer " + want) throw new Refuse(401, "cron", "Not authorised.");
      const r = await evaluate(q, { telegramToken: process.env.TELEGRAM_BOT_TOKEN || "" });
      return send(res, 200, { ok: true, ...r });
    }

    if (req.method === "POST" && op === "stripe") {
      const raw = await rawBody(req);
      const ev = verifyStripe(raw, String(req.headers["stripe-signature"] || ""));
      await onStripe(q, ev);
      return send(res, 200, { ok: true, received: ev.type });
    }

    if (req.method === "POST" && op === "signin") {
      const w = await proveWallet(req, q, await body(req));
      let [row] = await q("select account_id from wallets where address = $1", [w.address]);
      if (!row) {
        const [a] = await q("insert into accounts default values returning id");
        await q("insert into wallets (address, account_id, family, key_hex) values ($1, $2, $3, $4)", [w.address, a.id, w.family, w.key]);
        row = { account_id: a.id };
      }
      return send(res, 200, { ok: true, account: await me(q, row.account_id) }, makeSession(row.account_id));
    }

    const acc = sessionOf(req);
    if (op === "signout" && req.method === "POST") return send(res, 200, { ok: true }, clearSession);
    if (!acc) return fail(res, 401, "signed_out", "Not signed in.");
    const exists = await q("select 1 from accounts where id = $1", [acc]);
    if (!exists.length) return fail(res, 401, "signed_out", "That account no longer exists.", clearSession);

    if (req.method === "GET" && op === "me") return send(res, 200, { ok: true, account: await me(q, acc) });

    if (req.method === "POST" && op === "link") {
      const w = await proveWallet(req, q, await body(req));
      const [row] = await q("select account_id from wallets where address = $1", [w.address]);
      if (row && row.account_id !== acc) throw new Refuse(409, "linked_elsewhere", "That wallet already belongs to another account. Sign in with it and delete that account first if you want to move it.");
      if (!row) await q("insert into wallets (address, account_id, family, key_hex) values ($1, $2, $3, $4)", [w.address, acc, w.family, w.key]);
      return send(res, 200, { ok: true, account: await me(q, acc) });
    }

    if (req.method === "POST" && op === "unlink") {
      const b = await body(req);
      const ws = await q("select address from wallets where account_id = $1", [acc]);
      if (ws.length <= 1) throw new Refuse(400, "last_wallet", "That is the only wallet on this account. Delete the account instead.");
      await q("delete from wallets where account_id = $1 and address = $2", [acc, String(b.address || "")]);
      return send(res, 200, { ok: true, account: await me(q, acc) });
    }

    if (req.method === "POST" && op === "grant") {
      const b = await body(req);
      if (!idOk(b.key)) throw new Refuse(400, "key", "A grant key is 1–128 letters, digits, and . : _ -");
      checkManifest(b.manifest);
      await needPaid(q, acc, "Syncing tracked grants");
      const [{ n }] = await q("select count(*)::int as n from grants where account_id = $1", [acc]);
      if (n >= LIMITS.grants) throw new Refuse(400, "limit", "This account tracks the most grants a beta account can.");
      await q(`insert into grants (account_id, key, manifest) values ($1, $2, $3)
               on conflict (account_id, key) do update set manifest = excluded.manifest`, [acc, b.key, JSON.stringify(b.manifest)]);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && op === "ungrant") {
      const b = await body(req);
      await q("delete from grants where account_id = $1 and key = $2", [acc, String(b.key || "")]);
      await q("delete from snapshots where account_id = $1 and grant_key = $2", [acc, String(b.key || "")]);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && op === "rule") {
      const b = await body(req);
      if (!idOk(b.id)) throw new Refuse(400, "id", "A rule id is 1–128 letters, digits, and . : _ -");
      checkRule(b.rule);
      await needPaid(q, acc, "Alerts the console runs for you");
      const [{ n }] = await q("select count(*)::int as n from rules where account_id = $1", [acc]);
      if (n >= LIMITS.rules) throw new Refuse(400, "limit", "This account has the most rules a beta account can.");
      await q(`insert into rules (account_id, id, rule) values ($1, $2, $3)
               on conflict (account_id, id) do update set rule = excluded.rule, state = null, state_at = null`, [acc, b.id, JSON.stringify(b.rule)]);
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && op === "unrule") {
      const b = await body(req);
      await q("delete from rules where account_id = $1 and id = $2", [acc, String(b.id || "")]);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && op === "settings") {
      const b = await body(req);
      const email = b.email == null || b.email === "" ? null : String(b.email).trim();
      if (email && !/^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/.test(email)) throw new Refuse(400, "email", "That does not look like an email address.");
      const tg = b.telegramChatId == null || b.telegramChatId === "" ? null : String(b.telegramChatId).trim();
      if (tg && !/^-?\d{1,20}$/.test(tg)) throw new Refuse(400, "telegramChatId", "A Telegram chat id is a number.");
      await q("update accounts set email = $2, telegram_chat_id = $3 where id = $1", [acc, email, tg]);
      return send(res, 200, { ok: true, account: await me(q, acc) });
    }

    if (req.method === "POST" && op === "payee") {
      const b = await body(req);
      const payee = b.payee == null || b.payee === "" ? null : String(b.payee).trim();
      if (payee) { try { decodeAddress(payee); } catch (e) { throw new Refuse(400, "payee", "That payee address does not decode: " + e.message); } }
      const r = await q("update grants set payee = $3 where account_id = $1 and key = $2 returning key", [acc, String(b.key || ""), payee]);
      if (!r.length) throw new Refuse(404, "key", "No synced grant with that key.");
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && op === "follow") {
      const b = await body(req);
      const [g] = await q("select key, manifest, payee from grants where account_id = $1 and key = $2", [acc, String(b.key || "")]);
      if (!g) throw new Refuse(404, "key", "No synced grant with that key.");
      const r = await follow(q, acc, g, String(b.network || "testnet-10"));
      return send(res, 200, { ok: true, ...r });
    }
    if (req.method === "GET" && op === "history") {
      const rows = await q(`select grant_key, at, remaining_sompi from snapshots where account_id = $1
                            and at > now() - interval '30 days' order by at`, [acc]);
      const by = {};
      rows.forEach((r) => { (by[r.grant_key] = by[r.grant_key] || []).push({ at: r.at, remainingSompi: String(r.remaining_sompi).split(".")[0] }); });
      return send(res, 200, { ok: true, history: by });
    }

    if (req.method === "POST" && op === "checkout") {
      const b = await body(req);
      const plan = b.plan === "team" ? "team" : "pro";
      const price = plan === "team" ? process.env.STRIPE_PRICE_TEAM : process.env.STRIPE_PRICE_PRO;
      if (!process.env.STRIPE_SECRET_KEY || !price) throw new Refuse(503, "billing", "Billing is not switched on for this site yet.");
      const [a] = await q("select stripe_customer from accounts where id = $1", [acc]);
      const origin = "https://" + hostsFor(req)[0];
      const params = {
        mode: "subscription", "line_items[0][price]": price, "line_items[0][quantity]": "1",
        success_url: origin + "/app?billing=done#/account", cancel_url: origin + "/app?billing=cancelled#/account",
        client_reference_id: acc, "metadata[account]": acc, "subscription_data[metadata][account]": acc,
        allow_promotion_codes: "true",
      };
      if (a && a.stripe_customer) params.customer = a.stripe_customer;
      const s2 = await stripe("POST", "/v1/checkout/sessions", params);
      return send(res, 200, { ok: true, url: s2.url });
    }
    if (req.method === "POST" && op === "portal") {
      const [a] = await q("select stripe_customer from accounts where id = $1", [acc]);
      if (!a || !a.stripe_customer) throw new Refuse(400, "billing", "This account has no billing yet.");
      const s2 = await stripe("POST", "/v1/billing_portal/sessions", { customer: a.stripe_customer, return_url: "https://" + hostsFor(req)[0] + "/app#/account" });
      return send(res, 200, { ok: true, url: s2.url });
    }

    if (req.method === "GET" && op === "export") {
      const snaps = await q("select grant_key, at, remaining_sompi from snapshots where account_id = $1 order by at", [acc]);
      return send(res, 200, { ok: true, exportedAt: new Date().toISOString(), account: await me(q, acc),
        snapshots: snaps.map((s) => ({ grant: s.grant_key, at: s.at, remainingSompi: String(s.remaining_sompi) })) });
    }

    if (req.method === "POST" && op === "delete") {
      await q("delete from accounts where id = $1", [acc]);
      return send(res, 200, { ok: true, deleted: true }, clearSession);
    }

    return fail(res, 404, "op", "Unknown operation.");
  } catch (e) {
    if (e instanceof Refuse) return fail(res, e.status, e.code, e.message);
    if (e instanceof SyntaxError) return fail(res, 400, "json", "The request body is not valid JSON.");
    console.error(e);
    return fail(res, 500, "internal", "The account service failed while answering. Nothing about your wallet was affected.");
  }
}
