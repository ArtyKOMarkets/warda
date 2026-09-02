import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The hosted deployment carries its own copy of the covenant template.
 *
 * It has to: `loadTemplate` resolves the file through the SDK's exports map at
 * RUNTIME, and a bundler tracing this function's imports never sees that and
 * does not upload it. The deployed server answered tools/list perfectly and
 * failed the moment anyone asked it to build a transaction.
 *
 * A copy solves that and introduces the failure this test exists for. A stale
 * template does not throw: the bytecode differs, so every address derived from
 * it differs, and the server reports healthy grants as missing — while looking
 * entirely well from the outside.
 */
test("deploy/covenant-template.json matches the SDK's", () => {
  const deployed = readFileSync(new URL("../deploy/covenant-template.json", import.meta.url), "utf8");
  const source = readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8");
  assert.equal(
    JSON.parse(deployed).baselineHex,
    JSON.parse(source).baselineHex,
    "the deployed covenant template has drifted from sdk/covenant-template.json — every " +
      "address the hosted server derives would be wrong, and wrong in a way that looks like " +
      "a missing grant rather than a bug",
  );
  assert.equal(deployed, source, "deploy/covenant-template.json is not a byte-for-byte copy");
});
