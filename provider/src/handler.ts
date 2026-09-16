/**
 * Three lines in a route handler.
 *
 * `verifyGrantProof` takes a template and an outpoint, which is the honest
 * signature and not the one anybody wants in a request handler. This holds the
 * template once and leaves exactly one thing to pass per request: the outpoint
 * the payment spends, which the caller's x402 verifier already parsed.
 *
 * Deliberately NOT middleware. Middleware would have to decide what happens
 * when a payment is not bounded — reject it, log it, price it differently — and
 * that is the provider's policy and not this package's. Every one of those
 * choices is defensible and none of them belongs in a library that cannot see
 * the business. This returns a verdict; the route decides.
 */
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };
import type { CovenantTemplate } from "@warda_protocol/kaspa";

import { verifyGrantProof, type HeaderBearing, type Verdict } from "./verify.ts";

export interface ProviderOptions {
  /**
   * The covenant version to read grants under. Defaults to the one this
   * package shipped with.
   *
   * A covenant upgrade changes the bytecode, so a grant issued under an older
   * one will not parse here — and that is reported as "not a Warda covenant"
   * rather than silently believed, because the alternative is reading terms out
   * of a script this does not understand.
   */
  template?: CovenantTemplate;
}

export interface Provider {
  /**
   * @param req    anything with headers — a Request, or `{ headers }`.
   * @param paymentInput the outpoint the payment you received spends. Required:
   *                     it is what binds the proof to your money. See verify.ts.
   */
  verify(req: HeaderBearing, paymentInput: { transactionId: string; index: number }): Verdict;
}

export function wardaProvider(options: ProviderOptions = {}): Provider {
  const template = options.template ?? (covenantTemplate as unknown as CovenantTemplate);
  return {
    verify(req, paymentInput) {
      return verifyGrantProof(req, template, { paymentInput });
    },
  };
}
