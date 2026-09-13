/**
 * The worker: the only place a key is ever in the clear.
 *
 * Everything the popup can ask for arrives here as a `Request`, and every
 * answer leaves as a `Response`. The popup cannot reach the vault, the node or
 * the chain directly — not because it is told not to, but because there is no
 * message that would let it.
 */
import { agentPublicKey, fromHex, pubkeyToAddress, toHex } from "@warda_protocol/kaspa";
import { schnorr } from "@noble/curves/secp256k1.js";
import * as vault from "../src/vault.ts";
import { settings, setSettings } from "../src/store.ts";
import { status as nodeStatus } from "../src/chain.ts";
import { issue, live, revoke } from "../src/grants.ts";
import type { Request, Response, Settings, Status } from "../src/messages.ts";

export default defineBackground(() => {
  void vault.harden();

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (vault.isLockAlarm(alarm.name)) void vault.lock();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handle(message as Request)
      .then((value) => sendResponse({ ok: true, value } satisfies Response<unknown>))
      .catch((e: Error) => sendResponse({ ok: false, error: e.message } satisfies Response<never>));
    // Keeps the channel open for the async answer above. Returning anything
    // falsy here closes it and the popup sees `undefined` from every call —
    // which looks exactly like a worker that crashed.
    return true;
  });
});

function prefixFor(network: string): "kaspa" | "kaspatest" {
  return network === "mainnet" ? "kaspa" : "kaspatest";
}

async function status(): Promise<Status> {
  const blob = await vault.readVault();
  const s = await settings();
  return {
    hasVault: blob !== null,
    unlocked: await vault.isUnlocked(),
    publicKey: blob?.publicKey ?? null,
    address: blob ? pubkeyToAddress(fromHex(blob.publicKey), prefixFor(s.network)) : null,
    settings: s,
  };
}

async function handle(request: Request): Promise<unknown> {
  // Any message from an open console is a sign of life; push the auto-lock out.
  if (request.kind !== "lock") await vault.touch((await settings()).lockMinutes);

  switch (request.kind) {
    case "status":
      return status();

    case "create": {
      /* A generated key beats an imported one here and the console offers
         both, because the funded testnet key people already have is the one
         they will want to use, and refusing it just moves the import into a
         worse place than this. */
      const secret = request.importSecretHex
        ? fromHex(request.importSecretHex.trim())
        : schnorr.utils.randomSecretKey();
      if (secret.length !== 32) {
        throw new Error(`a principal key is 32 bytes of hex (64 characters); got ${secret.length}`);
      }
      const pub = toHex(agentPublicKey(secret));
      await vault.create(secret, pub, request.passphrase);
      secret.fill(0);
      await vault.unlock(request.passphrase, (await settings()).lockMinutes);
      return status();
    }

    case "unlock":
      await vault.unlock(request.passphrase, (await settings()).lockMinutes);
      return status();

    case "lock":
      await vault.lock();
      return status();

    case "setSettings": {
      const next: Settings = await setSettings(request.settings);
      if (next.network === "mainnet") {
        /* The CLI makes mainnet a decision a person takes rather than a
           default they inherit, and this must not be the softer door into the
           same place. Until the console has been exercised against real money
           it says so instead of pretending. */
        await setSettings({ network: "testnet-10" });
        throw new Error(
          "this console is testnet-only for now. Mainnet needs the same deliberate gate the CLI has, " +
            "and the console has not been exercised against real money yet.",
        );
      }
      return status();
    }

    case "nodeStatus":
      return nodeStatus();

    case "grants":
      return live();

    /* The one message whose answer carries a secret: the agent key, once, on
       its way to whoever runs the agent. It is generated here and stored
       nowhere — see grants.ts for why deriving it instead would collapse the
       separation the protocol exists to make. */
    case "issue":
      return issue(request.terms);

    case "revoke":
      return revoke(request.id, request.feeSompi);

    case "destroyVault":
      await vault.destroy();
      return status();
  }
}
