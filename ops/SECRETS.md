# Secrets: what we hold, and what rotating one costs

The list lives in `ops/secrets.json`, by path and by role and never by value.
This file is the policy, so the two cannot drift into disagreeing about which
secrets exist. `ops/check-secret-age.mjs` reads the JSON and runs in CI.

## The one that is not a policy question

A secret that stops being ignored by git is not overdue, it is public. One
`git add -A` on a day somebody renamed a directory and a key is in the history
forever, with no way to take it back.

That is the check that fails the build. The rotation clock does not — a clock
that breaks CI gets its interval raised rather than its secret rotated, which
is worse than having no clock at all.

## Three kinds of secret, and only one of them rotates

**Credentials at somebody else's service** — the Telegram bot token, the X
bearer, the GitHub token, the Neon password. These rotate the ordinary way:
reissue at the provider, paste the new value in, restart whatever reads it.
Ninety days, and immediately when exposed.

**Shared secrets we mint ourselves** — `QUOTE_SECRET` in the Listener and the
auditor, the tick and admin secrets in the runner. These rotate, but not
casually: `growth/RUNBOOK.md` and `covenant/auditor-service/README.md` both say
`QUOTE_SECRET` has to be stable for the life of the process, because
regenerating it invalidates every quote still outstanding. Rotate at a restart
with none in flight.

**Keys that are committed to on chain** — the funder, the principal, the
revocation key. **These do not rotate.** A grant hashes its keys into its
address, so the keys a grant names are the keys it names for its whole life.
Writing a new file makes a new key; it does not move the old one's authority
anywhere. The only remedies are revoke-and-reissue or letting the term run out,
and `ops/PRINCIPAL.md` is about getting the next one in the right place rather
than fixing the last one.

`rotateDays: null` in the JSON means the third kind. It is not "no policy", it
is "rotation is not the operation you want here".

The per-agent keys are deliberately not listed one by one. Each is bounded by
the covenant — it spends inside a grant's limits and can do nothing else, which
is the entire claim this protocol makes — and `/attack` publishes one on
purpose. They are the keys a leak is meant to be survivable for.

## Known compromises

Three secrets are recorded as exposed, and they stay overdue until
`rotatedAt` is set in `ops/secrets.json` by hand.

**Not until the file's mtime moves.** `runner/.env` was rewritten on 22
September for a fee-payee change, three days after its database password went
into a chat window. A check keyed on mtime would have called that rotated and
gone quiet — which is the shape of most security checks that pass. Setting
`rotatedAt` is a person saying they did the thing, and nothing else clears it.

| secret | exposed | what it costs |
|---|---|---|
| `ops/alerts.env` | 23 Sep 2026 | Telegram bot token. Somebody else can post as the alerts bot. |
| `growth/listener.env` | 23 Sep 2026 | X bearer, **billed to our card** — a leak is somebody else's usage on our account. |
| `runner/.env` | 19 Sep 2026 | The Neon password, pasted into a conversation. Read and write on the runner's database. |

The first two were leaked by a shell idiom meant to check whether a variable
was set:

    echo "${TOKEN:+present}${TOKEN:-MISSING}"

which prints the value when the variable IS set. It reads as a presence test
and is a disclosure. The idiom that does what it looks like it does:

    [ -n "$TOKEN" ] && echo present || echo MISSING

## Rotating each one

**Telegram** — BotFather, `/revoke` then `/token`. Update `ops/alerts.env`.
Nothing on chain depends on it; alerts go quiet until the file is updated.

**X** — the developer portal, regenerate the bearer. Update
`growth/listener.env`. Leave `QUOTE_SECRET` in that file alone unless the
Listener is stopped and no quotes are outstanding.

**Neon** — the Neon console, reset the role password, update `DATABASE_URL` in
`runner/.env` and in the runner's deployment environment. The runner is down
between the reset and the redeploy.

**GitHub** — regenerate, and check the scopes while you are there. A token
minted for one script tends to outlive the script.

Then set `rotatedAt` in `ops/secrets.json` to the day you did it, and commit
that with the rest.

## What this does not cover

Where the secrets are on disk is a machine, and that machine is
`ops/README.md`'s laptop. Rotation policy does not help a credential that is
sitting on something with no disk encryption and no screen lock; it is on the
before-mainnet list separately.
