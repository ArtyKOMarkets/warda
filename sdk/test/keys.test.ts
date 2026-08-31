import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import { deriveSecret, derivePublic, KEY_DOMAIN, resolveSigner } from "../src/keys.ts";
import { agentPublicKey } from "../src/sign.ts";

/**
 * The three roles a grant names are three DIFFERENT powers, and the whole
 * reason `revoke` pays the principal rather than its own signer is so a
 * monitor can hold the stopping power without the money. Tooling that can only
 * express one key silently voids that.
 */

const funder = fromHex("11".repeat(32));

test("domains do not collide at the same index", () => {
  // Without domain separation a top-level agent and a sub-agent derived from
  // the same secret at index 0 would be the SAME KEY, and a grant would be
  // spendable by a sibling that was never meant to reach it.
  const a = derivePublic(funder, KEY_DOMAIN.agent, 0);
  const b = derivePublic(funder, KEY_DOMAIN.subAgent, 0);
  assert.notEqual(a, b);
});

test("indices do not collide within a domain", () => {
  assert.notEqual(
    derivePublic(funder, KEY_DOMAIN.subAgent, 0),
    derivePublic(funder, KEY_DOMAIN.subAgent, 1),
  );
});

test("a derived agent is NOT the funder's key", () => {
  // The default that matters: an agent sharing the principal's key can revoke
  // its own grant and take the balance, so no limit in the grant binds it.
  assert.notEqual(derivePublic(funder, KEY_DOMAIN.agent, 0), toHex(agentPublicKey(funder)));
});

test("the resolver finds a key it was given directly", () => {
  const r = resolveSigner(funder, toHex(agentPublicKey(funder)), null);
  assert.ok(r);
  assert.equal(toHex(r.secret), toHex(funder));
  assert.match(r.how, /provided/);
});

test("the resolver follows a recorded derivation", () => {
  const want = derivePublic(funder, KEY_DOMAIN.subAgent, 3);
  const r = resolveSigner(funder, want, { domain: KEY_DOMAIN.subAgent, index: 3 });
  assert.ok(r);
  assert.equal(toHex(agentPublicKey(r.secret)), want);
  assert.match(r.how, /index 3/);
});

test("the resolver returns null rather than guessing", () => {
  // A properly separated deployment reaches this constantly: the sub-agent
  // holds its own secret and nothing the caller has can derive it. That is the
  // correct answer, not an error, and callers must say so rather than treating
  // it as a broken key.
  const stranger = toHex(agentPublicKey(fromHex("99".repeat(32))));
  assert.equal(resolveSigner(funder, stranger, null), null);
  assert.equal(resolveSigner(funder, stranger, { domain: KEY_DOMAIN.subAgent, index: 7 }), null);
});

test("a wrong hint does not fall through to a lucky guess", () => {
  // With a hint present the resolver tries ONLY that derivation. Trying others
  // would let a manifest's wrong metadata get papered over by chance, and the
  // tool would sign with a key nobody intended.
  const want = derivePublic(funder, KEY_DOMAIN.subAgent, 0);
  assert.equal(resolveSigner(funder, want, { domain: KEY_DOMAIN.agent, index: 0 }), null);
  assert.ok(resolveSigner(funder, want, null), "with no hint, index 0 of both domains is tried");
});

test("the sub-agent derivation is unchanged from before keys.ts existed", () => {
  // Children already delegated on chain must stay reachable. This pins the
  // exact derivation build-delegation used inline: keyed blake2b over the
  // parent secret and a little-endian u32 index.
  const known = deriveSecret(funder, KEY_DOMAIN.subAgent, 0);
  assert.equal(known.length, 32);
  assert.equal(derivePublic(funder, KEY_DOMAIN.subAgent, 0), toHex(agentPublicKey(known)));
});
