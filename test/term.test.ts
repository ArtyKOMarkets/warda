/**
 * The term, and the two directions it can be read wrong.
 *
 * Both dashboards emit this block now, so a mistake here is a mistake on every
 * agent page at once. The assertions that matter are about null: a negative
 * duration rendered as "expires in -6 days", and an "expired 0 seconds ago" on
 * a grant that is still running, are the two ways this shape fails quietly.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { daaDuration, termReading } from "../src/term.ts";

const DAY = 864_000n; // blocks, at ten a second

test("a running term reports how long is left and nothing about the past", () => {
  const t = termReading({ notBefore: 1000n, expiresAt: 1000n + 30n * DAY, now: 1000n + DAY });
  assert.equal(t.expired, false);
  assert.equal(t.expiresIn, "29 days");
  assert.equal(t.expiresInDaa, String(29n * DAY));
  assert.equal(t.expiredAgo, null, "nothing has expired, so there is no 'ago'");
  assert.equal(t.open, true);
  /* "24 hours", not "1 day": the unit only changes at 48 hours. Written here
     as the boundary it is, because the first version of this test assumed the
     obvious answer and the formatter is the thing being pinned. */
  assert.equal(t.openedAgo, "24 hours");
});

test("an expired term reports how long ago and never a negative duration", () => {
  const t = termReading({ notBefore: 1000n, expiresAt: 1000n + DAY, now: 1000n + 7n * DAY });
  assert.equal(t.expired, true);
  assert.equal(t.expiredAgo, "6 days");
  assert.equal(t.expiresIn, null, "a consumer that formats this must not print 'in -6 days'");
  assert.equal(t.expiresInDaa, null);
});

test("expiry is inclusive: at expiresAt the grant is over", () => {
  /* The covenant's check is `claimedDaa < expiresAt`, so the boundary block is
     already outside the term. Off by one here would report a dead grant as
     live for one block — and on Kaspa that is a tenth of a second, which is
     exactly the kind of thing nobody ever reproduces. */
  const t = termReading({ notBefore: 0n, expiresAt: 500n, now: 500n });
  assert.equal(t.expired, true);
  assert.equal(t.expiresIn, null);
});

test("a grant that has not opened yet says so, with no openedAgo", () => {
  const t = termReading({ notBefore: 1000n, expiresAt: 9999n, now: 10n });
  assert.equal(t.open, false);
  assert.equal(t.openedAgo, null);
  assert.equal(t.expired, false);
});

test("lockedFor is measured from creation, not from now", () => {
  const t = termReading({ notBefore: 1000n + DAY, expiresAt: 9_000_000n, now: 1000n, createdAtDaa: 1000n });
  assert.equal(t.lockedFor, "24 hours");
  assert.equal(t.open, false);
});

/* The thresholds, not the obvious answers. It says "60 seconds" rather than
   "1 minute" and "60 minutes" rather than "1 hour", because the unit changes at
   90 of the smaller one — which avoids "1.5 hours" and surprises anybody who
   reads only the unit names. Pinned so a tidy-up cannot silently reword every
   agent page. */
test("daaDuration changes unit at 90, and at 48 hours", () => {
  assert.equal(daaDuration(10n), "1 second");
  assert.equal(daaDuration(890n), "89 seconds");
  assert.equal(daaDuration(900n), "2 minutes");
  assert.equal(daaDuration(600n), "60 seconds");
  assert.equal(daaDuration(36_000n), "60 minutes");
  /* 90 minutes exactly is reported as "2 hours", not "90 minutes": the
     minutes branch is `< 90`, and the hours branch rounds. So the sequence
     jumps 89 minutes -> 2 hours with nothing in between. Surprising, harmless,
     and pinned so nobody "fixes" it into a different set of page wordings. */
  assert.equal(daaDuration(54_000n), "2 hours");
  assert.equal(daaDuration(DAY), "24 hours");
  assert.equal(daaDuration(DAY * 2n), "2 days");
  assert.equal(daaDuration(DAY * 3n), "3 days");
});

test("both enforcement sentences name the covenant's own comparison", () => {
  const t = termReading({ notBefore: 0n, expiresAt: 10n, now: 1n });
  assert.match(t.enforcedBy, /claimedDaa >= notBefore/);
  assert.match(t.termEnforcedBy, /claimedDaa < expiresAt/);
});
