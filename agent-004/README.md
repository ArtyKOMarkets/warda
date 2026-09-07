# Agent #004 — the sub-agent

Every other grant on this site was issued by a person signing once. This one was
not. Agent #003 **subdivided its own grant** and handed a bounded piece of its
authority to a sub-agent holding a different key — no principal online, no new
funding, and nothing the parent could not already do.

## Attenuation, in one direction only

The covenant refuses a delegation that widens anything. Every limit may shrink
and none may grow, and the child does not get an allowlist of its own: it
commits to a **node of its parent's recipients tree** and proves the path from
that node to the parent's root on every spend.

That last one is the attenuation with teeth. A shorter window ends by itself and
a smaller budget bounds the damage, but neither stops a sub-agent paying someone
its parent would never have paid. Narrowing the payee list does, and the
covenant checks the witness rather than trusting the claim.

#003 may pay agent #001 or the Warda demo vendor. #004 may pay agent #001. The
refusal on its page is not written — it is produced by running the same function
the payer runs before it builds a transaction.

## It settles back

Delegation was one-way in practice until `build-settlement.ts` existed: a parent
could subdivide itself and then had no way to recover the reserve except by
letting the child expire into the **principal's** hands — which returns the
money to the human, not to the agent that was mid-task.

Settlement is one transaction with two inputs and two keys. The parent's input
is signed by the parent's *agent*, because it is the agent's budget being
restored; the child's by its *revocation* key, because collapsing a grant is a
revocation of it and a sub-agent must not be able to end its own grant on terms
it chooses.

## Running it

```sh
source ../ops/node.env
WARDA_SK=$(cat ../covenant/deploy/agent-003.key) \
node --experimental-strip-types ../sdk/tools/build-delegation.ts \
  ../x402/demo/agent-003-grant.json \
  --child-key "$(cat ../covenant/deploy/agent-004.key.pub)" \
  --recipients ../x402/demo/agent-003-recipients.txt \
  --child-recipients ../x402/demo/agent-004-recipients.txt \
  --submit
```

`WARDA_SK` is the **parent's** agent key: only an agent can delegate its own
grant. The child key is supplied rather than derived, which is what a deployment
would do — in production a sub-agent generates its own and hands over the public
half, and nobody else ever holds the secret.
