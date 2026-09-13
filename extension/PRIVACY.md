# Warda Console — privacy

Last updated 13 September 2026.

**The Warda Console collects nothing, sends nothing to us, and has no servers.**
That is not a policy decision that could quietly change: the extension requests
two permissions, `storage` and `alarms`, and no host permissions at all. It
injects no code into any page you visit and cannot read one.

## What it stores, and where

Everything stays in your own browser profile, in the extension's own storage.
Nothing is synced to any account.

| what | where | notes |
|---|---|---|
| your principal key | `chrome.storage.local` | encrypted with AES-GCM under a key derived from your passphrase by PBKDF2-SHA256 at 600,000 iterations. We never see it, and neither does the extension's own interface — only its background worker, after you unlock. |
| the unlocked key, while unlocked | `chrome.storage.session` | held in memory only, never written to disk, discarded when you lock, when it times out, and when the browser closes. |
| your grant records | `chrome.storage.local` | public information: addresses, amounts, limits. Deliberately not synced, because a record says where a grant currently lives. |
| your settings | `chrome.storage.local` | which node to talk to, and the auto-lock timeout. |

**Agent keys are not stored at all.** One is generated when you issue a grant,
shown to you once, and discarded.

## What leaves your machine

One thing: a WebSocket connection to the Kaspa node you point it at, carrying
four requests — `getInfo`, `getBlockDagInfo`, `getUtxosByAddresses`, and
`submitTransaction`. That node sees the addresses you ask about and the
transactions you broadcast, which is inherent to using a blockchain through
someone else's node and is why the node is configurable.

The default is a node operated by this project as a convenience for people
trying it out. It is best effort and makes no uptime promise. Point it at your
own by changing the setting.

There is no analytics, no telemetry, no crash reporting, no advertising
identifier, and no third-party service of any kind.

## Testnet

This version refuses mainnet. It works with Kaspa testnet-10 only, where coins
have no monetary value.

## Source

The extension is open source: https://github.com/ArtyKOMarkets/warda, under
`extension/`. Every claim above is checkable there, which is the only kind of
privacy policy worth writing for software that holds a key.

Questions: https://github.com/ArtyKOMarkets/warda/issues
