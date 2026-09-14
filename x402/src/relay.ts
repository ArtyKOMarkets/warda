/**
 * The second transaction — the one x402 `exact` will actually accept.
 *
 * `INTEROP-KASPA-X402.md` has the finding and `RELAY.md` has the design. In
 * one paragraph: their verifier requires the payer's input to be a bare P2PK
 * unlocked by a single 66-byte Schnorr push, and no output to carry a
 * covenant. A grant spend is neither, under any version, and no redeem script
 * gets through — they read the public key out of a P2PK script or throw. So a
 * bounded payer reaches such a vendor in two transactions, and this builds the
 * second one.
 *
 * What the covenant still enforces: budget, per-payment cap, epoch limit,
 * window, delegation depth. What it no longer enforces, for this hop: the
 * allowlist. That is the price, it is stated at the point of purchase, and a
 * grant created without `--relay` cannot do this at all.
 *
 * ## Nothing here recomputes their rules for them
 *
 * The id, the digest and the storage mass all come from
 * `@warda_protocol/kaspa`, which implements them independently and is pinned
 * against `@kaspa-x402/covenant` in its own tests. This module only arranges
 * the result into the JSON their parser reads. That split is deliberate: the
 * consensus arithmetic is Kaspa's and belongs in the SDK, and the shape of one
 * protocol's payload belongs beside that protocol.
 */

import {
  decodeAddress,
  ordinaryPaymentFee,
  ordinaryPaymentSighash,
  payToPubkeyScript,
  signOrdinaryPayment,
  storageMass,
  toHex,
  type OrdinaryPayment,
  type SignedOrdinaryPayment,
  type TransactionOutpoint,
} from "@warda_protocol/kaspa";
import { X402Error } from "./protocol.ts";
import { amountOf } from "./pay-v2.ts";
import type { ExactPaymentRequirements } from "@kaspa-x402/core";

/** The encoding their `exact` scheme pins, and the only one it accepts. */
export const SAFE_JSON_ENCODING = "kaspa-sdk-safe-json-v2.0.0";

const NATIVE_SUBNETWORK = "00".repeat(20);

/** Their serialized script public key: two bytes of version, then the script. */
function serializedScript(key: Uint8Array): string {
  return "0000" + toHex(payToPubkeyScript(key).script);
}

/**
 * The payee, as an x-only key.
 *
 * A grant can only ever pay a key: `RecipientSet` members are 32-byte x-only
 * keys and a spend builds `payToPubkeyScript` from one. So a vendor quoting a
 * pay-to-script-hash address is unpayable from a grant — not by this relay and
 * not directly either — and saying so here is better than a covenant refusing
 * a proof for reasons that read as a problem with the allowlist.
 */
export function relayPayee(accepted: ExactPaymentRequirements): Uint8Array {
  let decoded;
  try {
    decoded = decodeAddress(accepted.payTo);
  } catch (e) {
    throw new X402Error(`the vendor quoted an address this client cannot read: ${(e as Error).message}`);
  }
  /* The VERSION byte, not the payload length. A P2SH payload is also 32 bytes
     — it is a script hash — so length alone cannot tell a key from a script,
     and a check written on length silently accepts the thing it exists to
     reject. Version 0 is Schnorr pay-to-pubkey; 1 is ECDSA, which a Kaspa
     covenant cannot pay either; 8 is pay-to-script-hash. */
  if (decoded.version !== 0 || decoded.payload.length !== 32) {
    throw new X402Error(
      `the vendor quoted ${accepted.payTo}, which is address version ${decoded.version} — ` +
        `not a Schnorr pay-to-pubkey address.\n\n` +
        `A grant's allowlist is a set of x-only KEYS and a spend pays one of them, so a ` +
        `script-hash payee cannot be paid from a grant by any route — the relay does not ` +
        `change that, it only changes what the final transaction looks like.`,
    );
  }
  return decoded.payload;
}

/**
 * What the covenant spend must move, so this transaction can pay the invoice.
 *
 * The relay coin is spent WHOLE — there is no change output, because a small
 * one costs four orders of magnitude more in storage mass than none at all
 * (see `mass.ts`). So the fee is whatever the funding transaction puts in
 * above the invoice, and choosing it is choosing the fee.
 */
export function relayFunding(amount: bigint, fee: bigint): bigint {
  if (fee <= 0n) throw new X402Error("a relayed payment needs a positive fee to spend itself with");
  return amount + fee;
}

export interface RelayInput {
  /** The coin the covenant spend created, at a key the agent holds. */
  source: {
    outpoint: TransactionOutpoint;
    value: bigint;
    /** The agent's own x-only key — the relay key. */
    publicKey: Uint8Array;
  };
  accepted: ExactPaymentRequirements;
}

export interface RelayPayment {
  signed: SignedOrdinaryPayment;
  /** The `transaction` field of the payload, already stringified. */
  safeJson: string;
  storageMass: bigint;
  /** Their `paymentOutputIndex`. One output, so always 0. */
  paymentOutputIndex: 0;
  /** Their `inputIndex` for the authorization. One input, so always 0. */
  inputIndex: 0;
}

/**
 * Async, and trimming, because the payer's signer is both.
 *
 * A Warda `Signer` may live in an HSM or another process, and it returns the
 * 65 bytes a Kaspa TRANSACTION signature carries — 64 of Schnorr plus the
 * sighash-type byte. `signOrdinaryPayment` appends that byte itself, from the
 * same constant the verifier checks, so passing 65 through would produce a
 * 67-byte signature script and an instant refusal.
 */
export async function buildRelayPayment(
  input: RelayInput,
  sign: (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<RelayPayment> {
  const payee = relayPayee(input.accepted);
  const amount = amountOf(input.accepted);

  /* Checked here rather than left to their verifier. `payToScriptPublicKey` is
     what the authorization digest binds, so a payee script we derive
     differently from the one they advertise produces a payment that is correct
     on chain and refused off it — the exact failure this whole file exists
     because of. */
  const derived = serializedScript(payee);
  /* Their type marks this loosely; their schema requires it. Read defensively
     and only compare when a string actually arrived — a quote that omits it is
     a quote we cannot cross-check, not one we should refuse. */
  const advertised =
    typeof input.accepted.payToScriptPublicKey === "string"
      ? input.accepted.payToScriptPublicKey.toLowerCase()
      : undefined;
  if (advertised && advertised !== derived) {
    throw new X402Error(
      `the script this client derives for ${input.accepted.payTo} is not the one the vendor ` +
        `advertised.\n\n  derived    ${derived}\n  advertised ${advertised}\n\n` +
        `The authorization digest binds their value, so paying the derived one would settle ` +
        `on chain and be refused off it. Nothing has been built.`,
    );
  }

  const payment: OrdinaryPayment = { source: input.source, payee, amount };
  ordinaryPaymentFee(payment); // refuses before signing if the coin cannot cover it
  /* Signed up front rather than inside, so the async signer is awaited once
     and `signOrdinaryPayment` stays synchronous — it is also used where there
     is no event loop to wait on. The 65-byte form this SDK's signer returns is
     trimmed there, not here: it was trimmed in both places until a tool that
     called `signOrdinaryPayment` directly hit the check this duplicated. */
  const signature = await sign(ordinaryPaymentSighash(payment));
  const signed = signOrdinaryPayment(payment, () => signature);

  const mass = storageMass(
    [{ value: input.source.value, scriptPublicKey: payToPubkeyScript(input.source.publicKey) }],
    [{ value: amount, scriptPublicKey: payToPubkeyScript(payee) }],
  );

  /* Their parser reads exactly these names, and `covenant: null` is required
     rather than merely allowed — `value.covenant !== undefined && !== null`
     throws. Which is the opposite of the WASM deserializer, where the key must
     be ABSENT. The same field, two encodings, two incompatible rules. */
  const safe = {
    id: toHex(signed.id),
    version: 0,
    inputs: [
      {
        previousOutpoint: {
          transactionId: toHex(input.source.outpoint.transactionId),
          index: input.source.outpoint.index,
        },
        signatureScript: toHex(signed.signatureScript),
        sequence: "0",
        sigOpCount: 1,
        utxo: {
          amount: input.source.value.toString(),
          scriptPublicKey: serializedScript(input.source.publicKey),
        },
      },
    ],
    outputs: [{ value: amount.toString(), scriptPublicKey: derived, covenant: null }],
    lockTime: "0",
    subnetworkId: NATIVE_SUBNETWORK,
    gas: "0",
    payload: "",
    storageMass: mass.toString(),
  };

  return {
    signed,
    safeJson: JSON.stringify(safe),
    storageMass: mass,
    paymentOutputIndex: 0,
    inputIndex: 0,
  };
}
