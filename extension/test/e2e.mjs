/**
 * The extension, in a real browser, against a chain.
 *
 * Everything else here is a unit test with a fake `chrome` object, and that
 * leaves the part most likely to be wrong entirely unchecked: whether an MV3
 * service worker can hold a WebSocket to kaspad, whether the popup's messages
 * reach it, whether `storage.session` behaves the way the vault assumes. None
 * of that is knowable from Node, and the repo has learned this lesson four
 * times — code that has never been exercised end to end is unexercised
 * regardless of its test count.
 *
 * So: Chromium with the built extension loaded, driven for real, against
 * `test/harness/fake-node.ts` — the same fake kaspad the buy path is tested
 * with, speaking the wire format kaspad actually uses. No money, no network.
 *
 *   npm run build && npm run e2e
 *
 * Needs a Chromium-family browser, and prefers the one you actually use:
 * WARDA_CHROME if set, else Brave where it is installed, else whatever
 * Playwright has. Running it against your own browser is the point — Brave and
 * Chrome share an engine but not their defaults, and the difference between
 * "Chromium allows this" and "my browser allows this" is exactly the class of
 * thing this file exists to stop me from assuming.
 */
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFakeNode } from "../../test/harness/fake-node.ts";
import { payToPubkeyScript, pubkeyToAddress, agentPublicKey, fromHex, toHex, scriptPublicKeyToWire }
  from "@warda_protocol/kaspa";

/* A throwaway principal. Imported rather than generated so the test knows the
   address to fund — and so the import path is exercised, which is the one
   people will actually use with a key they already have. */
const PRINCIPAL = "11".repeat(32);
const PASSPHRASE = "a passphrase nobody uses";
const PAYEE = "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4";

const EXT = process.env.WARDA_OUT
  ? `${process.env.WARDA_OUT}/chrome-mv3`
  : fileURLToPath(new URL("../build/chrome-mv3", import.meta.url));
const ok = (m) => console.log(`  ok  ${m}`);

/** The browser to drive, preferring the one whose defaults actually matter. */
function browserPath() {
  if (process.env.WARDA_CHROME) return process.env.WARDA_CHROME;
  const candidates = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta",
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
  ];
  return candidates.find((c) => existsSync(c));
}

const node = await startFakeNode();
const secret = fromHex(PRINCIPAL);
const address = pubkeyToAddress(agentPublicKey(secret), "kaspatest");
node.utxos = [{
  address,
  transactionId: "aa".repeat(32),
  index: 0,
  amount: 500_000_000n,
  scriptPublicKey: scriptPublicKeyToWire(payToPubkeyScript(agentPublicKey(secret))),
  blockDaaScore: 1n,
}];

const browser = browserPath();
console.log(`  ->  ${browser ?? "playwright's chromium"}\n`);
const context = await chromium.launchPersistentContext("", {
  channel: browser ? undefined : "chromium",
  executablePath: browser,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

let failure = null;
try {
  // The worker starts on demand; the extension id is in its url.
  let first = context.serviceWorkers()[0];
  if (!first) first = await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const id = new URL(first.url()).host;
  ok(`the service worker started (${id.slice(0, 12)}…)`);

  /* An MV3 worker is terminated when idle, and Playwright's handle to a dead
     one evaluates against nothing — `chrome` comes back undefined, which reads
     like the extension APIs are missing rather than like the worker is gone.
     So: take a fresh handle each time, and wake it if it has stopped. */
  async function inWorker(fn, arg) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const w = context.serviceWorkers().find((s) => s.url().includes(id));
      if (w) {
        try {
          return await w.evaluate(fn, arg);
        } catch (e) {
          if (attempt === 2) throw e;
        }
      }
      // Opening an extension page starts the worker again.
      const waker = await context.newPage();
      await waker.goto(`chrome-extension://${id}/popup.html`);
      await waker.close();
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("the service worker never came back");
  }

  // Point it at the fake chain. There is no settings screen yet, and writing
  // storage directly is setup rather than the thing under test.
  await inWorker(
    async (url) => chrome.storage.local.set({ settings: { nodeUrl: url, network: "testnet-10", lockMinutes: 15 } }),
    node.url,
  );

  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.getByRole("heading", { name: "The key that ends things" }).waitFor({ timeout: 10_000 });
  ok("the popup renders, and asks for a key");

  await page.getByRole("button", { name: /import a key/ }).click();
  await page.getByLabel("Principal secret key (64 hex)").fill(PRINCIPAL);
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Again").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Import this key" }).click();

  await page.getByRole("heading", { name: "Principal" }).waitFor({ timeout: 10_000 });
  await page.getByText(address).waitFor({ timeout: 5_000 });
  ok("the key is in, and the address it derives is the one it should be");

  /* THE POINT OF THIS TEST. A WebSocket from an MV3 service worker to kaspad,
     answered, parsed, and rendered. If this line ever fails the reason is
     almost certainly a Chrome policy change, not this code. */
  await page.getByText("synced, indexed, right network").waitFor({ timeout: 15_000 });
  ok("the worker reached the node over a WebSocket and inspect passed it");

  const stored = await inWorker(async () => {
    const local = await chrome.storage.local.get(null);
    const session = await chrome.storage.session.get(null);
    return { local: JSON.stringify(local), session: JSON.stringify(session) };
  });
  assert.ok(!stored.local.includes(PRINCIPAL), "the principal key reached storage.local");
  assert.ok(stored.session.includes(PRINCIPAL), "the unlocked key should be in storage.session");
  ok("in a real browser too: ciphertext on disk, the key only in session memory");

  await page.getByRole("button", { name: "Issue a grant" }).click();
  await page.getByLabel("Name it").fill("e2e agent");
  await page.getByLabel(/May pay/).fill(PAYEE);
  await page.getByRole("button", { name: "Create it" }).click();

  await page.getByRole("heading", { name: "Take the agent key now" }).waitFor({ timeout: 20_000 });
  const agentKey = (await page.locator(".card .addr").first().innerText()).trim();
  assert.match(agentKey, /^[0-9a-f]{64}$/, `the agent key should be 64 hex, got ${agentKey.slice(0, 20)}…`);
  assert.notEqual(agentKey, PRINCIPAL, "the agent key must not be the principal's");
  ok("a grant was built, signed and submitted; the agent key came back once");

  assert.equal(node.submitted.length, 1, "exactly one transaction should have been submitted");
  const genesis = node.submitted[0];
  assert.equal(genesis.version, 1, "a covenant genesis is a version-1 transaction");
  assert.ok(
    genesis.outputs.some((o) => BigInt(o.amount ?? o.value) === 200_000_000n),
    "the grant output should carry the 2 KAS budget",
  );
  ok("the node received a v1 transaction paying 2 KAS into the covenant");

  /* The key must not be anywhere but the screen. Checked against the raw
     stores rather than through the console's own accessors, because the
     accessors are part of what is being checked. */
  const after = await inWorker(async () => JSON.stringify(await chrome.storage.local.get(null)));
  assert.ok(!after.includes(agentKey), "the agent key was written to storage");
  ok("the agent key is stored nowhere");

  await page.getByLabel(/I have saved it/).check();
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByText("e2e agent").waitFor({ timeout: 10_000 });
  ok("the grant appears in the list");

  /* The fake node still holds only the funding coin, so the grant's address is
     empty — which is exactly the case this console refuses to call a zero. */
  await page.getByText(/nothing at this address/).waitFor({ timeout: 10_000 });
  ok("an empty grant address is reported as empty, not as a balance of zero");

  await page.getByRole("button", { name: "Lock now" }).click();
  await page.getByRole("heading", { name: "Locked" }).waitFor({ timeout: 5_000 });
  const locked = await inWorker(async () => JSON.stringify(await chrome.storage.session.get(null)));
  assert.ok(!locked.includes(PRINCIPAL), "locking should drop the key from session storage");
  ok("locking drops the key");

  await page.getByLabel("Passphrase").fill(PASSPHRASE);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("heading", { name: "Principal" }).waitFor({ timeout: 10_000 });
  ok("and the passphrase opens it again");
} catch (e) {
  failure = e;
} finally {
  await context.close();
  await node.close();
}

if (failure) {
  console.error(`\nFAILED: ${failure.message}`);
  process.exit(1);
}
console.log("\nthe console works in a browser.");
