import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, quoteForSompi, fitsUnderCap, isExpired, STORAGE_MASS_FLOOR_SOMPI } from "../src/index.ts";

const USD = (amount: string) => ({ asset: "USD", amount });
const rate = (perKas: string) => ({
  perKas,
  asset: "USD",
  source: "test-oracle",
  observedAt: 1_758_000_000_000,
});
const SOON = 1_758_000_060_000;

test("a dollar price converts at the stated rate", () => {
  /* $0.50 at $0.05 per KAS is 10 KAS. */
  const q = quote({ price: USD("0.50"), rate: rate("0.05"), expiresAt: SOON });
  assert.equal(q.sompi, 1_000_000_000n);
  assert.equal(q.maxSompi, 1_000_000_000n, "no slippage means no headroom");
  assert.equal(q.zone, "attested");
  assert.equal(q.rate?.source, "test-oracle");
});

test("the rate is carried, not swallowed — a reader can go and ask", () => {
  const q = quote({ price: USD("1"), rate: rate("0.04"), expiresAt: SOON });
  assert.equal(q.rate?.perKas, "0.04");
  assert.equal(q.rate?.observedAt, 1_758_000_000_000);
});

test("a KAS price converts without a rate and attests to nothing", () => {
  const q = quote({ price: { asset: "KAS", amount: "1.5" }, expiresAt: SOON });
  assert.equal(q.sompi, 150_000_000n);
  assert.equal(q.rate, null);
});

test("passing a rate with a KAS price is refused rather than ignored", () => {
  assert.throws(
    () => quote({ price: { asset: "KAS", amount: "1" }, rate: rate("0.05"), expiresAt: SOON }),
    /needs no rate/,
  );
});

test("a rate against the wrong asset is refused, not silently crossed", () => {
  assert.throws(
    () =>
      quote({
        price: USD("1"),
        rate: { perKas: "0.05", asset: "EUR", source: "x", observedAt: 1 },
        expiresAt: SOON,
      }),
    /inventing a second rate/,
  );
});

test("conversion rounds up, so a vendor is never short-paid", () => {
  /* $1 at $0.03 per KAS is 33.333... KAS; the last sompi rounds up. */
  const q = quote({ price: USD("1"), rate: rate("0.03"), expiresAt: SOON });
  assert.equal(q.sompi, 3_333_333_334n);
});

test("slippage widens maxSompi and leaves sompi alone", () => {
  const q = quote({ price: USD("0.50"), rate: rate("0.05"), slippageBps: 100, expiresAt: SOON });
  assert.equal(q.sompi, 1_000_000_000n);
  assert.equal(q.maxSompi, 1_010_000_000n, "1% of headroom, rounded up");
});

test("the cap binds the worst case, not the quoted case", () => {
  const q = quote({ price: USD("0.50"), rate: rate("0.05"), slippageBps: 100, expiresAt: SOON });
  /* A cap sitting between sompi and maxSompi must REFUSE: the payment quotes
     inside the limit and can execute outside it. */
  assert.equal(fitsUnderCap(q, 1_005_000_000n).ok, false);
  assert.equal(fitsUnderCap(q, q.maxSompi).ok, true);
});

test("a rate move that breaks the cap refuses, and says why", () => {
  const q = quote({ price: USD("0.50"), rate: rate("0.01"), expiresAt: SOON });
  const v = fitsUnderCap(q, 1_000_000_000n);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /cap is in the coin and cannot be raised in place/);
});

test("a price under the storage-mass floor is refused where it is made", () => {
  assert.throws(
    () => quote({ price: USD("0.0001"), rate: rate("0.05"), expiresAt: SOON }),
    /storage-mass floor/,
  );
});

test("the floor binds the expected payment, not the slippage ceiling", () => {
  /* 0.000995 USD at 0.05 USD/KAS is 1_990_000 sompi — just under the floor.
     1% of slippage would lift the CEILING to 2_009_900, over it. That must not
     rescue the quote: the ordinary outcome is still a transaction too small to
     broadcast, and it would only clear the floor if the market moved against
     the buyer. */
  const under = { price: USD("0.000995"), rate: rate("0.05"), expiresAt: SOON };
  assert.throws(() => quote({ ...under, slippageBps: 0 }), /storage-mass floor/);
  assert.throws(() => quote({ ...under, slippageBps: 100 }), /storage-mass floor/);

  /* And a price genuinely at the floor is fine. */
  const at = quote({ price: USD("0.001"), rate: rate("0.05"), expiresAt: SOON });
  assert.equal(at.sompi, STORAGE_MASS_FLOOR_SOMPI);
});

test("nonsense amounts are rejected, not coerced", () => {
  assert.throws(() => quote({ price: USD("-1"), rate: rate("0.05"), expiresAt: SOON }), /decimal string/);
  assert.throws(() => quote({ price: USD("1e5"), rate: rate("0.05"), expiresAt: SOON }), /decimal string/);
  assert.throws(() => quote({ price: USD("1"), rate: rate("0"), expiresAt: SOON }), /zero/);
});

test("slippage outside 0..10000 bps is rejected", () => {
  assert.throws(
    () => quote({ price: USD("1"), rate: rate("0.05"), slippageBps: -1, expiresAt: SOON }),
    /slippageBps/,
  );
  assert.throws(
    () => quote({ price: USD("1"), rate: rate("0.05"), slippageBps: 1.5, expiresAt: SOON }),
    /slippageBps/,
  );
});

test("a quote has a shelf life", () => {
  const q = quote({ price: USD("1"), rate: rate("0.05"), expiresAt: SOON });
  assert.equal(isExpired(q, SOON - 1), false);
  assert.equal(isExpired(q, SOON), true, "expiry is inclusive; a quote at its deadline is stale");
});

test("no quote ever claims consensus enforced it", () => {
  const q = quote({ price: USD("1"), rate: rate("0.05"), expiresAt: SOON });
  assert.equal(q.zone, "attested");
  assert.notEqual(q.zone as string, "enforced");
});

test("the inverse quote says what to sell for a given amount of KAS", () => {
  /* 10 KAS at $0.05 per KAS is $0.50. */
  const q = quoteForSompi({ sompi: 1_000_000_000n, rate: rate("0.05"), expiresAt: SOON });
  assert.equal(q.price.amount, "0.5");
  assert.equal(q.price.asset, "USD");
  assert.equal(q.sompi, 1_000_000_000n, "the amount asked for, not one derived back");
  assert.equal(q.zone, "attested");
});

test("the inverse never understates the cost, at any rate", () => {
  /* The property, rather than a magic constant: whatever price comes back,
     selling exactly that much must buy at least the sompi that was asked for.
     A constant here would only test my arithmetic. */
  const cases: [bigint, string][] = [
    [1_000_000_001n, "0.05"],
    [123_456_789n, "0.037"],
    [2_000_000_003n, "0.0333333333333333"],
    [50_003_000_000n, "0.041666666666666667"],
  ];
  for (const [sompi, perKas] of cases) {
    const q = quoteForSompi({ sompi, rate: rate(perKas), expiresAt: SOON });
    const back = quote({ price: q.price, rate: rate(perKas), expiresAt: SOON });
    assert.ok(
      back.sompi >= sompi,
      `${q.price.amount} at ${perKas} buys ${back.sompi}, short of ${sompi}`,
    );
  }
});

test("the inverse refuses an amount below the storage-mass floor", () => {
  assert.throws(() => quoteForSompi({ sompi: 1n, rate: rate("0.05"), expiresAt: SOON }), /storage-mass floor/);
  assert.throws(() => quoteForSompi({ sompi: 0n, rate: rate("0.05"), expiresAt: SOON }), /must be positive/);
});

test("the inverse and the forward direction agree at a round figure", () => {
  const back = quoteForSompi({ sompi: 1_000_000_000n, rate: rate("0.05"), expiresAt: SOON });
  const forward = quote({ price: back.price, rate: rate("0.05"), expiresAt: SOON });
  assert.equal(forward.sompi, back.sompi);
});

test("minSompi is the other end of the same range, rounded down", () => {
  const q = quote({
    price: { asset: "USD", amount: "10" },
    rate: { perKas: "0.1", asset: "USD", source: "t", observedAt: 0 },
    slippageBps: 100,
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(q.sompi, 10_000_000_000n);
  assert.equal(q.minSompi, 9_900_000_000n);
  assert.equal(q.maxSompi, 10_100_000_000n);
});
