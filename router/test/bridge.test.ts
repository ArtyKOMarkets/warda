import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_EXIT_SOMPI,
  exitValueWei,
  assertExitAmount,
  assertPayoutAddress,
  WEI_PER_SOMPI,
  quote,
  planFunding,
  type VenueConfig,
} from "../src/index.ts";
import { scriptHashToAddress } from "@warda_protocol/kaspa";

test("the minimum exit is a thousand KAS, as their guide states it", () => {
  assert.equal(MIN_EXIT_SOMPI, 100_000_000_000n);
  assert.throws(() => assertExitAmount(MIN_EXIT_SOMPI - 1n), /ExitAmountBelowMinimum/);
  assert.doesNotThrow(() => assertExitAmount(MIN_EXIT_SOMPI));
});

test("the refusal explains what the constraint means, not just that it exists", () => {
  assert.throws(() => assertExitAmount(1n), /cross once, then fund grants from what arrived/);
});

test("msg.value is the contract's formula, not ours", () => {
  /* (unlock + fee) * 1e10 — quoted from the developer guide. */
  assert.equal(exitValueWei(100n, 5n), 105n * WEI_PER_SOMPI);
  assert.equal(exitValueWei(MIN_EXIT_SOMPI, 0n), MIN_EXIT_SOMPI * WEI_PER_SOMPI);
  assert.throws(() => exitValueWei(-1n, 0n), /cannot be negative/);
});

test("an amount too large for uint64 is refused rather than wrapped", () => {
  assert.throws(() => assertExitAmount(2n ** 64n), /uint64/);
});

/* A real, checksum-valid testnet address, derived rather than typed. */
const good = scriptHashToAddress(new Uint8Array(32).fill(7), "kaspatest");

test("a payout address with a broken checksum is caught here, because the bridge will not", () => {
  assert.doesNotThrow(() => assertPayoutAddress(good));

  /* Transpose two characters in the body: still the right prefix, still the
     right charset, so the contract would accept it. */
  const body = good.slice(good.indexOf(":") + 1);
  const swapped =
    good.slice(0, good.indexOf(":") + 1) + body[1] + body[0] + body.slice(2);
  assert.notEqual(swapped, good);
  assert.throws(() => assertPayoutAddress(swapped), /The bridge would ACCEPT this/);
});

test("a mainnet address in a testnet plan is refused", () => {
  const mainnet = scriptHashToAddress(new Uint8Array(32).fill(7), "kaspa");
  assert.throws(() => assertPayoutAddress(mainnet, "kaspatest"), /does not check which network/);
  assert.doesNotThrow(() => assertPayoutAddress(mainnet, "kaspa"));
});

const venue: VenueConfig = {
  name: "Zealous Swap",
  chainId: 38836,
  addresses: { router: "0xrouter", token: "0xusdc" },
};
const bridge: VenueConfig = { name: "Igra bridge", chainId: 38836, addresses: { withdraw: "0xbridge" } };

const usdQuote = (amount: string) =>
  quote({
    price: { asset: "USD", amount },
    rate: { perKas: "0.05", asset: "USD", source: "test-oracle", observedAt: 1 },
    expiresAt: Date.now() + 30_000,
  });

test("a small funding plan is BLOCKED, not merely unconfigured", () => {
  /* $5 at $0.05/KAS is 100 KAS — a tenth of the bridge's minimum. */
  const p = planFunding({
    quote: usdQuote("5.00"),
    from: { asset: "USDC.e", layer: "igra" },
    venue,
    bridge,
    payoutAddress: good,
  });
  assert.equal(p.executable, false);
  assert.equal(p.blockers.length, 1);
  assert.match(p.blockers[0] ?? "", /minimum exit is 100000000000/);
  assert.deepEqual([...p.steps[0]!.missing], [], "nothing is missing; the world says no");
});

test("a treasury-sized funding plan clears the bridge and is executable", () => {
  /* $60 at $0.05/KAS is 1,200 KAS. */
  const p = planFunding({
    quote: usdQuote("60.00"),
    from: { asset: "USDC.e", layer: "igra" },
    venue,
    bridge,
    payoutAddress: good,
  });
  assert.deepEqual([...p.blockers], []);
  assert.equal(p.executable, true);
  assert.equal(p.verdict.recipientEnforced, true);
});

test("a missing payout address is a TODO, and a bad one is not a plan at all", () => {
  const p = planFunding({ quote: usdQuote("60.00"), from: { asset: "USDC.e", layer: "igra" }, venue, bridge });
  assert.ok(p.steps[1]!.missing.includes("payoutAddress"));

  assert.throws(
    () =>
      planFunding({
        quote: usdQuote("60.00"),
        from: { asset: "USDC.e", layer: "igra" },
        venue,
        bridge,
        payoutAddress: "kaspatest:notarealaddress",
      }),
    /does not verify/,
  );
});
