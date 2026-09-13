# Warda Console

A browser extension for the **principal** — the person who gives an agent money
and can take it back.

```
npm install          # from the repo root; this is a workspace
npm run dev          # loads into a dev Chrome profile
npm run build        # build/chrome-mv3, load unpacked
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
npm run bindings
```

Installing one platform's binding with npm EVICTS the other's — two machines,
one directory, one winner, and the loser's build fails with a message about
vite. That is a loop, not a fix. `ops/bindings.mjs` fetches the tarballs and
unpacks them directly instead, so both platforms sit in the same tree and
neither machine disturbs the other. A full `npm install` prunes them again;
running it again takes a few seconds.

It covers `rolldown`, `lightningcss` and `esbuild`, and chooses each variant by
matching platform, architecture and libc tokens against that package's own
`optionalDependencies` — so a new bundler dependency with the same habit needs
one name in a list, not a new naming rule. The second package only surfaced
after the first was fixed, which is how a list of packages turned out to be the
wrong model to begin with.

The output is `build/` rather than WXT's `.output/` for one reason: loading an
unpacked extension means picking the folder in a native file dialog, and macOS
hides dot-folders there. The default cost a forgettable keystroke every time,
on the one step a person has to do by hand.

`WARDA_OUT` moves it elsewhere again. A build CLEANS its output
directory, and a filesystem that allows writes but not deletes turns that into
`EPERM: operation not permitted, unlink background.js` — a message about the
bundler that is really a message about the mount.

## Following a grant that moved

A grant's address is a hash of its state, so every spend RELOCATES it, and a
record one payment stale points at an empty address — which is also what
drained, revoked and never-funded look like. Kaspa's node RPC answers "what is
unspent here" and never "what spent this", so catching up means guessing states
and asking.

The guessing is `candidateStates` in the SDK, and the reason it is cheap is
worth knowing before touching this: a spend moves exactly three fields —
`spentTotal`, `epochIndex`, `epochSpent` — so where a grant LANDS after any
number of payments depends on three numbers and not at all on the order they
happened in. A combinatorial walk becomes an enumeration of endpoints, and an
endpoint is the one thing actually observable.

The evidence is the coins at the PAYEES: one UTXO per payment, each carrying
the DAA score of the block that accepted it. That is why the recipients are
kept in the record — a lost payee list leaves a grant that can still be revoked
but never followed. When the suffix search finds nothing and the list is short,
it escalates to subsets, which is the case where a payee is shared with another
grant.

Finding nothing still means finding nothing. The card says the grant could not
be placed and lists what that could mean, rather than printing a zero.

## The icon is drawn, not exported

`ops/icon.py` writes `public/icon/{16,32,48,96,128}.png`. The real mark —
`site/assets/warda-mark.png` — is a silver W in a teal shield, and shrinking it
was the first attempt: at 128px it is beautiful, at 16 the strokes are one grey
pixel, and because the artwork is white-on-transparent it very nearly
disappears on Brave's LIGHT toolbar, which is where the icon actually lives.

So the icon is the same mark simplified on a filled dark tile, and the tile is
the point: it makes the contrast independent of whatever is behind it. 16px
gets its own art with the W left out — two strokes landing on the same three
grey pixels read as a smudge across the shield, and different art for a
different size is what an icon set is for.

It lives in code rather than as five PNGs somebody exported once, so the next
person who wants the star a little bigger can have it.

## Letting other people test it

`STORE.md` has the submission package: the listing copy, the answers to every
question the dashboard asks, and the screenshots in `ops/store/`. `PRIVACY.md`
is the privacy policy, and it is short because there is nothing to disclose —
two permissions, no host permissions, no content script, no remote code, no
server.

## Loading it

Brave: `brave://extensions` → Developer mode → Load unpacked →
`extension/build/chrome-mv3`. Chrome is the same with `chrome://`. Brave's
Shields apply to web pages and not to extension contexts, so they are not in
the way — but the extension injects nothing into any page and requests no host
permissions, so there is nothing for them to be in the way of.

## Testnet only

Mainnet is refused, and refused loudly rather than by omission. The CLI makes
mainnet a decision a person takes; this must not become the softer door into
the same place.
