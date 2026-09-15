/**
 * Where the grant's record lives, and who is responsible for it being right.
 *
 * ## Why a wallet has to own this at all
 *
 * A Warda grant's address is a hash of its state. Spend from it and the coin
 * moves to a different address, derived from the new spent/reserved/epoch
 * figures. So the record is not a convenience or a cache — it is the only way
 * to find the money again. Lose it and the grant is not gone, it is
 * unaddressable, which is worse because nothing says so: every tool reports
 * "no UTXO at <address>", a message with three causes and no way to tell them
 * apart.
 *
 * Until now that responsibility sat with the caller. `WardaPayer.state` is
 * documented as "persist this if the process may restart", which is true, and
 * puts the single most consequential bookkeeping step in this protocol in the
 * hands of whoever wrote the integration. This package exists largely to take
 * it back.
 *
 * ## Why an interface and not a file path
 *
 * The obvious version writes a JSON file. It is also the version that cannot
 * run where agents actually run — a container with a read-only filesystem, a
 * Lambda, a browser extension, a process that wants the record in Postgres
 * beside everything else it owns.
 *
 * So the same shape as `externalSigner`: name what is needed, let the caller
 * bring it, and ship the ordinary implementation for the ordinary case.
 *
 * ## The ordering rule, which is not negotiable
 *
 *   write BEFORE the broadcast     a submit that succeeds while the record is
 *                                  lost strands the coin at an address nobody
 *                                  can reconstruct
 *   advance WHEN THE COIN MOVES    not when the vendor is happy: a payment
 *                                  that settled and was never served still
 *                                  moved the grant, and the record's job is to
 *                                  say where the grant is
 *   never advance on a refusal     one that never reached the chain, that is;
 *                                  the grant did not move and writing as
 *                                  though it did loses the real one
 *
 * The middle rule used to read "advance AFTER delivery", which sounds more
 * careful and is not. It is the accounting question ("is this a spend or a
 * debt?") answered in the place that asks the addressing one ("where is the
 * coin?"), and the two have different answers whenever a vendor broadcasts
 * before it decides — which is what x402 v2 does.
 *
 * The first rule is why `save` exists separately from `advance`: they happen
 * at different moments for different reasons, and a single `set` would let a
 * caller collapse them by accident.
 */
import type { GrantState } from "@warda_protocol/kaspa";

/**
 * A grant manifest, as every tool in this repo writes it.
 *
 * Numbers rather than strings for the accounting fields, deliberately, because
 * genesis, `advance-manifest` and `follow-grant` all write numbers — and a
 * record whose shape depends on which tool touched it last is a record every
 * reader has to guess at. The index signature keeps fields this package does
 * not model: a wallet that silently drops `agent_key_derived` on its first
 * write would be a wallet that quietly edits your records.
 */
export interface Manifest {
  covenant: string;
  covenant_id: string;
  agent: string;
  principal: string;
  revocation: string;
  recipients_root: string;
  not_before: number;
  expires_at: number;
  budget: number;
  max_per_spend: number;
  epoch_limit: number;
  epoch_length: number;
  delegation_depth: number;
  grant_value: number;
  spent_total: number;
  reserved: number;
  epoch_index: number;
  epoch_spent: number;
  reserve_root: string;
  [field: string]: unknown;
}

export interface Store {
  load(): Promise<Manifest>;
  save(manifest: Manifest): Promise<void>;
}

/**
 * The state after a spend, folded onto the record.
 *
 * `grant_value` is the field that drifts if you are careless. The budget is
 * charged the PAYMENT; the coin loses the payment AND the fee. Advance it by
 * the payment alone and the record drifts by one fee per purchase until
 * something that reconciles against the chain refuses to publish it.
 */
export function advanced(manifest: Manifest, state: GrantState, spent: bigint, fee: bigint): Manifest {
  return {
    ...manifest,
    spent_total: Number(state.spentTotal),
    reserved: Number(state.reserved),
    epoch_index: Number(state.epochIndex),
    epoch_spent: Number(state.epochSpent),
    grant_value: Number(BigInt(manifest.grant_value) - spent - fee),
  };
}

/** Keeps the record in memory. For tests, and for a caller who persists elsewhere. */
export function memoryStore(initial: Manifest): Store & { current(): Manifest } {
  let held: Manifest = structuredClone(initial);
  return {
    async load() {
      return structuredClone(held);
    },
    async save(m) {
      held = structuredClone(m);
    },
    current() {
      return structuredClone(held);
    },
  };
}
