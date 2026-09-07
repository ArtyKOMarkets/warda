# Draft: interop report for kaspahttp402/kaspa-x402

Send as a GitHub issue on their repo, or wherever they prefer. Facts only, no
ask beyond the one question, and nothing about Warda that they need to care
about to answer it.

---

**Title:** `exact` cannot carry a covenant-bound payment: the id commits to a field `kaspa-sdk-safe-json-v2.0.0` has no slot for

I've been paying `demo.kaspa-x402.org/exact` from a Kaspa covenant using your
published packages. Six attempts, all `402 {"error":"invalid_transaction_state"}`,
four of them accepted on chain paying your quoted address the quoted amount. It
reproduces identically against a second, separately hosted vendor —
`kaspa-402-summarize.kaspadev.workers.dev/exact`, listed on kaspa-402.org — with
a different grant, a different payee and a different amount.

I think I can now say why, and I don't think it's a bug in your code or mine.

**A version-1 transaction id commits to each output's covenant binding.** The
id preimage writes, per output, a presence flag and — when set — the
authorizing input index and the covenant id.

**`kaspa-sdk-safe-json-v2.0.0` has no field for it.** Its outputs are
`{ value, scriptPublicKey }`. The encoding predates covenants.

**And your payload schema forbids the client from supplying the id:** for
`type: "exact-transaction"`, `"not": { "required": ["transactionId"] }`.

Those three together are the problem. The verifier must obtain the transaction
id, the only deterministic way to obtain it is to derive it from `transaction`,
and for a covenant-bound transaction that derivation cannot reach the id the
network assigned — because the bytes it commits to were dropped at encoding
time. Whatever the verifier does next, it is looking for a transaction that
does not exist.

Reproducible in isolation, against a spend recorded on testnet-10:

```
recorded txid       7dbc957fbf87ca26bc9b83ec81849f4f713c255fa6d39f44a53301813ceb86ba
id with covenant    7dbc957fbf87ca26bc9b83ec81849f4f713c255fa6d39f44a53301813ceb86ba
id without covenant 747315c516067e4b1805c9ae42909194117a90f4e671c2dc8ed25621667d5465
safe-JSON output    { value, scriptPublicKey }
```

That also explains what I could not explain before: why the refusal never
moved. Broadcasting first, waiting for `accepted`, a fresh `requestHash`,
omitting `payerAddress`, declaring the successor as `payerAddress` — none of
those change the encoded transaction, so none of them could change the derived
id.

**The one way it could still work**, which I mention because it would make me
wrong: a verifier that finds the payment by searching the chain for an output
matching `payToScriptPublicKey` and `amount`, rather than by deriving an id.
Evidently that is not what happens, but you would know.

**Two fixes, and the first is small.**

Allow `transactionId` in the `exact-transaction` payload and confirm it against
the chain instead of deriving it. That is not trusting the client: the id is
checked against a transaction that either exists, pays your address the right
amount, and has the finality you require, or does not. Deriving it buys nothing
that the chain lookup does not already establish, and it costs the scheme every
payer whose transaction the encoding cannot represent — today covenants, and
anything else the SDK's JSON gains a field for later.

Or extend the encoding so outputs can carry their binding. That is the more
complete fix and it is upstream of you.

I'd rather cite your answer than guess in public. Happy to test any change
against a real covenant payer on demand; everything above is on testnet-10 and
checkable, and the id experiment runs offline from the recorded spend.
