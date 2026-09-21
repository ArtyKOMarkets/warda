/**
 * /api/swap — the console's one server-side piece: ChangeNOW, with the key
 * kept off the page.
 *
 *   GET  /api/swap?op=quote&chain=Base&token=USDC&amount=100
 *   POST /api/swap?op=create   { chain, token, amount, address, refundAddress? }
 *   GET  /api/swap?op=status&id=<14 chars>
 *
 * What it is: a thin, allow-listed proxy. Only the pairs in routes.json can be
 * quoted or created, only to a Kaspa MAINNET address whose checksum verifies
 * (the same decoder the page uses — site/src/router-browser.js), and only
 * within ChangeNOW's own min/max for the pair.
 *
 * What it is not: a custodian, a database, or a party to the swap. It holds no
 * funds and stores nothing — no addresses, no exchange ids. The page keeps the
 * id; ChangeNOW keeps the exchange. The money goes from the person's wallet to
 * ChangeNOW's deposit address and from ChangeNOW to the person's Kaspa
 * address, and never through here.
 *
 * Environment:
 *   CHANGENOW_API_KEY          required; without it every call answers 503
 *   CHANGENOW_PARTNER_FEE_PCT  what the ChangeNOW dashboard is set to earn
 *                              this key, shown to the person on every quote.
 *                              Warda's position is 0; the page says whatever
 *                              this says, so it must match the dashboard.
 */
import fs from "node:fs";
import vm from "node:vm";

const BASE = "https://api.changenow.io/v2";
const KEY = process.env.CHANGENOW_API_KEY || "";
/* Shown to the person on every quote, so it is echoed ONLY when it is a
   percentage. Anything else — a key pasted into the wrong variable, which
   happened on the first deploy — is withheld, and the page refuses to create
   a swap until the fee is stated. An environment value is never echoed raw. */
const FEE_RAW = (process.env.CHANGENOW_PARTNER_FEE_PCT || "").trim();
const FEE = /^\d{1,2}(\.\d{1,3})?$/.test(FEE_RAW) ? FEE_RAW : null;

/* Both inputs are INLINED by site/build.py when it writes site/web/api/.
   Reading them from disk at runtime depended on the host's bundler noticing
   the read and shipping the files; on Vercel it did not, and every call
   answered 500 before this line had a chance to say why. The disk read stays
   as the fallback for running the source file directly. */
const ROUTES_INLINE = /*@ROUTES*/ null;
const ROUTER_INLINE = /*@ROUTER*/ null;
/* Loaded once, and a failure is kept rather than thrown: a module that throws
   while loading is a host error page, and the page reads that as "no answer"
   with nothing to say why. This way every call explains itself. */
let ROUTES = null, ROUTER = null, INIT_ERR = null;
try {
  ROUTES = ROUTES_INLINE || JSON.parse(fs.readFileSync(new URL("./_routes.json", import.meta.url), "utf8"));
  const ctx = {};
  vm.runInNewContext((ROUTER_INLINE || fs.readFileSync(new URL("./_router.js", import.meta.url), "utf8")) + ";this.R=WardaRouter;", ctx);
  ROUTER = ctx.R;
} catch (e) { INIT_ERR = e; }

function pair(chain, token) {
  const src = ROUTES.networks.mainnet.sources.find((s) => s.chain === chain);
  if (!src || src.routes.indexOf("changenow") < 0) return null;
  const p = (src.changenow || {})[token];
  return p ? { chain: src.chain, chainId: src.chainId, token, currency: p.currency, network: p.network } : null;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
function fail(res, status, error, message) { send(res, status, { ok: false, error, message }); }

async function cn(pathq, init) {
  const r = await fetch(BASE + pathq, {
    ...init,
    headers: { "x-changenow-api-key": KEY, "content-type": "application/json", ...(init && init.headers) },
    signal: AbortSignal.timeout(15000),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    const err = new Error((j && (j.message || j.error)) || "ChangeNOW answered " + r.status);
    err.status = r.status; err.code = j && j.error;
    throw err;
  }
  return j;
}

/* Amounts are decimal strings: a number that went through a double on its
   way to a swap is a number nobody chose. */
function amountOf(v) {
  const s = String(v == null ? "" : v).trim();
  return /^\d{1,9}(\.\d{1,6})?$/.test(s) && Number(s) > 0 ? s : null;
}

function kaspaMainnet(addr) {
  try {
    const d = ROUTER.decodeAddress(String(addr || "").trim());
    return d.prefix === "kaspa" ? null : "that is a " + d.prefix + " address; this swap delivers mainnet KAS, to a kaspa: address";
  } catch (e) {
    return "the Kaspa address does not check out: " + e.message;
  }
}

async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 4096) throw new Error("body too large"); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const STATUS_SAY = {
  new: "created — waiting for your deposit",
  waiting: "waiting for your deposit",
  confirming: "deposit seen, waiting for confirmations",
  exchanging: "swapping",
  sending: "sending KAS to your address",
  finished: "done — KAS sent",
  failed: "failed",
  refunded: "refunded to your refund address",
  verifying: "held for verification by ChangeNOW",
};

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const op = url.searchParams.get("op");
  if (INIT_ERR) return fail(res, 500, "init", "The swap function could not load its route table: " + INIT_ERR.message);
  if (!KEY) return fail(res, 503, "not_configured", "The swap service is not configured on this site yet (no ChangeNOW API key). Nothing was sent anywhere.");

  try {
    if (req.method === "GET" && op === "quote") {
      const p = pair(url.searchParams.get("chain"), url.searchParams.get("token"));
      if (!p) return fail(res, 400, "pair", "That chain and token are not a route this console offers.");
      const amount = amountOf(url.searchParams.get("amount"));
      const q = "fromCurrency=" + p.currency + "&fromNetwork=" + p.network + "&toCurrency=kas&toNetwork=kas&flow=standard";
      const range = await cn("/exchange/range?" + q);
      let est = null;
      if (amount && Number(amount) >= Number(range.minAmount) && (range.maxAmount == null || Number(amount) <= Number(range.maxAmount))) {
        est = await cn("/exchange/estimated-amount?" + q + "&type=direct&fromAmount=" + amount);
      }
      return send(res, 200, {
        ok: true, pair: p, amount,
        min: range.minAmount, max: range.maxAmount,
        toAmount: est ? est.toAmount : null,
        speed: est ? est.transactionSpeedForecast : null,
        warning: est ? est.warningMessage : null,
        partnerFeePct: FEE,
        flow: "standard",
        says: "ChangeNOW's estimate at its floating rate. The KAS you receive is what it has when your deposit arrives, not this figure.",
      });
    }

    if (req.method === "POST" && op === "create") {
      if (FEE == null) return fail(res, 503, "fee_not_stated", "This site has not stated what it earns on a swap (CHANGENOW_PARTNER_FEE_PCT is not a percentage), so it will not create one. Nothing was sent anywhere.");
      const b = await body(req);
      const p = pair(b.chain, b.token);
      if (!p) return fail(res, 400, "pair", "That chain and token are not a route this console offers.");
      const amount = amountOf(b.amount);
      if (!amount) return fail(res, 400, "amount", "The amount must be a positive number with at most six decimals.");
      const bad = kaspaMainnet(b.address);
      if (bad) return fail(res, 400, "address", bad);
      const refund = String(b.refundAddress || "").trim();
      if (refund && !/^0x[0-9a-fA-F]{40}$/.test(refund)) return fail(res, 400, "refundAddress", "A refund address on an EVM chain is 0x followed by 40 hex characters.");
      const q = "fromCurrency=" + p.currency + "&fromNetwork=" + p.network + "&toCurrency=kas&toNetwork=kas&flow=standard";
      const range = await cn("/exchange/range?" + q);
      if (Number(amount) < Number(range.minAmount)) return fail(res, 400, "amount", "Below ChangeNOW's minimum for this pair, " + range.minAmount + " " + p.token + ".");
      if (range.maxAmount != null && Number(amount) > Number(range.maxAmount)) return fail(res, 400, "amount", "Above ChangeNOW's maximum for this pair, " + range.maxAmount + " " + p.token + ".");
      const x = await cn("/exchange", {
        method: "POST",
        body: JSON.stringify({
          fromCurrency: p.currency, fromNetwork: p.network, toCurrency: "kas", toNetwork: "kas",
          fromAmount: amount, toAmount: "", address: String(b.address).trim(), extraId: "",
          refundAddress: refund, refundExtraId: "", userId: "", payload: "", contactEmail: "",
          flow: "standard", type: "direct", rateId: "",
        }),
      });
      /* The deposit token's contract, from ChangeNOW's own currency list, so
         the page can offer "send from your wallet" without a contract address
         typed into this repository. */
      let tokenContract = null;
      try {
        const list = await cn("/exchange/currencies?active=true&flow=standard");
        const c = (list || []).find((c) => c.ticker === p.currency && c.network === p.network);
        tokenContract = c && c.tokenContract ? c.tokenContract : null;
      } catch (e) { tokenContract = null; }
      return send(res, 200, {
        ok: true, id: x.id, pair: p,
        payinAddress: x.payinAddress, payinExtraId: x.payinExtraId || null,
        payoutAddress: x.payoutAddress, fromAmount: x.fromAmount, toAmount: x.toAmount,
        refundAddress: x.refundAddress || null, tokenContract, partnerFeePct: FEE,
      });
    }

    if (req.method === "GET" && op === "status") {
      const id = url.searchParams.get("id") || "";
      if (!/^[a-z0-9]{14}$/i.test(id)) return fail(res, 400, "id", "An exchange id is 14 letters and digits.");
      const s = await cn("/exchange/by-id?id=" + id);
      return send(res, 200, {
        ok: true, id: s.id, status: s.status, says: STATUS_SAY[s.status] || s.status,
        from: { currency: s.fromCurrency, network: s.fromNetwork, expected: s.expectedAmountFrom, received: s.amountFrom, hash: s.payinHash || null },
        to: { expected: s.expectedAmountTo, sent: s.amountTo, hash: s.payoutHash || null, address: s.payoutAddress },
        payinAddress: s.payinAddress, refundHash: s.refundHash || null, refundAmount: s.refundAmount || null,
        createdAt: s.createdAt, updatedAt: s.updatedAt, depositReceivedAt: s.depositReceivedAt || null,
      });
    }

    return fail(res, 404, "op", "Unknown operation. quote, create or status.");
  } catch (e) {
    return fail(res, e.status && e.status < 500 ? 400 : 502, e.code || "changenow", "ChangeNOW: " + e.message);
  }
};
