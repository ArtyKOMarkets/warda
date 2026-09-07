/**
 * The agent graph, and the live line under the landing page's hero.
 *
 * Injected into BOTH /agents and / by build.py, because it was written for one
 * of them and immediately wanted on the other. A second copy of a diagram is a
 * second diagram: the first colour, position or rule that changes in one and
 * not the other makes them disagree about the same four agents, and nothing
 * warns you.
 *
 * Every number and every arrow comes from the agents' published JSON — the same
 * files their own pages render — so a diagram cannot outlive the thing it
 * describes. It no-ops on a page that carries none of the elements it fills.
 */
(function () {
  var AGENT_IDS = ["001", "002", "003", "004"];

/* ---- the diagram -------------------------------------------------------
   Positions are fixed; everything else — which nodes exist, which are dead,
   which arrows to draw and what they are worth — comes from the data. An
   agent whose JSON is missing simply is not drawn. */
var POS = {
  "001": { x: 545, y: 120, role: "sells its digest" },
  "002": { x: 120, y:  70, role: "retired" },
  "003": { x: 120, y: 215, role: "buys" },
  "004": { x: 120, y: 360, role: "settled" },
  vendor: { x: 545, y: 330, role: "sells /weather /fact" }
};
var W = 175, H = 62;

function svgEl(name, attrs) {
  var e = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
  return e;
}

function drawGraph(loaded) {
  var nodes = document.getElementById("g-nodes");
  var edges = document.getElementById("g-edges");
  var drawn = {};

  function box(key, label, sub, dead) {
    var p = POS[key];
    if (!p) return;
    drawn[key] = p;
    var g = svgEl("g", { class: "gnode" + (dead ? " dead" : "") });
    g.appendChild(svgEl("rect", { x: p.x - W / 2, y: p.y - H / 2, width: W, height: H, rx: 2 }));
    var t = svgEl("text", { x: p.x, y: p.y - 6, class: "gn-name" });
    t.textContent = label;
    g.appendChild(t);
    var u = svgEl("text", { x: p.x, y: p.y + 14, class: "gn-sub" });
    u.textContent = sub;
    g.appendChild(u);
    nodes.appendChild(g);
  }

  function edge(from, to, label, dotted) {
    var a = drawn[from], b = drawn[to];
    if (!a || !b) return;
    var x1 = a.x + (b.x > a.x ? W / 2 : 0), y1 = a.y;
    var x2 = b.x - (b.x > a.x ? W / 2 : 0), y2 = b.y;
    var d;
    if (b.x === a.x) {             // straight down: lineage
      x1 = a.x; y1 = a.y + H / 2; x2 = b.x; y2 = b.y - H / 2;
      d = "M" + x1 + "," + y1 + " L" + x2 + "," + y2;
    } else {
      var mx = (x1 + x2) / 2;
      d = "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2;
    }
    edges.appendChild(svgEl("path", {
      d: d, class: "gedge" + (dotted ? " auth" : ""),
      "marker-end": "url(#" + (dotted ? "ar-dim" : "ar") + ")"
    }));
    if (!label) return;
    /* Near the SOURCE, not the midpoint. Every payment edge converges on one
       of two sellers, so midpoint labels stacked on top of each other exactly
       where the curves crowd together. Anchored to where an edge leaves, each
       label sits beside the agent that paid it and reads as that agent's. */
    var lx = b.x === a.x ? a.x + 8 : x1 + (x2 - x1) * 0.3;
    var ly = b.x === a.x ? (y1 + y2) / 2 + 4 : y1 + (y2 - y1) * 0.1 - 9;
    var t = svgEl("text", {
      x: lx, y: ly, class: "gedge-l" + (dotted ? " auth" : ""),
      "text-anchor": b.x === a.x ? "start" : "middle"
    });
    t.textContent = label;
    edges.appendChild(t);
  }

  var any = false;
  Object.keys(loaded).forEach(function (id) {
    var d = loaded[id];
    if (!d) return;
    any = true;
    box(id, "Agent #" + id, POS[id] ? POS[id].role : "", !!d.retired);
  });
  if (!any) return;
  box("vendor", "Demo vendor", POS.vendor.role, false);

  /* Payments, aggregated from the receipts. Only what was actually served:
     an arrow for money that bought nothing would be a different claim. */
  Object.keys(loaded).forEach(function (id) {
    var d = loaded[id];
    if (!d || !d.purchases) return;
    var byPayee = {};
    d.purchases.forEach(function (p) {
      if (p.outcome !== "bought" || !p.payTo || !p.paid) return;
      byPayee[p.payTo] = (byPayee[p.payTo] || 0) + parseFloat(p.paid);
    });
    var names = {};
    (d.buysFrom && d.buysFrom.payees || []).forEach(function (p) {
      names[p.address] = (p.label || "").indexOf("#001") >= 0 ? "001" : "vendor";
    });
    Object.keys(byPayee).forEach(function (addr) {
      edge(id, names[addr] || "vendor", byPayee[addr].toFixed(2) + " KAS", false);
    });
  });

  /* Authority. Each edge is drawn only when the data carries the fact. */
  Object.keys(loaded).forEach(function (id) {
    var d = loaded[id];
    if (!d) return;
    if (d.succession) edge((d.succession.replaced || "").replace("WARDA-", ""), id, "revoked, replaced by", true);
    if (d.delegatedBy) edge((d.delegatedBy.parent || "").replace("WARDA-", ""), id, "delegated", true);
  });

  document.getElementById("g-graph").hidden = false;
}
  /**
   * The line under the hero.
   *
   * Four figures, none of them typed. "0 human approvals" is the one worth
   * having: every payment in the other three happened with nobody in the loop,
   * and it is the difference between a spending limit and a review queue.
   */
  function liveLine(loaded) {
    var agents = 0, holding = 0, payments = 0, spent = 0;
    Object.keys(loaded).forEach(function (id) {
      var d = loaded[id];
      if (!d) return;
      agents++;
      /* Four agents exist; two of their grants do. #002 was revoked and #004
         settled back into its parent, and calling either of them "running"
         would be the page's own figures overstating it — which is the one
         thing every other number here is arranged to prevent. */
      if (!d.retired && d.authority && d.authority.onChain) holding++;
      (d.purchases || []).forEach(function (p) {
        if (p.outcome !== "bought") return;
        payments++;
        if (p.paid) spent += parseFloat(p.paid) || 0;
      });
    });
    var set = function (id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    if (!agents) return;
    set("live-agents", String(agents));
    set("live-holding", String(holding));
    set("live-payments", String(payments));
    set("live-spent", spent.toFixed(2));
    var row = document.getElementById("liveline");
    if (row) row.hidden = false;
  }

  Promise.all(AGENT_IDS.map(function (id) {
    return fetch("/agent-" + id + ".json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  })).then(function (all) {
    var loaded = {};
    AGENT_IDS.forEach(function (id, i) { if (all[i]) loaded[id] = all[i]; });
    /* Either half failing must not take the other with it, and neither is
       worth an error on a marketing page: a missing diagram beats a broken
       one, and a missing figure beats a wrong one. */
    try { drawGraph(loaded); } catch (e) {}
    try { liveLine(loaded); } catch (e) {}
  });
})();
