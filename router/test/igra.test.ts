import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GALLEON_TESTNET,
  IGRA_MAINNET,
  WEI_PER_SOMPI,
  weiToSompi,
  sompiToWei,
  bridgeDust,
  assertChain,
} from "../src/index.ts";

test("the network parameters are the published ones", () => {
  assert.equal(GALLEON_TESTNET.chainId, 38836);
  assert.equal(GALLEON_TESTNET.rpcUrl, "https://galleon-testnet.igralabs.com:8545");
  assert.equal(IGRA_MAINNET.chainId, 38833);
  assert.equal(GALLEON_TESTNET.nativeDecimals, 18, "iKAS is an 18-decimal EVM token");
});

test("one sompi is ten billion iKAS wei", () => {
  assert.equal(WEI_PER_SOMPI, 10_000_000_000n);
  assert.equal(sompiToWei(1n), WEI_PER_SOMPI);
  /* 1 KAS == 1 iKAS in value, 1e8 sompi vs 1e18 wei in representation. */
  assert.equal(sompiToWei(100_000_000n), 10n ** 18n);
});

test("going up is exact, so nothing is silently lost funding a crossing", () => {
  for (const s of [0n, 1n, 2_000_000n, 123_456_789n]) {
    assert.equal(weiToSompi(sompiToWei(s)), s);
    assert.equal(bridgeDust(sompiToWei(s)), 0n);
  }
});

test("going down rounds toward the receiver being short, never over", () => {
  /* One wei under a whole sompi arrives as nothing. */
  assert.equal(weiToSompi(WEI_PER_SOMPI - 1n), 0n);
  assert.equal(weiToSompi(WEI_PER_SOMPI * 3n - 1n), 2n);
  assert.equal(weiToSompi(WEI_PER_SOMPI * 3n + 1n), 3n);
});

test("dust is named rather than truncated inside something else", () => {
  assert.equal(bridgeDust(WEI_PER_SOMPI - 1n), WEI_PER_SOMPI - 1n);
  assert.equal(bridgeDust(WEI_PER_SOMPI * 5n + 7n), 7n);
  /* What arrives plus what is stranded is what you sent. */
  const sent = 123_456_789_012_345n;
  assert.equal(sompiToWei(weiToSompi(sent)) + bridgeDust(sent), sent);
});

test("negative amounts are refused, not wrapped", () => {
  assert.throws(() => weiToSompi(-1n), /cannot be negative/);
  assert.throws(() => sompiToWei(-1n), /cannot be negative/);
  assert.throws(() => bridgeDust(-1n), /cannot be negative/);
});

test("a plan aimed at the wrong chain is refused, and says why it is easy to confuse", () => {
  assert.doesNotThrow(() => assertChain(GALLEON_TESTNET, 38836));
  assert.throws(() => assertChain(GALLEON_TESTNET, 38833), /differ by three digits/);
  assert.throws(() => assertChain(IGRA_MAINNET, 38836), /real money on it/);
});
