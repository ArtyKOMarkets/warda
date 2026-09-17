/**
 * Does a grant pay this service directly, or through a relay hop?
 *
 * This is the one thing a buyer most wants to know and the one thing an
 * operator should not be allowed to assert about themselves, so it is
 * **derived from the payment protocol** rather than published as a claim. The
 * same discipline as `verdict()` in the router: a fact that comes out of the
 * shape cannot be overstated by whoever benefits from overstating it.
 *
 * It also needs no wire change. `payment.protocol` is already in the signed
 * manifest, so every listing that exists today already carries its answer and
 * nothing has to be re-signed.
 */

import type { ServiceManifest } from "./manifest.ts";

export type SettlementTier =
  /** The covenant spend IS the payment. The payee is in `recipientsRoot`, so
   *  the chain refused every transaction that paid anybody else. */
  | "settled"
  /** A relay hop stands between the grant and the seller. Budget, cap, epoch,
   *  window and depth all still bind; the PAYEE does not. */
  | "relayed"
  /** Not payable from a grant at all, or a protocol this version has never
   *  heard of. Absence of an answer, stated rather than guessed. */
  | "unknown";

/** The protocol string for a payment that is nothing but a covenant spend. */
export const DIRECT_PROTOCOL = "warda";

/**
 * The protocols that CANNOT take a covenant spend, and therefore force a relay.
 *
 * kaspa-x402's `exact` scheme requires a version-0 transaction whose every
 * input is a bare P2PK unlocked by a single 66-byte Schnorr push, and whose
 * outputs carry no covenant. A Warda spend is none of those things under any
 * version, because output 0 IS the successor grant — see
 * `x402/INTEROP-KASPA-X402.md` and `x402/RELAY.md`.
 *
 * "x402" alone is NOT on this list, and the first version of this file had it
 * there. That was wrong, and agent #006 proved it: on 17 September it paid
 * `warda-demo-api.vercel.app/fact` with no relay at all, in transaction
 * c8e2b9f990351fb0863303c2089bf37bf11f447984872395a7a6c5be48f489ac — a
 * covenant spend straight to an allowlisted payee. That vendor answers HTTP
 * 402 and accepts a covenant payment, so the family name says nothing about
 * whether a relay is needed; only the specific scheme does.
 *
 * Reporting a settled listing as relayed understates the guarantee, which is
 * the safe direction to be wrong in and still wrong: it tells a buyer the
 * chain did not constrain the payee when it did.
 */
const RELAY_ONLY_PROTOCOLS = new Set(["kaspa-x402", "kaspa-x402-v2"]);

export function settlementTier(m: ServiceManifest): SettlementTier {
  /* A service that does not take a grant at all has no tier to report. */
  if (m.payment?.warda !== true) return "unknown";

  const protocol = String(m.payment.protocol ?? "").toLowerCase();
  if (!protocol) return "unknown";
  if (RELAY_ONLY_PROTOCOLS.has(protocol)) return "relayed";

  /* Everything else that declares `warda: true` accepts the covenant spend
     itself, so its payee is in `recipientsRoot` and the chain refused every
     transaction that paid anybody else. */
  return "settled";
}

/** What a reader should be told, in the vocabulary `provider` already uses. */
export function authorisedToPayMe(m: ServiceManifest): "yes" | "unknown" {
  return settlementTier(m) === "settled" ? "yes" : "unknown";
}

/** One line a page or an agent can show without having to know the rules. */
export function explainSettlement(m: ServiceManifest): string {
  switch (settlementTier(m)) {
    case "settled":
      return (
        "Paid by the covenant spend itself, so this payee is in the grant's allowlist and " +
        "the chain refused every transaction that paid anyone else."
      );
    case "relayed":
      return (
        "Paid through a relay hop, which x402 requires. The grant's budget, per-payment cap, " +
        "epoch limit, window and delegation depth all still bind; who was ultimately paid does not."
      );
    default:
      return "Not payable from a grant, or a payment protocol this registry does not know.";
  }
}
