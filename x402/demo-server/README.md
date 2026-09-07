# Warda demo vendor

A real HTTP 402 endpoint an agent can be pointed at.

    GET /weather     0.05 KAS   → the demo vendor
    GET /fact        0.03 KAS   → the demo vendor
    GET /inference   0.1  KAS   → the demo vendor
    GET /digest      0.04 KAS   → agent #001

Every price is at or below the published demo grant's per-payment cap, so the
key on wardaprotocol.com/attack can buy from here — and above roughly 0.02 KAS,
below which Kaspa's storage-mass rule refuses the payment outright. `/fact` was
listed here at 0.01 for a while and priced at 0.03 in the code; it is 0.03, and
0.01 is not payable by anyone.

## Two sellers

`/digest` pays a different address from the other three: agent #001's, not the
demo vendor's. That is why `payTo` belongs to the endpoint rather than to the
server. A Warda grant commits to WHO it may pay, so two endpoints on one host
paying two addresses are two different markets to a buyer, and a grant
allowlisted for one cannot buy from the other. Collapsing them onto a single
vendor address would have made that distinction invisible in the demo built to
show it.

`/digest` returns what agent #001 publishes, fetched live. The same digest is
free at wardaprotocol.com/agent-001.json, and the 200 response says so: what is
being demonstrated is a payment, not information scarcity.

## It verifies, it does not trust

A payment proof arrives in `X-PAYMENT`. This looks for a UTXO at its own
address, created by the claimed transaction, for exactly the quoted amount. A
vendor that believed the header would accept a fabricated transaction id, and
would prove nothing.

Until the payment is visible it answers 402 again — which is what makes a
correct client re-present the same proof instead of paying twice.

## Configuration

    WARDA_DEMO_VENDOR      the demo vendor's kaspa address
    WARDA_AGENT_001_PAYEE  agent #001's address — the P2PK address of the agent
                           key named in x402/demo/kaspa-x402-grant.json
    WARDA_RPC_JSON         a testnet-10 node's JSON wRPC url
    WARDA_AGENT_001_URL    optional; where /digest reads #001's published state
                           (default https://wardaprotocol.com/agent-001.json)
    WARDA_RESOLVER         optional but strongly recommended; a Kaspa Resolver
                           to fall back to when the node above is unreachable
    WARDA_QUOTE_SECRET     optional; signs quotes so no server state is needed

An endpoint whose payee variable is unset answers 503 on its own route rather
than taking the whole server down, so a misconfigured second seller cannot cost
the first one its traffic.

## Which node answers, and why there are two

`WARDA_RPC_JSON` has to name the node **as Vercel reaches it**, which means a
public hostname — the opposite of everything in `ops/`, which runs beside the
node and must use localhost.

It was pointed at a Cloudflare *quick* tunnel, and those are handed a new random
hostname every time they restart. It restarted. Every paid request after that
returned a 500, including one that had already been paid for, and nothing
anywhere said so. That is the second time in this repository a public service
went dark because it reached a laptop through a hostname that does not survive a
reboot; the first cost the hourly readings two days.

So a public endpoint gets a hostname that is stable by construction — a *named*
cloudflared tunnel (see `ops/cloudflared-config.yml`) or a Tailscale Funnel, not
a quick tunnel — and, separately, this vendor no longer depends on that being
true. When the configured node cannot be reached and `WARDA_RESOLVER` is set, it
falls back to a resolver-found public node.

That fallback is a real weakening and is reported rather than hidden: this
vendor's entire security is "the money is visibly in the UTXO set", and a node it
does not control is what answers that. A dishonest one could report a payment
that does not exist. The risk is the vendor's and not the buyer's, the amounts
are testnet, and `readFrom` in every response says which node was believed.

## Why quotes are signed rather than remembered

The original held one nonce in a module variable. That is correct for a single
caller on localhost and wrong the moment two agents overlap: the second quote
overwrites the first, and the first agent's good payment is refused for a nonce
mismatch it did not cause, after it has already spent the money.
