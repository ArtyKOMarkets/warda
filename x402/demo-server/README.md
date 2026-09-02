# Warda demo vendor

A real HTTP 402 endpoint an agent can be pointed at.

    GET /weather     0.05 KAS
    GET /fact        0.01 KAS
    GET /inference   0.1 KAS

Every price is at or below the published demo grant's per-payment cap, so the
key on wardaprotocol.com/attack can buy from here.

## It verifies, it does not trust

A payment proof arrives in `X-PAYMENT`. This looks for a UTXO at its own
address, created by the claimed transaction, for exactly the quoted amount. A
vendor that believed the header would accept a fabricated transaction id, and
would prove nothing.

Until the payment is visible it answers 402 again — which is what makes a
correct client re-present the same proof instead of paying twice.

## Configuration

    WARDA_DEMO_VENDOR   the vendor's kaspa address
    WARDA_RPC_JSON      a testnet-10 node's JSON wRPC url
    WARDA_QUOTE_SECRET  optional; signs quotes so no server state is needed

## Why quotes are signed rather than remembered

The original held one nonce in a module variable. That is correct for a single
caller on localhost and wrong the moment two agents overlap: the second quote
overwrites the first, and the first agent's good payment is refused for a nonce
mismatch it did not cause, after it has already spent the money.
