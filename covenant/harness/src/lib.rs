//! Warda spend covenant — execution proof.
//!
//! Compiles warda_grant.sil and runs it through `TxScriptEngine`, the SAME
//! engine a Kaspa node uses to validate a transaction. No node, no RPC, no
//! testnet round-trip: a verdict in milliseconds.
//!
//! @warda_protocol/core proves the SEMANTICS. This proves the BYTECODE. Between them
//! there is no room left for "submit to testnet and see what happens".

use kaspa_consensus_core::Hash;

use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;

use kaspa_consensus_core::tx::{
    CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId,
    TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry, VerifiableTransaction,
};

use kaspa_txscript::caches::Cache;

use kaspa_txscript::covenants::CovenantsContext;

use kaspa_txscript::opcodes::codes::OpTrue;

use kaspa_txscript::script_builder::ScriptBuilder;

use kaspa_txscript::{pay_to_script_hash_script, EngineCtx, EngineFlags, TxScriptEngine};

use kaspa_txscript_errors::TxScriptError;

use silverscript_lang::ast::Expr;

use silverscript_lang::compiler::{
    compile_contract, CompileOptions, CompiledContract, CovenantDeclCallOptions,
};

pub const COV: Hash = Hash::from_bytes(*b"WARDAWARDAWARDAWARDAWARDAWARDAWA");

pub const SOURCE: &str = include_str!("../../warda_grant.sil");

/// The v4 constructor: 21 arguments, in the order `warda_grant.sil` declares.
///
/// This list said "v2 constructor order" for two covenant versions, and was
/// right when it was written. v4 inserted `genesisTemplateId`,
/// `templatePrefixLen` and `templateSuffixLen` at 12..14 — which moved
/// `maxProofDepth` to 15 and every init field below it by three — and added
/// `initReserveRoot` at 20 for the LIFO reserve chain. `covenant/deploy` was
/// updated and carries comments recording exactly that; this file was not, so
/// 32 of 33 tests failed to compile and nobody noticed, because nobody ran
/// them. The suite that exists to prove the bytecode was proving a covenant
/// two versions old.
///
/// Keep this list beside `ctor()` in `covenant/deploy/src` — they are the same
/// list twice, which is the repo's most expensive recurring shape. The fix is
/// to share it; until then, change one and search for the other.
pub fn ctor(max_proof_depth: i64) -> Vec<Expr<'static>> {
    vec![
        Expr::bytes(vec![0x11; 32]),      //  0 principalKey
        Expr::bytes(vec![0x44; 32]),      //  1 revocationKey
        Expr::int(100_000),               //  2 maxFee
        Expr::bytes(vec![0x22; 32]),      //  3 genesisAgentKey
        Expr::int(10_000_000_000),        //  4 genesisBudgetTotal    100 KAS
        Expr::int(200_000_000),           //  5 genesisMaxPerSpend      2 KAS
        Expr::int(1_000_000_000),         //  6 genesisEpochLimit      10 KAS
        Expr::int(1_000),                 //  7 genesisEpochLength
        Expr::bytes(vec![0x13; 32]),      //  8 genesisRecipientsRoot
        Expr::int(1_000_000),             //  9 genesisNotBefore
        Expr::int(1_007_000),             // 10 genesisExpiresAt
        Expr::int(2),                     // 11 genesisDelegationDepth
        // A wrong templateId is not a compile error and not a security hole:
        // the covenant's own comment says it simply yields a different address,
        // one nobody funded. Only the splice path reads it, and nothing here
        // exercises that path yet.
        Expr::bytes(vec![0x55; 32]),      // 12 genesisTemplateId
        // Geometry. These are LENGTHS, and the deploy tool derives them from
        // the compiled size by iterating to a fixed point. They must stay small
        // and plausible: a large value lands in a for-loop bound and the
        // compiler refuses it far from where the mistake was made.
        Expr::int(64),                    // 13 templatePrefixLen
        Expr::int(64),                    // 14 templateSuffixLen
        Expr::int(max_proof_depth),       // 15 maxProofDepth   (was 12 in v2)
        Expr::int(0),                     // 16 initSpentTotal
        Expr::int(0),                     // 17 initReserved
        Expr::int(0),                     // 18 initEpochIndex
        Expr::int(0),                     // 19 initEpochSpent
        Expr::bytes(empty_reserve().to_vec()),      // 20 initReserveRoot  (empty chain)
    ]
}

/// The authority half of State, constant across every spend. `spend` asserts
/// each of these is unchanged in the successor — without that an agent
/// rewrites its own cap and every limit becomes decorative.
pub fn authority_fields(root: [u8; 32], agent_xonly: [u8; 32]) -> Vec<(&'static str, Expr<'static>)> {
    vec![
        ("agentKey", Expr::bytes(agent_xonly.to_vec())),
        ("budgetTotal", Expr::int(10_000_000_000)),
        ("maxPerSpend", Expr::int(200_000_000)),
        ("epochLimit", Expr::int(1_000_000_000)),
        ("epochLength", Expr::int(1_000)),
        ("recipientsRoot", Expr::bytes(root.to_vec())),
        ("notBefore", Expr::int(1_000_000)),
        ("expiresAt", Expr::int(1_007_000)),
        ("delegationDepth", Expr::int(2)),
        // v4. Authority, not accounting: `spend` asserts it unchanged, so it
        // must equal ctor slot 12 or every successor is a different grant.
        ("templateId", Expr::bytes(vec![0x55; 32])),
    ]
}

pub fn compile(max_proof_depth: i64) -> CompiledContract<'static> {
    compile_contract(SOURCE, &ctor(max_proof_depth), CompileOptions::default())
        .expect("warda_grant.sil compiles")
}

// ---- reserve-chain derivations -------------------------------------------
//
// These mirror `covenant/deploy/src`, which is the copy that has produced
// every live grant. Two copies of one derivation is the shape that killed
// this suite; until they are shared, change one and search for the other.
//
// The empty chain is NOT 32 zero bytes. `warda_grant.sil` computes it as
// blake2b("WardaEmptyReserve") — and the covenant's own comments explain why
// a zero-valued separator is a trap: Kaspa script encodes zero as the EMPTY
// byte string, so a zero constant silently disappears.

pub fn keyed_b2b(data: &[u8], key: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(
        blake2b_simd::Params::new().hash_length(32).key(key).to_state().update(data).finalize().as_bytes(),
    );
    out
}

pub fn empty_reserve() -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(
        blake2b_simd::Params::new().hash_length(32).to_state().update(b"WardaEmptyReserve").finalize().as_bytes(),
    );
    out
}

pub fn num2bin8(v: i64) -> [u8; 8] {
    let mut out = (v.unsigned_abs()).to_le_bytes();
    if v < 0 {
        out[7] |= 0x80;
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub fn child_id(
    agent: [u8; 32], budget: i64, max_per_spend: i64, epoch_limit: i64, epoch_length: i64,
    root: [u8; 32], not_before: i64, expires_at: i64, delegation_depth: i64,
) -> [u8; 32] {
    let mut pre = Vec::new();
    pre.extend_from_slice(&agent);
    pre.extend_from_slice(&num2bin8(budget));
    pre.extend_from_slice(&num2bin8(max_per_spend));
    pre.extend_from_slice(&num2bin8(epoch_limit));
    pre.extend_from_slice(&num2bin8(epoch_length));
    pre.extend_from_slice(&root);
    pre.extend_from_slice(&num2bin8(not_before));
    pre.extend_from_slice(&num2bin8(expires_at));
    pre.extend_from_slice(&num2bin8(delegation_depth));
    keyed_b2b(&pre, b"WardaChildId")
}

pub fn push_child(root: [u8; 32], child: [u8; 32]) -> [u8; 32] {
    let mut pre = Vec::with_capacity(64);
    pre.extend_from_slice(&root);
    pre.extend_from_slice(&child);
    keyed_b2b(&pre, b"WardaReserve")
}

pub fn push_redeem_script(bytecode: &[u8]) -> Vec<u8> {
    ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() })
        .add_data(bytecode)
        .expect("push redeem script")
        .drain()
}

/// Plain `entry` functions (revoke, reclaim) use build_sig_script.
/// `#[covenant]`-annotated policy functions use the covenant-decl builder
/// below — passing a plain entry to that one panics.
pub fn plain_sigscript(compiled: &CompiledContract<'_>, function: &str, args: Vec<Expr<'_>>) -> Vec<u8> {
    let mut s = compiled.build_sig_script(function, args).expect("build sig script");
    s.extend_from_slice(&push_redeem_script(&compiled.bytecode));
    s
}

#[allow(dead_code)]
pub fn sigscript(compiled: &CompiledContract<'_>, function: &str, args: Vec<Expr<'_>>) -> Vec<u8> {
    let mut s = compiled
        .build_sig_script_for_covenant_decl(function, args, CovenantDeclCallOptions { is_leader: false })
        .expect("build covenant declaration sigscript");
    s.extend_from_slice(&push_redeem_script(&compiled.bytecode));
    s
}

pub fn covenant_utxo(compiled: &CompiledContract<'_>, value: u64) -> UtxoEntry {
    UtxoEntry::new(value, pay_to_script_hash_script(&compiled.bytecode), 0, false, Some(COV))
}

/// KOM bug #5, made structural: `TransactionInput::new` sets a SigopCount
/// commit, which is the WRONG commit kind for a v1 covenant input. The obvious
/// constructor is the wrong one. Always `new_with_compute_budget` here.
pub fn tx_input(index: u32, signature_script: Vec<u8>) -> TransactionInput {
    TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([index as u8 + 1; 32]), index },
        signature_script,
        0,
        1000,
    )
}

pub fn continuation_output(compiled: &CompiledContract<'_>, value: u64) -> TransactionOutput {
    TransactionOutput {
        value,
        script_public_key: pay_to_script_hash_script(&compiled.bytecode),
        covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
    }
}

pub fn payment_output(value: u64) -> TransactionOutput {
    TransactionOutput { value, script_public_key: ScriptPublicKey::new(0, vec![OpTrue].into()), covenant: None }
}

pub fn execute(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> Result<(), TxScriptError> {
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[input_idx].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    let utxo = populated.utxo(input_idx).expect("input utxo");
    let mut vm = TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        input_idx,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx),
        EngineFlags { covenants_enabled: true, sigop_script_units: 0.into() },
    );
    vm.execute()
}

// ---------------------------------------------------------------------------
// Attack path — proven at bytecode level.
//
// The covenant calls checkSig LAST, so every guard fires before signing is
// reached. That means the attack claims are provable without a covenant-aware
// signer, which is the expensive part. The happy path needs one; these do not.
// ---------------------------------------------------------------------------

use silverscript_lang::ast::{ArrayDim, TypeBase, TypeRef};

use silverscript_lang::compiler::struct_object;

/// `byte[32][]` — fixed inner dimension, DYNAMIC outer. Neither
/// `inferred_array` (gives byte[][]) nor `TryFrom<Vec<Vec<u8>>>` (gives
/// byte[32][N], a fixed outer) matches the parameter type. The TypeRef has to
/// be built by hand.
pub fn byte32_array(items: Vec<[u8; 32]>) -> Expr<'static> {
    Expr::array(
        TypeRef { base: TypeBase::Byte, array_dims: vec![ArrayDim::Fixed(32), ArrayDim::Dynamic] },
        items.into_iter().map(|b| Expr::bytes(b.to_vec())).collect(),
    )
}

pub fn bool_array(items: Vec<bool>) -> Expr<'static> {
    Expr::array(
        TypeRef { base: TypeBase::Bool, array_dims: vec![ArrayDim::Dynamic] },
        items.into_iter().map(Expr::bool).collect(),
    )
}

pub const KAS: i64 = 100_000_000;

/// Full State: nine authority fields plus four accounting fields, in
/// declaration order. The authority half must match the contract instance
/// exactly or the successor comparison fails for the wrong reason.
pub fn state_full(
    root: [u8; 32],
    agent_xonly: [u8; 32],
    spent: i64,
    reserved: i64,
    epoch_index: i64,
    epoch_spent: i64,
) -> Expr<'static> {
    let mut fields = authority_fields(root, agent_xonly);
    fields.push(("spentTotal", Expr::int(spent)));
    fields.push(("reserved", Expr::int(reserved)));
    fields.push(("epochIndex", Expr::int(epoch_index)));
    fields.push(("epochSpent", Expr::int(epoch_spent)));
    fields.push(("reserveRoot", Expr::bytes(empty_reserve().to_vec())));
    struct_object("State", fields)
}

/// Default-instance shorthand, matching `ctor()`'s genesis values.
pub fn state(spent: i64, reserved: i64, epoch_index: i64, epoch_spent: i64) -> Expr<'static> {
    state_full([0x13; 32], [0x22; 32], spent, reserved, epoch_index, epoch_spent)
}

/// Build a spend attempt. The Merkle proof is deliberately a single dummy
/// sibling: every guard we exercise here fires before the proof is checked,
/// so a real proof would not change the verdict — and pretending otherwise
/// would make these tests prove less than they appear to.
pub fn spend_attempt(c: &CompiledContract<'_>, amount: i64, claimed_daa: i64, new_state: Expr<'static>) -> Vec<u8> {
    sigscript(
        c,
        "spend",
        vec![
            new_state,
            Expr::int(amount),
            Expr::bytes(vec![0xa1; 32]),                                        // recipient
            byte32_array(vec![[0u8; 32]]),                                      // proofSiblings
            bool_array(vec![false]),                                            // proofSiblingIsLeft
            Expr::int(claimed_daa),
            Expr::bytes(vec![0u8; 65]),                                         // agentSig (65, not 64)
        ],
    )
}

pub fn run_spend(c: &CompiledContract<'_>, amount: i64, claimed_daa: i64, new_state: Expr<'static>) -> Result<(), TxScriptError> {
    run_spend_with_locktime(c, amount, claimed_daa, new_state, claimed_daa.max(0) as u64)
}

pub fn run_spend_with_locktime(
    c: &CompiledContract<'_>,
    amount: i64,
    claimed_daa: i64,
    new_state: Expr<'static>,
    lock_time: u64,
) -> Result<(), TxScriptError> {
    let tx = Transaction::new(
        1,
        vec![tx_input(0, spend_attempt(c, amount, claimed_daa, new_state))],
        vec![continuation_output(c, 1_000), payment_output(amount.max(1) as u64)],
        lock_time,
        Default::default(),
        0,
        vec![],
    );
    execute(tx, vec![covenant_utxo(c, 1_500)], 0)
}

// ---------------------------------------------------------------------------
// Recipient allowlist — a real Merkle proof.
//
// OpBlake2b is `blake2b_simd::Params::new().hash_length(32)`: plain
// BLAKE2b-256, unkeyed, no personalization. Anything else here silently
// produces a root the covenant will never match.
// ---------------------------------------------------------------------------

// Non-zero on purpose — 0x00 compiles to an empty push in Kaspa script and the
// domain separation vanishes. Must match warda_grant.sil exactly.
pub const LEAF: u8 = 0x01;

pub const NODE: u8 = 0x02;

pub fn b2b(parts: &[&[u8]]) -> [u8; 32] {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    for p in parts {
        state.update(p);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(state.finalize().as_bytes());
    out
}

pub fn leaf_hash(recipient: &[u8; 32]) -> [u8; 32] {
    b2b(&[&[LEAF], recipient])
}

/// Mirrors RecipientSet in @warda_protocol/core: domain-separated leaves and nodes,
/// odd nodes promoted rather than duplicated, canonical sort.
pub struct Tree {
    pub levels: Vec<Vec<[u8; 32]>>,
    pub members: Vec<[u8; 32]>,
}

impl Tree {
    pub fn new(mut members: Vec<[u8; 32]>) -> Self {
        members.sort();
        let mut levels = vec![members.iter().map(leaf_hash).collect::<Vec<_>>()];
        while levels.last().unwrap().len() > 1 {
            let prev = levels.last().unwrap();
            let mut next = Vec::new();
            let mut i = 0;
            while i < prev.len() {
                if i + 1 < prev.len() {
                    next.push(b2b(&[&[NODE], &prev[i], &prev[i + 1]]));
                } else {
                    next.push(prev[i]); // promoted, not duplicated
                }
                i += 2;
            }
            levels.push(next);
        }
        Self { levels, members }
    }

    pub fn root(&self) -> [u8; 32] {
        self.levels.last().unwrap()[0]
    }

    /// (siblings, is_left) — side travels per-sibling because promotion skips
    /// a level and index parity alone desynchronises.
    pub fn proof(&self, recipient: &[u8; 32]) -> (Vec<[u8; 32]>, Vec<bool>) {
        let mut idx = self.members.iter().position(|m| m == recipient).expect("member");
        let (mut sibs, mut lefts) = (Vec::new(), Vec::new());
        for level in &self.levels[..self.levels.len() - 1] {
            let pair = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
            if pair < level.len() {
                sibs.push(level[pair]);
                lefts.push(pair < idx);
            }
            idx /= 2;
        }
        (sibs, lefts)
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Happy path — the piece that upgrades every rejection above from "refused"
// to "refused FOR THIS REASON".
//
// Signing must happen here in Rust. Per KOM bug #3 the WASM signer's
// hash_output omits covenant data, so createInputSignature cannot sign a
// covenant transaction at all.
// ---------------------------------------------------------------------------

use kaspa_consensus_core::hashing::sighash::calc_schnorr_signature_hash;

use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;

use kaspa_consensus_core::tx::MutableTransaction;

use secp256k1::{Keypair, Secp256k1};

/// A key that is not the agent's. Signing with it must be refused, whatever
/// else about the transaction is correct.
pub fn stranger_keypair() -> Keypair {
    let secp = Secp256k1::new();
    Keypair::from_seckey_slice(&secp, &[0x7fu8; 32]).expect("valid key")
}

pub fn agent_keypair() -> Keypair {
    let secp = Secp256k1::new();
    Keypair::from_seckey_slice(&secp, &[0x42u8; 32]).expect("valid secret key")
}

/// 64-byte schnorr signature + the SIG_HASH_ALL byte = 65. Anything else is
/// rejected as a type mismatch before it ever reaches the engine.
pub fn sign_input(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize, kp: &Keypair) -> Vec<u8> {
    let mtx = MutableTransaction::with_entries(tx, entries);
    let reused = SigHashReusedValuesUnsync::new();
    let sig_hash = calc_schnorr_signature_hash(&mtx.as_verifiable(), input_idx, SIG_HASH_ALL, &reused);
    let msg = secp256k1::Message::from_digest_slice(sig_hash.as_bytes().as_slice()).expect("sighash");
    let mut sig = kp.sign_schnorr(msg).as_ref().to_vec();
    sig.push(SIG_HASH_ALL.to_u8());
    sig
}

pub fn ctor_with(root: [u8; 32], agent_xonly: [u8; 32], depth: i64) -> Vec<Expr<'static>> {
    let mut v = ctor(depth);
    v[3] = Expr::bytes(agent_xonly.to_vec());   // genesisAgentKey
    v[8] = Expr::bytes(root.to_vec());          // genesisRecipientsRoot
    v
}

/// KOM bug #6, confirmed here: **each UTXO's ADDRESS commits its state.**
///
/// The continuation output must be sent to the P2SH of the covenant compiled
/// with the NEW state, not the current one. The covenant derives that expected
/// script itself and OpEqualVerify-checks it, so sending to the input's own
/// address — the obvious thing to do, and what Mecenas does — always fails.
///
/// Practical consequence: the SDK cannot build a spend without first compiling
/// the successor and deriving its address. That is the transaction, not
/// plumbing around it.
pub fn ctor_at_state(
    root: [u8; 32],
    agent_xonly: [u8; 32],
    depth: i64,
    spent: i64,
    reserved: i64,
    epoch_index: i64,
    epoch_spent: i64,
) -> Vec<Expr<'static>> {
    /* v4 slots. These were 13..16 — the v2 positions — and stayed there after
       genesisTemplateId, templatePrefixLen and templateSuffixLen were inserted
       at 12..14. So `spent` was being written into templatePrefixLen,
       `reserved` into templateSuffixLen and `epoch_index` into maxProofDepth.
       The successor then compiled to entirely different bytecode, its P2SH did
       not match the script the covenant derives for the continuation, and the
       engine refused every baseline with an error that names nothing.

       Indices into a positional list are the same hazard as the list itself:
       `covenant/deploy` recorded this exact trap after writing a probe value
       into a stale slot and landing a huge number where a template LENGTH
       belongs. Second occurrence, same cause, different file. */
    ctor_at_state_with_reserve(root, agent_xonly, depth, spent, reserved, epoch_index, epoch_spent, empty_reserve())
}

/// The same, for a successor whose reserve chain has MOVED.
///
/// A spend leaves `reserveRoot` alone, so `ctor_at_state` can default it. A
/// delegation does not: the parent's continuation carries
/// `H(reserveRoot || childId)`. Compiling that successor with the empty chain
/// while DECLARING the pushed one produces a state the covenant accepts and a
/// script it does not — the declared `parentNext` passes every `require`, and
/// then the output's P2SH fails to match the continuation script the covenant
/// derives for itself. One opaque VerifyError, a long way from the cause.
#[allow(clippy::too_many_arguments)]
pub fn ctor_at_state_with_reserve(
    root: [u8; 32],
    agent_xonly: [u8; 32],
    depth: i64,
    spent: i64,
    reserved: i64,
    epoch_index: i64,
    epoch_spent: i64,
    reserve_root: [u8; 32],
) -> Vec<Expr<'static>> {
    let mut v = ctor_with(root, agent_xonly, depth);
    v[16] = Expr::int(spent);
    v[17] = Expr::int(reserved);
    v[18] = Expr::int(epoch_index);
    v[19] = Expr::int(epoch_spent);
    v[20] = Expr::bytes(reserve_root.to_vec());
    v
}

/// Same as `execute`, but captures a per-opcode trace. The engine has this
/// built in via `with_opcode_execution_log_buffer` — no need to patch
/// rusty-kaspa locally the way KOM had to.
pub fn execute_traced(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> (Result<(), TxScriptError>, String) {
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[input_idx].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = match CovenantsContext::from_tx(&populated) {
        Ok(c) => c,
        Err(e) => return (Err(TxScriptError::from(e)), String::new()),
    };
    let utxo = populated.utxo(input_idx).expect("input utxo");
    let mut log: Vec<u8> = Vec::new();
    let result = {
        let mut vm = TxScriptEngine::from_transaction_input(
            &populated,
            &input,
            input_idx,
            utxo,
            EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx),
            EngineFlags { covenants_enabled: true, sigop_script_units: 0.into() },
        )
        .with_opcode_execution_log_buffer(&mut log);
        vm.execute()
    };
    (result, String::from_utf8_lossy(&log).into_owned())
}

// ---------------------------------------------------------------------------
// Flip tests — each derives from a spend that is KNOWN to be accepted and
// changes exactly one field.
//
// This is what makes an assertion meaningful. "assert!(is_err())" against a
// baseline that never passed proves nothing: the transaction might be refused
// for any reason at all. Flipping one field on an accepted baseline means the
// rejection can only be caused by that field.
// ---------------------------------------------------------------------------

/// The grant every attempt below is built against. These are `ctor()`'s
/// genesis values, named so the auditor can straddle each boundary by
/// arithmetic rather than by a literal somebody has to keep in step.
pub const BUDGET_TOTAL: i64 = 10_000_000_000; // 100 KAS
pub const MAX_PER_SPEND: i64 = 200_000_000;   //   2 KAS
pub const EPOCH_LIMIT: i64 = 1_000_000_000;   //  10 KAS
pub const EPOCH_LENGTH: i64 = 1_000;
pub const NOT_BEFORE: i64 = 1_000_000;
pub const EXPIRES_AT: i64 = 1_007_000;
pub const DELEGATION_DEPTH: i64 = 2;
pub const MAX_FEE: i64 = 100_000;
pub const IN_VALUE: u64 = 10_000_000_000;

/// One spend attempt, with every input the covenant reads exposed.
///
/// `valid()` is a spend the engine returns `Ok(())` for. Every field below is
/// a lever the auditor moves one at a time, so a rejection can only be caused
/// by the field that moved — the property that turns "the covenant refused
/// this" into "the covenant refused this BECAUSE of that rule".
pub struct Spend {
    /// Override the successor's authority half — used to prove the v2
    /// immutability guards. `None` keeps it identical to the instance.
    pub authority_override: Option<(&'static str, Expr<'static>)>,
    pub amount: i64,
    pub recipient: [u8; 32],
    pub claimed_daa: i64,
    /// Successor state, defaulted from `prev` + `amount` unless overridden.
    pub successor: Option<(i64, i64, i64, i64)>,
    pub pay_to: Option<[u8; 32]>,
    /// The state the grant is ALREADY in: spent, reserved, epochIndex,
    /// epochSpent. Genesis is all zeros; a budget or epoch boundary can only
    /// be reached by starting somewhere else.
    pub prev: (i64, i64, i64, i64),
    /// The transaction's locktime. `None` means "exactly the claimed DAA",
    /// which is what an honest spend does; a lower value is the CLTV attack.
    pub tx_daa: Option<i64>,
    /// Extra taken out of the continuation, on top of the 1,000 the baseline
    /// already leaves as fee. The covenant allows up to `maxFee`.
    pub extra_fee: i64,
    /// Sign with a key that is not the agent's.
    pub wrong_key: bool,
}

impl Spend {
    pub fn valid() -> Self {
        Spend {
            authority_override: None,
            amount: KAS / 2,
            recipient: [0xa1; 32],
            claimed_daa: 1_000_500,
            successor: None,
            pay_to: None,
            prev: (0, 0, 0, 0),
            tx_daa: None,
            extra_fee: 0,
            wrong_key: false,
        }
    }

    pub fn run(&self) -> Result<(), TxScriptError> {
        let kp = agent_keypair();
        let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
        let tree = Tree::new(vec![[0xa1; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]]);
        let (ps, pr, pi, pe) = self.prev;
        let c = compile_contract(
            SOURCE,
            &ctor_at_state(tree.root(), agent_xonly, 4, ps, pr, pi, pe),
            CompileOptions::default(),
        )
        .expect("compiles");

        /* The honest successor, which is what the covenant recomputes for
           itself. An epoch that has moved on resets the epoch spend to this
           payment; an epoch still in progress adds to it. Getting this wrong
           makes every boundary case fail for the successor comparison rather
           than for the rule under test — one opaque VerifyError, a long way
           from the cause. */
        let cur_epoch = (self.claimed_daa - NOT_BEFORE).div_euclid(EPOCH_LENGTH);
        let honest = if cur_epoch > pi {
            (ps + self.amount, pr, cur_epoch, self.amount)
        } else {
            (ps + self.amount, pr, pi, pe + self.amount)
        };
        let (ss, sr, si, se) = self.successor.unwrap_or(honest);
        let successor = compile_contract(
            SOURCE,
            &ctor_at_state(tree.root(), agent_xonly, 4, ss, sr, si, se),
            CompileOptions::default(),
        )
        .expect("successor compiles");

        // A recipient outside the tree has no proof; borrowing a valid one is
        // the best an attacker can do, and is exactly what a rogue agent would
        // try.
        let proof_for = if tree.members.contains(&self.recipient) { self.recipient } else { [0xa1; 32] };
        let (sibs, lefts) = tree.proof(&proof_for);

        let payee = self.pay_to.unwrap_or(self.recipient);
        let mut p2pk = vec![0x20u8];
        p2pk.extend_from_slice(&payee);
        p2pk.push(0xac);

        let in_value: u64 = IN_VALUE;
        let amount = self.amount;
        let claimed_daa = self.claimed_daa;
        let tx_daa = self.tx_daa.unwrap_or(claimed_daa);
        let extra_fee = self.extra_fee;
        let build = |sig: Vec<u8>| {
            let args = vec![
                {
                    let mut fields = authority_fields(tree.root(), agent_xonly);
                    if let Some((name, ref v)) = self.authority_override {
                        for f in fields.iter_mut() {
                            if f.0 == name {
                                f.1 = v.clone();
                            }
                        }
                    }
                    fields.push(("spentTotal", Expr::int(ss)));
                    fields.push(("reserved", Expr::int(sr)));
                    fields.push(("epochIndex", Expr::int(si)));
                    fields.push(("epochSpent", Expr::int(se)));
                    fields.push(("reserveRoot", Expr::bytes(empty_reserve().to_vec())));
                    struct_object("State", fields)
                },
                Expr::int(amount),
                Expr::bytes(self.recipient.to_vec()),
                byte32_array(sibs.clone()),
                bool_array(lefts.clone()),
                Expr::int(claimed_daa),
                Expr::bytes(sig),
            ];
            Transaction::new(
                1,
                vec![tx_input(0, sigscript(&c, "spend", args))],
                vec![
                    TransactionOutput {
                        /* Saturating on purpose. An attempt that takes more
                           than the input holds is a transaction the engine
                           must refuse, not an arithmetic error in the tool
                           asking the question. */
                        value: in_value
                            .saturating_sub(amount.max(0) as u64)
                            .saturating_sub(1_000)
                            .saturating_sub(extra_fee.max(0) as u64),
                        script_public_key: pay_to_script_hash_script(&successor.bytecode),
                        covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
                    },
                    TransactionOutput {
                        value: amount.max(1) as u64,
                        script_public_key: ScriptPublicKey::new(0, p2pk.clone().into()),
                        covenant: None,
                    },
                ],
                tx_daa.max(0) as u64,
                Default::default(),
                0,
                vec![],
            )
        };

        let entries = vec![covenant_utxo(&c, in_value)];
        let signer = if self.wrong_key { stranger_keypair() } else { kp };
        let sig = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &signer);
        execute(build(sig), entries, 0)
    }
}

// ---------------------------------------------------------------------------
// v2 only: authority now lives in State, so it CAN be tampered with. These
// prove the nine immutability guards that the move made necessary. Under v1
// these attacks were impossible by construction; under v2 they are impossible
// only because the covenant checks.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DELEGATION — conservation proven against the engine.
//
// The spec calls conservation its strongest structural property: authority is
// neither created nor destroyed by delegation, only subdivided. These tests
// are what turn that from a claim into a demonstration.
// ---------------------------------------------------------------------------

/// Child authority — deliberately narrower than the parent on every axis.
pub struct Child {
    pub budget: i64,
    pub max_per_spend: i64,
    pub epoch_limit: i64,
    pub expires_at: i64,
    pub not_before: i64,
    pub delegation_depth: i64,
    pub root: Option<[u8; 32]>,
    pub accounting: (i64, i64, i64, i64),
}

impl Child {
    pub fn narrower() -> Self {
        Child {
            budget: 25 * KAS,
            max_per_spend: KAS,
            epoch_limit: 5 * KAS,
            expires_at: 1_007_000,
            not_before: 1_000_000,
            delegation_depth: 1,
            root: None,
            accounting: (0, 0, 0, 0),
        }
    }
}

pub fn child_state(root: [u8; 32], child_key: [u8; 32], ch: &Child) -> Expr<'static> {
    let (s, r, ei, es) = ch.accounting;
    struct_object(
        "State",
        vec![
            ("agentKey", Expr::bytes(child_key.to_vec())),
            ("budgetTotal", Expr::int(ch.budget)),
            ("maxPerSpend", Expr::int(ch.max_per_spend)),
            ("epochLimit", Expr::int(ch.epoch_limit)),
            ("epochLength", Expr::int(1_000)),
            ("recipientsRoot", Expr::bytes(ch.root.unwrap_or(root).to_vec())),
            ("notBefore", Expr::int(ch.not_before)),
            ("expiresAt", Expr::int(ch.expires_at)),
            ("delegationDepth", Expr::int(ch.delegation_depth)),
            ("templateId", Expr::bytes(vec![0x55; 32])),
            ("spentTotal", Expr::int(s)),
            ("reserved", Expr::int(r)),
            ("epochIndex", Expr::int(ei)),
            ("epochSpent", Expr::int(es)),
            ("reserveRoot", Expr::bytes(empty_reserve().to_vec())),
        ],
    )
}

pub fn child_ctor(root: [u8; 32], child_key: [u8; 32], ch: &Child, depth: i64) -> Vec<Expr<'static>> {
    let (s, r, ei, es) = ch.accounting;
    vec![
        Expr::bytes(vec![0x11; 32]),
        Expr::bytes(vec![0x44; 32]),
        Expr::int(100_000),
        Expr::bytes(child_key.to_vec()),
        Expr::int(ch.budget),
        Expr::int(ch.max_per_spend),
        Expr::int(ch.epoch_limit),
        Expr::int(1_000),
        Expr::bytes(ch.root.unwrap_or(root).to_vec()),
        Expr::int(ch.not_before),
        Expr::int(ch.expires_at),
        Expr::int(ch.delegation_depth),
        Expr::bytes(vec![0x55; 32]),   // 12 genesisTemplateId — same template
        Expr::int(64),                 // 13 templatePrefixLen
        Expr::int(64),                 // 14 templateSuffixLen
        Expr::int(depth),              // 15 maxProofDepth  (was 12 in v2)
        Expr::int(s),
        Expr::int(r),
        Expr::int(ei),
        Expr::int(es),
        Expr::bytes(empty_reserve().to_vec()),   // 20 initReserveRoot
    ]
}

pub fn run_delegation(ch: &Child, parent_reserved_override: Option<i64>) -> Result<(), TxScriptError> {
    let kp = agent_keypair();
    let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
    let child_key = [0x99u8; 32];
    let tree = Tree::new(vec![[0xa1; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]]);
    let depth = 4;

    let parent = compile_contract(SOURCE, &ctor_with(tree.root(), agent_xonly, depth), CompileOptions::default())
        .expect("parent compiles");

    let reserved_after = parent_reserved_override.unwrap_or(ch.budget);

    /* The child's identity, and the chain it pushes onto. Computed here rather
       than beside the declared state, because the parent's CONTINUATION must
       be compiled at this reserve root — the address commits the state, so a
       successor compiled at the wrong one is a different address. */
    let cid = child_id(
        child_key,
        ch.budget,
        ch.max_per_spend,
        ch.epoch_limit,
        1_000,
        ch.root.unwrap_or(tree.root()),
        ch.not_before,
        ch.expires_at,
        ch.delegation_depth,
    );
    let pushed = push_child(empty_reserve(), cid);

    // Parent continuation: same authority, reserved advanced, chain pushed.
    let parent_next = compile_contract(
        SOURCE,
        &ctor_at_state_with_reserve(tree.root(), agent_xonly, depth, 0, reserved_after, 0, 0, pushed),
        CompileOptions::default(),
    )
    .expect("parent successor compiles");

    let child_contract = compile_contract(SOURCE, &child_ctor(tree.root(), child_key, ch, depth), CompileOptions::default())
        .expect("child compiles");

    let mut parent_fields = authority_fields(tree.root(), agent_xonly);
    parent_fields.push(("spentTotal", Expr::int(0)));
    parent_fields.push(("reserved", Expr::int(reserved_after)));
    parent_fields.push(("epochIndex", Expr::int(0)));
    parent_fields.push(("epochSpent", Expr::int(0)));
    /* A delegation MOVES this. The covenant requires exactly
           parentNext.reserveRoot == blake2bWithKey(reserveRoot || childId, "WardaReserve")
       so leaving it at the empty chain is not "close enough" — it is the
       difference between a delegation the engine accepts and one it refuses
       for a reason it will not name. */
    parent_fields.push(("reserveRoot", Expr::bytes(pushed.to_vec())));
    let parent_next_state = struct_object("State", parent_fields);

    // `State[]` needs an explicit TypeRef — inferred_array cannot derive a
    // custom struct element type from struct literals.
    let new_states = Expr::array(
        TypeRef { base: TypeBase::Custom("State".to_string()), array_dims: vec![ArrayDim::Dynamic] },
        vec![parent_next_state, child_state(tree.root(), child_key, ch)],
    );

    let in_value: u64 = 10_000_000_000;
    let build = |sig: Vec<u8>| {
        /* v4 added the subset witness, so delegate takes four arguments after
           the injected prevState, not two. An EMPTY witness is not a
           placeholder: it is the statement "this child inherits the parent's
           allowlist exactly", which is what every test here except the
           widening one intends. A child claiming a different root with an
           empty witness is precisely what the covenant must refuse, so
           delegate_child_widening_allowlist_rejected is now testing its own
           rule rather than an arity error. */
        let args = vec![
            new_states.clone(),
            byte32_array(vec![]),
            bool_array(vec![]),
            Expr::bytes(sig),
        ];
        Transaction::new(
            1,
            vec![tx_input(0, sigscript(&parent, "delegate", args))],
            vec![
                TransactionOutput {
                    // Saturating: a hostile child budget can exceed the input
                    // value, and the test harness must produce a transaction
                    // for the ENGINE to reject rather than panicking itself.
                    value: in_value
                        .saturating_sub(ch.budget.max(0) as u64)
                        .saturating_sub(1_000),
                    script_public_key: pay_to_script_hash_script(&parent_next.bytecode),
                    covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
                },
                TransactionOutput {
                    value: ch.budget.max(0) as u64,
                    script_public_key: pay_to_script_hash_script(&child_contract.bytecode),
                    covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
                },
            ],
            0,
            Default::default(),
            0,
            vec![],
        )
    };

    let entries = vec![covenant_utxo(&parent, in_value)];
    let sig = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &kp);
    execute(build(sig), entries, 0)
}

// --- CONSERVATION. The spec's strongest structural claim. ---

// ---------------------------------------------------------------------------
// COMPUTE BUDGET — the last unmeasured claim in the project.
//
// Script SIZE turned out to be a non-issue: MAX_SCRIPTS_SIZE_POST_TOCCATA is
// 1,000,000 bytes and the covenant is ~3.3KB. The real limits are the 244-slot
// stack and the per-input compute budget, which is a u16 (max 65,535 units).
// ---------------------------------------------------------------------------

pub fn measure_units(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> (Result<(), TxScriptError>, u64) {
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[input_idx].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).expect("covenant ctx");
    let utxo = populated.utxo(input_idx).expect("utxo");
    let mut vm = TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        input_idx,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx),
        EngineFlags { covenants_enabled: true, sigop_script_units: 0.into() },
    );
    let r = vm.execute();
    let used = vm.used_script_units().0;
    (r, used)
}

// ---------------------------------------------------------------------------
// SIGNING — is covenant data actually in the digest?
//
// KOM bug #3 reported that WASM's signer omitted covenant data, making it
// unable to sign covenant transactions. At rusty-kaspa rev a41a333 there is no
// separate client implementation left to diverge: consensus/client/src/sign.rs
// calls consensus-core's `calc_schnorr_signature_hash`, and that hashes the
// covenant binding — gated on `version >= 1`.
//
// Comparing the two code paths would be tautological now that they are one
// function. So this reproduces the FAILURE instead: sign a digest computed
// with the covenant binding stripped, attach it to the real transaction, and
// require the engine to reject it. That proves the data is load-bearing rather
// than merely present in the source.
// ---------------------------------------------------------------------------

/// `tx` with every output's covenant binding removed — exactly what an
/// omitting signer would hash.
pub fn strip_covenants(tx: &Transaction) -> Transaction {
    Transaction::new(
        tx.version,
        tx.inputs.clone(),
        tx.outputs
            .iter()
            .map(|o| TransactionOutput {
                value: o.value,
                script_public_key: o.script_public_key.clone(),
                covenant: None,
            })
            .collect(),
        tx.lock_time,
        tx.subnetwork_id.clone(),
        tx.gas,
        tx.payload.clone(),
    )
}
