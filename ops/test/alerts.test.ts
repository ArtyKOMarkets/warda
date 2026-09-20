/**
 * The part of the alerter that has to be right when nobody is reading.
 *
 * Everything else in `ops/alerts.ts` is reading and printing; the decision of
 * whether a run SAYS anything is this one function, and it is the thing that
 * fails in the direction nobody notices. A watcher that sends too much gets
 * muted, and a muted watcher is the same as no watcher — so "does not send"
 * is tested here as carefully as "sends".
 *
 * Two of these assertions describe bugs the function had while it was being
 * written: a fresh install announced every quiet rule as "cleared", and an
 * unreachable node overwrote a known `clear` with `undecided`, which would
 * have made the next real firing look like a first sighting rather than a
 * change.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { transition, type Remembered } from "../alerts.ts";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:15:00.000Z";

const clear = (since = T0): Remembered => ({ status: "clear", since, blind: 0, blindReported: false });
const firing = (since = T0): Remembered => ({ status: "firing", since, blind: 0, blindReported: false });

test("a rule seen for the first time, and quiet, says nothing", () => {
  const { next, send } = transition(undefined, "clear", T1);
  assert.equal(send, null);
  assert.equal(next.status, "clear");
});

test("a rule seen for the first time, and already true, speaks", () => {
  const { next, send } = transition(undefined, "firing", T1);
  assert.equal(send, "firing");
  assert.equal(next.status, "firing");
  assert.equal(next.since, T1);
});

test("a condition that is still true is not repeated", () => {
  const { next, send } = transition(firing(), "firing", T1);
  assert.equal(send, null);
  assert.equal(next.since, T0, "`since` is when it changed, not when it was last looked at");
});

test("the change back is sent too", () => {
  const { send } = transition(firing(), "clear", T1);
  assert.equal(send, "cleared");
});

test("a rule that was never firing does not 'clear'", () => {
  assert.equal(transition(clear(), "clear", T1).send, null);
  assert.equal(
    transition({ status: "undecided", since: T0, blind: 3, blindReported: true }, "clear", T1).send,
    null,
    "undecided is not firing: coming back readable and quiet is not a clearing",
  );
});

test("an unreadable run keeps what was known and does not claim it", () => {
  const { next, send } = transition(clear(), "undecided", T1);
  assert.equal(next.status, "clear", "the last DECIDED status survives");
  assert.equal(next.since, T0);
  assert.equal(next.blind, 1);
  assert.equal(send, "blind");
});

test("it says it cannot read once, not every fifteen minutes", () => {
  let s = transition(firing(), "undecided", T1);
  assert.equal(s.send, "blind");
  for (let i = 0; i < 5; i++) {
    s = transition(s.next, "undecided", T1);
    assert.equal(s.send, null);
    assert.equal(s.next.status, "firing", "still firing as far as anyone knows");
  }
  assert.equal(s.next.blind, 6, "the count keeps going, so the log can say how long");
});

test("a reading after an outage re-arms the outage message", () => {
  const blind = transition(clear(), "undecided", T1).next;
  assert.equal(blind.blindReported, true);
  const back = transition(blind, "clear", T1);
  assert.equal(back.send, null, "readable and unchanged: nothing happened");
  assert.equal(back.next.blindReported, false, "the next outage speaks again");
  assert.equal(back.next.blind, 0);
});

test("a firing found only after an outage is still a firing", () => {
  const blind = transition(clear(), "undecided", T1).next;
  const found = transition(blind, "firing", T1);
  assert.equal(found.send, "firing");
  assert.equal(found.next.since, T1);
});

/* ------------------------------------------------------------------------ *
 * The rules themselves, against a chain that answers whatever this says.
 *
 * A fake reader rather than a node, because the assertions that matter are
 * about readings a real node will not produce on demand: an address that holds
 * nothing, a grant past its term, a balance exactly on its threshold. Waiting
 * for testnet to arrange those is how they go untested.
 * ------------------------------------------------------------------------ */

import { evaluate, type Reader } from "../alerts.ts";

/** agent #003's real manifest: budget 2 KAS, 1.12 spent, cap 0.1. */
const GRANT = "x402/demo/agent-003-grant.json";
const EXPIRES = 590324779n;

const reader = (holdings: Record<string, bigint[]>, daa: bigint): Reader => ({
  daa,
  at: async (address) => holdings[address] ?? holdings["*"] ?? [],
});

test("a balance rule compares sompi and ignores the quote entirely", async () => {
  const addr = "kaspatest:qqtest";
  const quote = { amount: "50", asset: "USD", perKas: "0.05", source: "you, once" };

  const under = await evaluate(
    { id: "s", kind: "balance-at-or-above", address: addr, atOrAbove: "1000", quote },
    reader({ [addr]: [400n, 500n] }, 1n),
  );
  assert.equal(under.status, "clear");

  const on = await evaluate(
    { id: "s", kind: "balance-at-or-above", address: addr, atOrAbove: "1000", quote },
    reader({ [addr]: [400n, 600n] }, 1n),
  );
  assert.equal(on.status, "firing", "at the threshold is at or above it");
  assert.ok(
    on.status === "firing" && on.lines.some((l) => l.includes("did not re-check")),
    "the message says the rate is not a thing this run measured",
  );
});

test("a balance rule on an address that holds nothing is clear, not undecided", async () => {
  /* Unlike a grant, an ordinary address holding nothing is a fact: it holds
     nothing. There is no second reading it could be. */
  const out = await evaluate(
    { id: "s", kind: "balance-at-or-above", address: "kaspatest:qqtest", atOrAbove: "1" },
    reader({}, 1n),
  );
  assert.equal(out.status, "clear");
});

test("a grant whose address holds nothing is UNDECIDED, never clear", async () => {
  /* The oldest lesson in this repository. An empty grant address is a manifest
     that is behind the agent OR a grant that has ended, and the two are
     opposite facts. Reporting either as "fine" is the bug. */
  const out = await evaluate({ id: "g", kind: "budget-low", grant: GRANT }, reader({}, 1n));
  assert.equal(out.status, "undecided");
  assert.ok(out.status === "undecided" && out.why.includes("warda find"));
});

test("budget-low takes the smaller of authority and coin", async () => {
  /* 0.88 KAS of authority left. A grant holding 2 KAS is therefore NOT healthy
     at a 1 KAS threshold, and a grant holding 0.1 KAS is not healthy either
     however much budget it has. */
  const rule = { id: "g", kind: "budget-low" as const, grant: GRANT, below: "100000000" };
  const rich = await evaluate(rule, reader({ "*": [200000000n] }, EXPIRES - 1000n));
  assert.equal(rich.status, "firing", "88000000 sompi of authority is below the threshold");

  const roomy = { ...rule, below: "10000000" };
  assert.equal((await evaluate(roomy, reader({ "*": [200000000n] }, EXPIRES - 1000n))).status, "clear");
  assert.equal(
    (await evaluate(roomy, reader({ "*": [5000000n] }, EXPIRES - 1000n))).status,
    "firing",
    "authority it cannot fund is not authority",
  );
});

test("an expired grant is due whatever its counters say", async () => {
  const out = await evaluate(
    { id: "g", kind: "budget-low", grant: GRANT, below: "1" },
    reader({ "*": [200000000n] }, EXPIRES),
  );
  assert.equal(out.status, "firing");
  assert.ok(out.status === "firing" && out.lines.some((l) => l.includes("term is over")));
});

test("budget-low claims nothing about a funder nobody named", async () => {
  const out = await evaluate(
    { id: "g", kind: "budget-low", grant: GRANT, below: "100000000" },
    reader({ "*": [200000000n] }, EXPIRES - 1000n),
  );
  assert.equal(out.status, "firing");
  assert.ok(
    out.status === "firing" && !out.lines.some((l) => /short by|one coin|can pay/.test(l)),
    "with no funder address there is no funder reading, and so no funder sentence",
  );
});

test("a named funder is read, and short is distinguished from not-in-one-coin", async () => {
  const f = "kaspatest:qqfunder";
  const base = {
    id: "g",
    kind: "budget-low" as const,
    grant: GRANT,
    below: "100000000",
    needed: "300000000",
    funder: f,
  };
  const daa = EXPIRES - 1000n;

  const split = await evaluate(base, reader({ [f]: [200000000n, 200000000n], "*": [200000000n] }, daa));
  assert.ok(
    split.status === "firing" && split.lines.some((l) => l.includes("not in one coin")),
    "0.4 KAS across two coins cannot fund a 3 KAS genesis, and that is not 'short'",
  );

  const poor = await evaluate(base, reader({ [f]: [1000n], "*": [200000000n] }, daa));
  assert.ok(poor.status === "firing" && poor.lines.some((l) => l.includes("short by")));

  const ok = await evaluate(base, reader({ [f]: [300000000n], "*": [200000000n] }, daa));
  assert.ok(ok.status === "firing" && ok.lines.some((l) => l.includes("can pay for the next one")));
});

test("expiring measures the term, not the budget", async () => {
  const rule = { id: "e", kind: "expiring" as const, grant: GRANT, within: 500 };
  const far = await evaluate(rule, reader({ "*": [200000000n] }, EXPIRES - 5000n));
  assert.equal(far.status, "clear");
  const near = await evaluate(rule, reader({ "*": [200000000n] }, EXPIRES - 100n));
  assert.equal(near.status, "firing");
});

test("an unknown kind refuses rather than being evaluated as something else", async () => {
  const out = await evaluate(
    { id: "?", kind: "budget-lo" as unknown as "budget-low", grant: GRANT },
    reader({ "*": [200000000n] }, 1n),
  );
  assert.equal(out.status, "undecided");
  assert.ok(out.status === "undecided" && out.why.includes("no such kind"));
});
