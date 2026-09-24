/**
 * Getting the covenant to the thing that produces the report.
 *
 * `priced` does not hand its `deliver` callback the request. It calls it with
 * `{ txid }` — see vendor/src/priced.ts, `deliver: () => deliver({ txid })` —
 * so a handler written as `async (req) => analyse(req.__source)` receives an
 * object with no `__source` on it and compiles `undefined`.
 *
 * That is what happened on 24 September 2026, on the first paid request this
 * service ever took. The buyer's 0.04 KAS settled, `settle` recorded the txid
 * as spent BEFORE calling deliver — deliberately, so a crash cannot leave a
 * replayable payment — and then delivery threw. The buyer got a 502 saying
 * "payment settled but the goods could not be produced", and the payment it
 * had already made could not be presented again, because by then it was in
 * spent.log. The money moved and nothing came back.
 *
 * The free `/v1/scan` path never had this bug: it calls `analyse(source)`
 * directly. So the paid path was the only one that could break, and it was the
 * only one no test and no manual `curl` had ever exercised end to end.
 *
 * The request body therefore travels in an AsyncLocalStorage scope rather than
 * on an object `deliver` never sees. A module-level variable would also have
 * "worked" and would cross two concurrent requests' covenants the first time
 * two agents bought at once, which is a worse bug than this one and harder to
 * see.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();

/** Run `fn` with this request's covenant source in scope. */
export const withSource = (source, fn) => scope.run(source, fn);

/**
 * The `deliver` callback `priced` will call once a payment has verified.
 *
 * It takes no useful argument on purpose: whatever `priced` passes is the
 * payment's metadata, not the request, and reading the covenant off it is the
 * mistake this module is named after.
 */
export function makeDeliver(analyse, report, now = () => new Date()) {
  return async function deliver() {
    const source = scope.getStore();
    if (typeof source !== "string" || !source.trim()) {
      /* Thrown rather than compiled. `settle` turns this into a 502 that says
         the payment settled and the goods did not — which is the truth, and is
         recoverable by an operator who reads it. Compiling `undefined` instead
         produces a report about nothing and sells it. */
      throw new Error(
        "no covenant in scope for this delivery: deliver() ran outside withSource(). " +
        "The request body does not reach it through priced's callback argument.",
      );
    }
    const text = await analyse(source);
    return { html: report(text, now().toISOString().slice(0, 16).replace("T", " ") + " UTC") };
  };
}
