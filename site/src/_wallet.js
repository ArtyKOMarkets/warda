/* The grant, rendered as the thing a developer already knows how to read.
 *
 * Called with the same object the rest of the page is built from, so it can
 * state nothing the dashboard did not derive from the chain. Every value is
 * printed as the dashboard formatted it — no arithmetic here, because a panel
 * that recomputed a balance would be a second implementation of the accounting
 * and the one that drifts is the one on the marketing page.
 *
 * It renders for a retired agent too. A wallet UI that only knows how to show
 * a live balance quietly implies every agent it can draw is still spending,
 * and two of the four here are over.
 */
function renderWallet(d) {
  var panel = document.getElementById("w-panel");
  if (!panel || !d || !d.identity || !d.authority) return;
  var a = d.authority;
  var retired = d.retired || null;

  var short = function (addr) {
    return addr.length > 30 ? addr.slice(0, 20) + "…" + addr.slice(-6) : addr;
  };
  var set = function (id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  set("w-id", d.identity.agentId || "—");
  set("w-addr", (retired && retired.grantAddress) || d.identity.grantAddress || "—");

  var bal = document.getElementById("w-bal");
  if (retired || !a.onChain) {
    /* `onChain` is null for a grant that has ended, and a panel showing "0 KAS"
       there would be true and misleading: a drained grant and an ended one are
       different, and only one of them can be topped up. */
    bal.textContent = retired ? "ended" : "—";
    bal.className = "wal-amt ended";
    set("w-balsub", retired ? "the grant holds nothing" : "no reading");
  } else {
    bal.textContent = a.onChain;
    bal.className = "wal-amt";
    set("w-balsub", "held by the covenant");
  }

  // ---- the limits, as rules rather than settings ---------------------------
  var rules = document.getElementById("w-rules");
  rules.innerHTML = "";
  /* A retired grant's limits are history, not permission. Rendering them with
     the same green tick as a live agent's says "this one may still spend
     1.92 KAS", which is false — the grant was ended and holds nothing. So the
     mark goes neutral and the wording moves into the past tense. The numbers
     are unchanged and still worth showing: what an agent was allowed to do is
     the whole record of what it could not do. */
  var mark = function (ok) { return retired ? "·" : ok; };
  var row = function (mark, key, value, cls) {
    var li = document.createElement("li");
    if (cls) li.className = cls;
    if (retired && cls !== "no") li.className = (li.className ? li.className + " " : "") + "past";
    var m = document.createElement("span"); m.className = "m"; m.textContent = mark;
    var k = document.createElement("span"); k.className = "k"; k.textContent = key;
    var v = document.createElement("span"); v.className = "v"; v.textContent = value;
    li.appendChild(m); li.appendChild(k); li.appendChild(v);
    rules.appendChild(li);
  };

  if (a.maxPerPayment) row(mark("✓"), "per payment", a.maxPerPayment);
  if (a.epochLimit) {
    row(mark("✓"), "per epoch", a.epochLimit + " every " + (a.epochLengthDaa || "?") + " blocks");
  }
  if (a.remaining && a.budget) {
    row(mark("✓"), retired ? "unspent" : "budget left", a.remaining + " of " + a.budget);
  }
  if (a.authorizedPayees) {
    row(
      mark("✓"),
      retired ? "could pay" : "may pay",
      a.authorizedPayees + (a.authorizedPayees === 1 ? " address" : " addresses") + ", fixed at creation",
    );
  }
  if (d.timelock && !d.timelock.open && !retired) {
    row("✗", "not yet", (d.timelock.lockedFor || "—") + " until it may spend at all", "no");
  }
  /* How it ended, before the row about who it could never pay. A grant that
     stopped because someone ended it and one that ran out are different
     endings, and only the covenant's own record can tell them apart. */
  if (retired) {
    row(
      "✗",
      "ended",
      retired.endedBy
        ? "by the revocation key · " + String(retired.endedBy).slice(0, 10) + "…"
        : "its authority is over",
      "no",
    );
  }
  /* Always last, always present. It is the only row here that is an argument
     rather than a reading, and it is the one every software guardrail cannot
     make: not "we will refuse this" but "no valid transaction exists". */
  row("✗", "anyone else", "there is no transaction to sign", "no");

  // ---- what it actually did ------------------------------------------------
  var list = document.getElementById("w-act");
  list.innerHTML = "";

  /* Purchases carry a payee LABEL and the endpoint; the coins at the payee
     address carry neither. Prefer the richer record and fall back, rather than
     rendering only agents that happen to buy — #001 sells, and has no
     purchase log at all. */
  var items = [];
  if (Array.isArray(d.purchases)) {
    items = d.purchases
      .filter(function (p) { return p.outcome === "bought"; })
      .map(function (p) {
        var who = p.sellerClaimed || "";
        var what = (p.url || "").replace(/^https?:\/\/[^/]+/, "");
        return { amount: p.paid || "—", who: who + (what ? " · " + what : ""), txid: p.txid };
      });
  } else if (d.activity && Array.isArray(d.activity.coins)) {
    /* No purchase log — #001 sells rather than buys, and its spending is known
       only as coins sitting at a payee. When the allowlist holds exactly one
       address every one of those coins went there, so the payee can be named
       without guessing. With more than one it cannot, and the DAA score is
       what there is. */
    var only = a.authorizedPayees === 1 && a.payees && a.payees[0] ? a.payees[0] : null;
    /* A payee entry is a label when someone has identified the address and the
       bare address when nobody has. The second is not a failure — it is the
       honest rendering of a payee nobody has vouched for — but printing 68
       characters of it on five consecutive rows is noise, so it is shortened
       here and stated in full in the allowlist section below. */
    var label = only && only.label ? only.label : typeof only === "string" ? short(only) : null;
    items = d.activity.coins.map(function (c) {
      return {
        amount: c.amount,
        who: label ? "to " + label : "paid at DAA " + c.daaScore,
        txid: c.txid,
      };
    });
  }
  items.reverse();

  var act = d.activity || {};
  set(
    "w-count",
    act.payments
      ? act.payments + (act.payments === 1 ? " payment · " : " payments · ") + (act.paid || "")
      : "nothing yet",
  );

  if (items.length === 0) {
    var none = document.createElement("li");
    none.className = "empty";
    none.textContent = "No payment has been made from this grant.";
    list.appendChild(none);
  } else {
    items.slice(0, 8).forEach(function (it) {
      var li = document.createElement("li");
      var s1 = document.createElement("span"); s1.className = "a"; s1.textContent = it.amount;
      var s2 = document.createElement("span"); s2.className = "w"; s2.textContent = it.who;
      var s3 = document.createElement("span"); s3.className = "t";
      s3.textContent = it.txid ? it.txid.slice(0, 10) + "…" : "";
      li.appendChild(s1); li.appendChild(s2); li.appendChild(s3);
      list.appendChild(li);
    });
  }

  panel.hidden = false;
}
