# The Warda plugin for KeeperHub

Three read-only actions that let a KeeperHub workflow ask what an autonomous
agent is allowed to spend on Kaspa, before it spends it.

| action | question |
|---|---|
| `check-authority` | Would this payment be refused, and which rule refuses it? |
| `verify-grant` | Does the chain agree with the terms this manifest claims? |
| `locate-grant` | Where did the grant go, when a stored manifest is stale? |

## Why this is not what KeeperHub already has

KeeperHub's own documentation describes an agentic wallet that intercepts a
402, "evaluate[s] the price against your safety thresholds, signs the payment,
and retries". That threshold is enforced by the process holding the key. It
holds right up until the agent is the thing that is wrong — a prompt injection,
a bad plan, a loop — because the same process that checks the threshold is the
one deciding to pay.

A Warda grant is a covenant-bound coin. Its per-payment cap, lifetime budget,
epoch allowance and payee allowlist are conditions in the script that spends
it, so the network refuses a transaction that breaks them. Nothing the agent
does, and nothing this plugin does, changes that.

Which is why `allowed` in these actions is never a permission. Every response
carries an `enforcement` field restating it, and the steps surface that field
rather than dropping it.

## It needs a verification service

The actions call a Warda verification service, configured per connection. It
reads a Kaspa node and re-derives what a grant's covenant would decide; it
holds no keys, signs nothing and broadcasts nothing.

There is no shared instance and there should not be one: the answer depends on
which node was read, which is why every response names it and the plugin
returns that as `readFrom`. Run your own —
<https://github.com/ArtyKOMarkets/warda/tree/main/verify>.

## Applying this to a KeeperHub checkout

```bash
git apply /path/to/warda-keeperhub-plugin.patch
pnpm discover-plugins
pnpm test:unit tests/unit/warda-check-authority.test.ts
```

The patch touches four things besides the new plugin directory:

- `plugins/plugin-allowlist.json` — adds `warda`, without which
  `discover-plugins` skips it
- `plugins/index.ts` — regenerated
- `lib/types/integration.ts` — adds `"warda"` to the union, as its header
  instructs
- `tests/unit/warda-check-authority.test.ts` — 10 tests

If the patch does not apply cleanly against a newer upstream, the plugin
directory here is self-contained: copy `plugins/warda/` in, add `warda` to the
allowlist, and re-run `pnpm discover-plugins`.

## What was checked against their tree

Verified in a clone of `KeeperHub/keeperhub` at `e089f84`:

- `npx tsc --noEmit` reports no errors in any of these files. Ten pre-existing
  errors elsewhere in the repo are untouched.
- The "Forbid raw network egress in plugins" CI check passes: every request
  goes through `safeFetch`, and `plugins/*/test.ts` is excluded by that check
  by design.
- `pnpm discover-plugins` registers all three actions and generates their
  codegen templates.
- `npx vitest run tests/unit/warda-check-authority.test.ts` — 10 passed.

Conventions followed from `plugins/CLAUDE.md`: `"use step"` inside the step
function, `runPluginStep` wrapping, no exported helpers from step files, shared
logic in `warda-core.ts` with no directive, module-level regex constants, and
`assertUrlIsPublic` before `safeFetch` because the host is user-configurable —
mirroring `plugins/blockscout/steps/blockscout-core.ts`.
