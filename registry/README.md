# @warda_protocol/registry

Service discovery for agents holding a Warda grant.

**A listing is not a database row.** It is a manifest you sign with the key you
are already paid at, published on your own domain. The registry stores the URL
and nothing else, and re-reads everything from your server on every query. That
is the whole design, and it is why there is no account to make.

## Listing your service

Publish this at `https://your-domain/.well-known/warda-service.json`:

```json
{
  "version": 1,
  "name": "Weather Agent",
  "description": "Current weather and forecasts",
  "endpoint": "https://your-domain/api",
  "capabilities": ["weather.current", "weather.forecast"],
  "pricing": { "asset": "KAS", "amount": "0.02", "unit": "request" },
  "payment": { "protocol": "x402", "network": "kaspa:testnet-10", "warda": true },
  "payee": "<the x-only public key you are paid at>",
  "signature": "<128 hex characters>"
}
```

```js
import { signListing } from "@warda_protocol/registry";
const published = signListing(manifest, yourPayeeSecretKey);
```

The key is the one your money already arrives at, so listing costs you no new
secret and no relationship with this project.

## What a verified listing proves, exactly

Two things, and they are different claims made by different evidence:

**You control the key the service is paid at** — the signature. Anyone can check
it; nobody can forge it.

**You control the domain the service runs on** — where the manifest was found.
The manifest must be served over https from the same host as the `endpoint` it
names, and the fetch follows no redirects.

Both are needed, and the second is the one people miss. A signature is public,
so a published manifest copies perfectly: without the origin check, anyone could
serve a copy of your listing from their own domain and it would verify.

## What it does not prove

**Anything about the service.** Not that the price is real, not that it is up,
not that it does what it says. Those are your claims about yourself, and the
registry renders them as your claims. It indexes; it does not vouch.

The one thing the registry states rather than repeats is what has actually been
**paid** to an endpoint, re-derived from the chain — which no directory that
takes your word for things can offer.

## Why a field encoding and not canonical JSON

The signature is made over an explicit, ordered, length-prefixed encoding — the
same discipline `encodeGrant` uses for the covenant — not over canonicalised
JSON.

JSON canonicalisation is a specification about Unicode escapes, number
formatting and key ordering, and every implementation of it is a chance for two
languages to disagree about bytes nobody looked at. A signature that verifies in
JavaScript and not in Python strands an honest operator with a listing that is
invalid for reasons they cannot see. A port of this encoding is a loop over a
list of fields.

Lengths rather than delimiters, because a delimiter is something an attacker can
put *inside* a field: joined by a pipe, a name of `a|b` with a description of `c`
signs the same bytes as a name of `a` with a description of `b|c`.

Capabilities are sorted before signing, so reordering your own list does not
invalidate your signature.

## Shapes that cannot be confused

A listing signature is **64 bytes**. A Warda spend signature is **65** — BIP340
plus a trailing byte naming the sighash type the script engine must recompute.
Neither verifier can be handed the other's signature and accept it, and the
digests are domain-separated on top of that: `warda:service:v1` against the
covenant's `warda:grant:v1`.

## Reading a listing

```js
import { fetchListing, search } from "@warda_protocol/registry";

const v = await fetchListing("https://their-domain/.well-known/warda-service.json");
if (v.ok) console.log(v.manifest.pricing);
else console.log(v.failures);   // HOST_MISMATCH, SIGNATURE_DOES_NOT_VERIFY, …

search(listings, { capability: "weather.current", maxPrice: "0.05" });
```

Failures come back as a list rather than one code, so an operator fixing a
listing sees every problem at once instead of discovering the second after
fixing the first. A refused verdict still carries the `digest` the signature
should have been made over, so you can check your signing code against it rather
than guess.

`matches()` is the only implementation of what "matches" means — the HTTP
service answers with it, the MCP tool calls that service, and `/network` renders
it. Three copies of that would be the sixth time extracted-then-copied has cost
this project something.
