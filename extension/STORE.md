# Chrome Web Store submission

Everything the listing needs, in the words to paste. Brave installs from the
Chrome Web Store, so this covers both.

## Package

```
npm run build && npm run zip     # build/wardaprotocolconsole-<version>-chrome.zip
```

## Visibility

Start **Private**, with testers added by Google account (or a Google Group you
own) in the developer dashboard. Review still applies, so submitting early
starts the only clock with a long lead time. Flipping later to Unlisted, and
then Public, does not make anyone reinstall.

## Listing

**Name:** Warda Console

**Summary** (132 char max):
> Give an autonomous agent a budget the Kaspa network enforces. Issue it, watch
> it spend, end it. Testnet only.

**Category:** Developer Tools · **Language:** English

**Description:**

> Warda Console is the principal's half of the Warda protocol: the place a
> human gives an autonomous agent money, watches what it does with it, and takes
> it back.
>
> A Warda grant is not an allowance an app agrees to respect. The budget, the
> per-transaction cap, the rate limit and the list of addresses the agent may
> pay are compiled into a Kaspa L1 covenant, and the grant's address is a hash
> of those terms. An agent that tries to exceed one of them is not refused by
> software — there is no valid transaction for it to sign.
>
> • Issue a grant: budget, per-spend cap, and who it may pay. Fixed at creation
>   and unchangeable afterwards, including by you.
> • Hand over the agent's key once. It is generated here, shown once, and
>   stored nowhere — the agent runs elsewhere.
> • Watch it spend. A grant's address moves every time it pays someone, and the
>   console follows it rather than reporting an empty address as a balance of
>   zero.
> • End it whenever you like. What is left comes back to you.
>
> The key this extension does hold — the one that issues and revokes — is
> encrypted at rest behind a passphrase and unlocked only in the background
> worker. The interface has no way to read it.
>
> Testnet only. Open source: github.com/ArtyKOMarkets/warda

**Privacy policy URL:**
`https://github.com/ArtyKOMarkets/warda/blob/main/extension/PRIVACY.md`

**Screenshots:** `ops/store/*.png`, four at 1280×800.

## The questions the dashboard asks

**Single purpose.** Issuing, monitoring and revoking Warda spending grants on
the Kaspa network. Everything in the extension serves that one purpose.

**`storage`.** To hold the user's own principal key, encrypted under their
passphrase, and the records of the grants they have issued. Nothing is
transmitted anywhere.

**`alarms`.** To lock the wallet automatically after a period of inactivity.
That is its only use.

**Host permissions.** None requested. The extension connects by WebSocket to
the Kaspa node the user configures, and reads and writes no web page.

**Remote code.** None. No code is fetched at runtime; there are no remote
scripts, stylesheets or fonts. The content security policy is stated in the
manifest rather than inherited.

**Data use.** No user data is collected, transmitted or sold. The extension has
no server component and no analytics.

## Expect extra scrutiny

Anything that looks like a crypto wallet gets a closer read. The strongest
version of the argument is the true one: two permissions, no host permissions,
no content script, no remote code, open source, testnet only — and every claim
above is checkable in the repository.

## Regenerating the screenshots

`ops/preview.mjs` renders each popup state by answering the popup's own
messages with canned ones, and `ops/store-shots.py` composes those into
1280×800 store images. The first needs a Chromium — it drives the real built
popup rather than a mockup, which is the point.
