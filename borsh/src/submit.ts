/**
 * Submitting a covenant transaction over borsh.
 *
 * This file exists because a claim in `reader.ts` stopped being true. It said
 * the WASM SDK predates covenants — its `ITransactionOutput` is `{value,
 * scriptPublicKey}` and the string "covenant" appears nowhere — so a grant
 * spend serialized through it would be well-formed, correctly signed, and
 * carry no binding at all. That was, and still is, true of
 * `kaspa-wasm32-sdk@0.15.2`: zero occurrences of the word, in the types and in
 * the glue.
 *
 * It is not true of every build. rusty-kaspa's own wasm bindings have carried
 * covenants since Toccata — `CovenantBinding` is `#[wasm_bindgen]` with a
 * constructor, `TransactionOutput` takes one and exposes a getter — and builds
 * from those revisions are published. `@kluster/kaspa-wasm@2.0.1` is one.
 *
 * So the buyer's node requirement was never a protocol limit. It was a
 * PACKAGING limit, and it can be lifted by depending on a build that has what
 * upstream already wrote.
 *
 * ## Why this does not require trusting the build
 *
 * It would be a poor trade to remove "run your own node" by adding "trust a
 * third party's binary with your transactions". So this does not trust it.
 *
 * The covenant binding is part of the SIGHASH — that is the whole reason a
 * covenant-blind wallet cannot sign a Warda spend. Which means any difference
 * between what we signed and what the encoder produced shows up in the
 * transaction id. So every submit recomputes the id both ways and refuses to
 * broadcast unless they agree, byte for byte.
 *
 * A build that serialised anything differently — a tampered one, a stale one,
 * one from a revision where a field moved — is caught here, before the
 * network sees it, every time. The dependency can break this path. It cannot
 * redirect money through it.
 */

import {
  toHex,
  transactionId,
  transactionToWire,
  type Transaction,
} from "@warda_protocol/kaspa";

/** The parts of the WASM module this needs. Structural, and deliberately small. */
export interface WasmModule {
  Transaction: new (value: unknown) => { readonly id: unknown; readonly outputs: unknown[] };
  CovenantBinding?: unknown;
  TransactionOutput?: unknown;
}

/** Thrown when the module in use cannot express a covenant at all. */
export class CovenantsUnsupported extends Error {
  constructor(name: string) {
    super(
      `${name} cannot carry a covenant binding, so it must not serialize a Warda spend.\n\n` +
        `Borsh is POSITIONAL — there are no field names on the wire — so a struct the encoder ` +
        `does not know about is not an unknown field, it is an absent one. A grant spend built ` +
        `through such a module would be well-formed, correctly signed, and bound to nothing: ` +
        `accepted by the encoder, meaningless on chain.\n\n` +
        `Use a build from a revision that has covenants. kaspa-wasm32-sdk@0.15.2 does not; ` +
        `@kluster/kaspa-wasm@2.0.1 does. This is a packaging gap upstream, not a protocol one.`,
    );
    this.name = "CovenantsUnsupported";
  }
}

/**
 * Thrown when the encoder and this SDK disagree about what a transaction IS.
 *
 * Never expected, and therefore exactly the thing worth checking: two
 * serializers agreeing on every transaction until the one that matters is how
 * this protocol loses money rather than a day.
 */
export class SerialisationDisagreement extends Error {
  constructor(ours: string, theirs: string) {
    super(
      `the WASM encoder produced a different transaction than the one that was signed.\n\n` +
        `  signed   ${ours}\n` +
        `  encoded  ${theirs}\n\n` +
        `Nothing was broadcast. The covenant binding is part of the sighash, so any difference ` +
        `at all means the signature does not cover what would have been sent. Either the build ` +
        `in use serializes something differently, or it is not the build it claims to be.`,
    );
    this.name = "SerialisationDisagreement";
  }
}

/**
 * Can this module express a covenant?
 *
 * Feature-detected by CONSTRUCTING one, not by reading a version or a package
 * name. Upstream may ship this in `kaspa-wasm32-sdk` tomorrow, and a check
 * that named packages would then refuse the right answer.
 */
export function supportsCovenants(wasm: unknown): boolean {
  const m = wasm as Record<string, unknown>;
  if (typeof m.CovenantBinding !== "function" || typeof m.Hash !== "function") return false;
  try {
    const Hash = m.Hash as new (hex: string) => unknown;
    const Binding = m.CovenantBinding as new (input: number, id: unknown) => { covenantId: unknown };
    const probe = new Binding(0, new Hash("00".repeat(32)));
    return probe.covenantId !== undefined;
  } catch {
    return false;
  }
}

/**
 * Our transaction, in the shape the WASM client takes.
 *
 * `transactionToWire` already produces it — the JSON transport has emitted
 * exactly this for months — with ONE difference: it writes `covenant: null`
 * for an ordinary output, and the WASM deserializer wants the key absent.
 * `Error converting property 'covenant': supplied argument is not an object`
 * is what it says otherwise, which names the property and not the null.
 *
 * Adapting the shared mapping rather than writing a second one is deliberate.
 * Two encoders of the same transaction is two things that can disagree, and
 * the disagreement would be found by the id check below rather than by
 * anybody reading code.
 */
export function toWasmTransaction(tx: Transaction, wasm: WasmModule): { id: unknown } {
  const wire = transactionToWire(tx) as { outputs: Record<string, unknown>[] };
  wire.outputs = wire.outputs.map((o) => {
    if (o.covenant !== null) return o;
    const { covenant: _dropped, ...rest } = o;
    return rest;
  });
  return new wasm.Transaction(wire);
}

/**
 * Build it, check both implementations agree, and hand back what to submit.
 *
 * The order matters: the guard runs before anything reaches the network, so a
 * disagreement costs nothing.
 */
export function encodeForSubmit(tx: Transaction, wasm: WasmModule, name = "this WASM module"): unknown {
  if (!supportsCovenants(wasm)) throw new CovenantsUnsupported(name);
  const built = toWasmTransaction(tx, wasm);
  const ours = toHex(transactionId(tx));
  const theirs = String(built.id);
  if (ours !== theirs) throw new SerialisationDisagreement(ours, theirs);
  return built;
}
