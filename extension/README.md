# Warda Console

A browser extension for the **principal** — the person who gives an agent money
and can take it back.

```
npm install          # from the repo root; this is a workspace
npm run dev          # loads into a dev Chrome profile
npm run build        # .output/chrome-mv3, load unpacked
npm test
```

## What it holds, and what it refuses to

One key: the principal key. In Warda that key is principal, revocation and
funder at once — it receives what comes back on exit, it is the only key that
can end a grant, and it pays for genesis. It is also **the only key in the
protocol that nothing bounds**, which the repo's own state doc names as the
honest gap in Warda's argument: *"the principal key is the unbounded thing and
it is a file."* A file in a project directory is a worse place for it than an
encrypted vault behind a passphrase, and neither is as good as hardware — which
is why `externalSigner` exists and why this is built to grow one.

**Agent keys are not stored.** One is generated when a grant is issued, shown
once, and handed to whoever runs the agent. That is not a simplification to be
fixed later: an agent key is already bounded by a covenant the network
enforces, so it can live on the machine that spends it. Keeping it here would
put the bounded and the unbounded key behind the same passphrase for no gain.

## The shape

| | |
|---|---|
| `entrypoints/background.ts` | the worker — the only place a key is ever in the clear |
| `entrypoints/popup/` | a renderer. No key, no node, no transaction |
| `src/vault.ts` | AES-GCM, PBKDF2-SHA256 at 600k, `storage.local` for ciphertext and `storage.session` for the unwrapped key |
| `src/messages.ts` | every question the UI may ask. There is no message that returns the principal key |
| `src/chain.ts` | connect, ask, close — see below |

The popup cannot reach the vault, the node or the chain directly. Not because
it is told not to, but because **there is no message that would let it**. A
future `exportKey` would be a visible diff in `messages.ts`, which is where it
should be argued about.

## Two decisions worth knowing before changing them

**The connection is opened per question, not held.** An MV3 service worker is
terminated after ~30s idle, and a WebSocket does keep it alive — traffic on one
resets the idle timer as of Chrome 116, which is what makes a live wallet
possible at all. But a heartbeat is a battery bill paid by every user so that a
console nobody is looking at can watch a chain nobody is spending on. A grant
moves on the order of a payment, not a frame. When live push earns its place,
the keepalive is the known answer and nothing else has to move.

**Health is `inspect`, not a ping.** The node here is by default somebody
else's — the project's four-method proxy. Three of the four ways a node can be
wrong produce a *plausible answer* rather than an error: not synced, no UTXO
index, or the wrong network, where every address is well formed and empty. The
SDK already knows how to ask, so this asks the same way rather than inventing a
lighter check that misses the case that matters.

## node_modules is shared between two machines, and npm is not

`npm` unpacks only the native binding of the platform that ran the install and
leaves EMPTY directories for the other fourteen — which it then treats as
already installed (npm/cli#4828). In this repo the folder is shared, so an
install run on Linux leaves a macOS build with a `rolldown` that cannot load,
and WXT reports that as `Builder not found. Make sure vite is installed.`
Vite is installed. `ops/check-builder.mjs` runs before every build and says
the true thing instead, naming the package this platform needs:

```
npm i --no-save "@rolldown/binding-darwin-$(node -p process.arch)@$(node -p "require('rolldown/package.json').version")"
```

Run installs from the machine that builds. If the two ever diverge badly,
remove `node_modules` and `package-lock.json` at the repo root and install
again from there.

## Loading it

Brave: `brave://extensions` → Developer mode → Load unpacked →
`extension/.output/chrome-mv3`. Chrome is the same with `chrome://`. Brave's
Shields apply to web pages and not to extension contexts, so they are not in
the way — but the extension injects nothing into any page and requests no host
permissions, so there is nothing for them to be in the way of.

## Testnet only

Mainnet is refused, and refused loudly rather than by omission. The CLI makes
mainnet a decision a person takes; this must not become the softer door into
the same place.
