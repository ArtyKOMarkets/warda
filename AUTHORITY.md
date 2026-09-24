# Bounded agent authority — a description format

**Status: draft, v0.1. Warda is the reference implementation and not the
subject.** This describes what an autonomous agent is economically permitted
to do, and — for every clause — *who guarantees it*. It is deliberately
indifferent to how payment happens, to what settles it, and to who wrote it.

## Why this exists

One implementation is a product. Two is a standard. Everything below is
written so a second implementation — on another settlement system, or with no
settlement system at all — can satisfy it without asking us anything.

It is not a payment protocol. [x402](https://github.com/x402-foundation/x402) already
describes how a machine pays for an HTTP request. This describes the authority
the paying agent holds, which x402 has no opinion about and needs none.

It is not a chain specification. Warda enforces every clause here with a Kaspa
covenant; a custodian could offer the same clauses backed by a signed promise.
**Those are not the same product, and the whole point of this document is that
the difference is legible in the artefact rather than in the marketing.**

## 1. The zone word

Every clause carries exactly one of three words, naming what stands behind it.

| word | what it means | who has to be trusted |
|---|---|---|
| `enforced` | the settlement network refused every alternative | nobody — there is no transaction |
| `attested` | a named party signed a statement and can be held to it | that party |
| `assumed` | nobody proved it; it is a belief about the world | everyone |

Three rules, and they are the specification's spine:

1. **A clause with no zone word is `assumed`.** Silence is not a guarantee.
2. **There is no fourth word.** Anything that sounds like a fourth — "verified",
   "secured", "guaranteed" — is one of these three wearing a better coat, and
   implementations MUST NOT introduce one.
3. **`enforced` names the enforcer.** "Enforced by Kaspa consensus" is a claim
   a reader can check. "Enforced" alone is `attested` by whoever said it.

An implementation MAY be entirely `attested`. It MUST say so.

## 2. The manifest

A bounded authority is described by a document with these fields. Names are
given in `snake_case`; an implementation MAY use another convention if it maps
one-to-one.

### Authority — fixed for the life of the grant

| field | type | meaning |
|---|---|---|
| `agent` | key | who may spend. The holder of the corresponding secret is the agent. |
| `principal` | key | who funded it, and who unspent value returns to |
| `revocation` | key | who may end it early, and who receives nothing |
| `budget` | integer, base units | the most that may ever be spent in total |
| `max_per_spend` | integer, base units | the most that may be spent in one payment |
| `epoch_limit` | integer, base units | the most that may be spent in one epoch |
| `epoch_length` | integer | how long an epoch is, **in the settlement system's own clock** |
| `recipients_root` | digest | commits to the set of payees this authority may ever pay |
| `not_before` | integer | the first moment it may spend, on that same clock |
| `expires_at` | integer | the last |
| `delegation_depth` | integer | how many further generations it may create. `0` forbids delegation. |

### Accounting — moves as it spends

| field | type | meaning |
|---|---|---|
| `spent_total` | integer | spent so far, against `budget` |
| `reserved` | integer | committed to children and not reclaimable |
| `epoch_index` | integer | which epoch the accounting refers to |
| `epoch_spent` | integer | spent within it |

### Why `epoch_length` is not seconds

It is a count on the settlement system's own clock — block height, DAA score,
sequence number. An authority denominated in wall-clock seconds requires a
clock the enforcer can read, and a network that could read one would not need
this document. Warda's epochs are 1,000 blocks; at ten blocks a second that is
about 100 seconds, and *about* is the honest word.

## 3. Attenuation

An authority MAY create a child authority. The single invariant:

> **No operation may widen any axis. Every field either narrows or stays
> equal.**

| axis | the child's value |
|---|---|
| `budget` | ≤ the parent's uncommitted budget (`budget − spent_total − reserved`) |
| `max_per_spend` | ≤ the parent's |
| `epoch_limit` | ≤ the parent's |
| `not_before` | ≥ the parent's |
| `expires_at` | ≤ the parent's |
| `delegation_depth` | < the parent's |
| `recipients_root` | the parent's set, or a subset of it |
| accounting | all zero |

A field an implementation forgets to narrow is one the child **shares** —
which is the safe direction to be wrong in, and implementations SHOULD choose
it deliberately rather than by accident.

**Two properties the naive reading gets wrong**, both worth stating because
both surprised us:

- **A rate limit does not bind a subtree.** A parent limited to 5 per epoch
  may create ten children limited to 5 each; the tree spends 50. Only `budget`
  bounds the whole tree. An implementation MUST NOT describe `epoch_limit` as
  a limit on anything but one authority.
- **Reserve need not be reclaimable.** If reclaiming a child does not restore
  the parent's capacity to delegate, the parent can delegate its budget once
  across its entire life. Implementations MUST state which they do.

## 4. What an implementation must be able to answer

Three questions, because they are the ones an agent actually asks:

1. **What may I spend right now?** The binding constraint, not the budget:
   `min(budget − spent_total − reserved, epoch_limit − epoch_spent, max_per_spend)`,
   and zero outside `[not_before, expires_at]`.
2. **Would this payment be accepted, and if not, which clause stopped it?**
   By name. "Refused" is not an answer an agent can act on.
3. **Who guarantees that answer?** The zone word of the clause that decided.

An implementation that can answer 1 and 2 but not 3 is not conformant. The
third question is the entire reason this document exists.

## 5. What this format deliberately does not describe

- **How a payment is made.** That is x402's job, or an invoice, or anything.
- **How an authority is created.** Chain-specific, and see §6.
- **Conditional payment** — "pay on an accepted result". No settlement network
  can check whether work was good. Such a clause is `attested` at best, by
  whoever judges, and an implementation offering it MUST say who that is.
- **Identity, reputation, pricing, discovery.** Out of scope, all of them.

## 6. The reference implementation, including where it is weakest

Warda enforces every clause in §2 and §3 with a Kaspa covenant. The bytecode
is run against `TxScriptEngine` — the same script engine a node validates with
— over 129 cases, published in full at
[wardaprotocol.com/audit](https://wardaprotocol.com/audit) including what it
does not cover. How the covenant does it is at
[wardaprotocol.com/protocol](https://wardaprotocol.com/protocol); the
clause-by-clause enforcement argument, and where it is weak, is
[GUARANTEES.md](https://github.com/ArtyKOMarkets/warda/blob/main/GUARANTEES.md);
what is and is not proven is
[wardaprotocol.com/proof](https://wardaprotocol.com/proof).

| clause | Warda's zone |
|---|---|
| budget, per-spend cap, epoch limit, window, delegation depth | `enforced` — Kaspa consensus |
| payee, for the authority's own next hop | `enforced` |
| payee, beyond that hop | `assumed` — a covenant constrains the hop after it and nothing further |
| attenuation on delegation | `enforced` |
| **the creation of the authority itself** | **`assumed`** |

**That last row is the honest one and we would rather write it than be asked.**
An authority is created *from* an ordinary wallet. The key that funds it can
spend everything it holds, and no covenant covers that step — not ours and not
anyone's. Warda's unattended issuer therefore funds from a key holding a
deliberate float, and refuses to run against the main funder. The bound on
that one step is a balance, not a network.

An implementation reading this table should be able to produce its own. If
every row says `attested`, that is a legitimate product and a different one —
and the comparison will have been made by the format rather than by either of
us.

## 7. Conformance

An implementation is **conformant** if it:

1. publishes a manifest with the §2 fields it supports, and omits rather than
   invents the ones it does not;
2. publishes a zone word for every clause, using only the three words;
3. never widens an axis on delegation, if it supports delegation at all;
4. answers the three questions in §4, naming the clause and its zone word.

There is no certification, no registry and no mark. Conformance is a property
of a document somebody can read, which is the only kind that survives its
author losing interest.

## Contributing

This is v0.1 and it has one implementation, which is not enough to call it
anything. If you are building bounded authority on another settlement system
and something here does not fit, that is a finding about this document rather
than about your design:
[github.com/ArtyKOMarkets/warda](https://github.com/ArtyKOMarkets/warda).

**To check any of it rather than take it:** the covenant source is
[warda_grant.sil](https://github.com/ArtyKOMarkets/warda/blob/main/covenant/warda_grant.sil),
the audit that runs it against a Kaspa node's own script engine is
[covenant/harness](https://github.com/ArtyKOMarkets/warda/tree/main/covenant/harness),
and a live grant with its agent key published — so the limits can be attacked
rather than believed — is at
[wardaprotocol.com/attack](https://wardaprotocol.com/attack).
