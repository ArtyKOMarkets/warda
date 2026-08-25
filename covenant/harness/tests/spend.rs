//! Warda spend covenant — execution proof.
//!
//! Compiles warda_grant.sil and runs it through `TxScriptEngine`, the SAME
//! engine a Kaspa node uses to validate a transaction. No node, no RPC, no
//! testnet round-trip: a verdict in milliseconds.
//!
//! @warda/core proves the SEMANTICS. This proves the BYTECODE. Between them
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

const COV: Hash = Hash::from_bytes(*b"WARDAWARDAWARDAWARDAWARDAWARDAWA");
const SOURCE: &str = include_str!("../../warda_grant.sil");

fn ctor(max_proof_depth: i64) -> Vec<Expr<'static>> {
    vec![
        Expr::bytes(vec![0x22; 32]),      // agentKey
        Expr::bytes(vec![0x11; 32]),      // principalKey
        Expr::bytes(vec![0x44; 32]),      // revocationKey
        Expr::int(10_000_000_000),        // budgetTotal   100 KAS
        Expr::int(200_000_000),           // maxPerSpend     2 KAS
        Expr::int(1_000_000_000),         // epochLimit     10 KAS
        Expr::int(1_000),                 // epochLength
        Expr::bytes(vec![0x13; 32]),      // recipientsRoot
        Expr::int(1_000_000),             // notBefore
        Expr::int(1_007_000),             // expiresAt
        Expr::int(100_000),               // maxFee
        Expr::int(max_proof_depth),
        Expr::int(0),                     // spentTotal
        Expr::int(0),                     // reserved
        Expr::int(0),                     // epochIndex
        Expr::int(0),                     // epochSpent
    ]
}

fn compile(max_proof_depth: i64) -> CompiledContract<'static> {
    compile_contract(SOURCE, &ctor(max_proof_depth), CompileOptions::default())
        .expect("warda_grant.sil compiles")
}

fn push_redeem_script(bytecode: &[u8]) -> Vec<u8> {
    ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() })
        .add_data(bytecode)
        .expect("push redeem script")
        .drain()
}

/// Plain `entry` functions (revoke, reclaim) use build_sig_script.
/// `#[covenant]`-annotated policy functions use the covenant-decl builder
/// below — passing a plain entry to that one panics.
fn plain_sigscript(compiled: &CompiledContract<'_>, function: &str, args: Vec<Expr<'_>>) -> Vec<u8> {
    let mut s = compiled.build_sig_script(function, args).expect("build sig script");
    s.extend_from_slice(&push_redeem_script(&compiled.bytecode));
    s
}

#[allow(dead_code)]
fn sigscript(compiled: &CompiledContract<'_>, function: &str, args: Vec<Expr<'_>>) -> Vec<u8> {
    let mut s = compiled
        .build_sig_script_for_covenant_decl(function, args, CovenantDeclCallOptions { is_leader: false })
        .expect("build covenant declaration sigscript");
    s.extend_from_slice(&push_redeem_script(&compiled.bytecode));
    s
}

fn covenant_utxo(compiled: &CompiledContract<'_>, value: u64) -> UtxoEntry {
    UtxoEntry::new(value, pay_to_script_hash_script(&compiled.bytecode), 0, false, Some(COV))
}

/// KOM bug #5, made structural: `TransactionInput::new` sets a SigopCount
/// commit, which is the WRONG commit kind for a v1 covenant input. The obvious
/// constructor is the wrong one. Always `new_with_compute_budget` here.
fn tx_input(index: u32, signature_script: Vec<u8>) -> TransactionInput {
    TransactionInput::new_with_compute_budget(
        TransactionOutpoint { transaction_id: TransactionId::from_bytes([index as u8 + 1; 32]), index },
        signature_script,
        0,
        1000,
    )
}

fn continuation_output(compiled: &CompiledContract<'_>, value: u64) -> TransactionOutput {
    TransactionOutput {
        value,
        script_public_key: pay_to_script_hash_script(&compiled.bytecode),
        covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
    }
}

fn payment_output(value: u64) -> TransactionOutput {
    TransactionOutput { value, script_public_key: ScriptPublicKey::new(0, vec![OpTrue].into()), covenant: None }
}

fn execute(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> Result<(), TxScriptError> {
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

#[test]
fn covenant_compiles_and_exposes_expected_abi() {
    let c = compile(16);
    let names: Vec<_> = c.abi.iter().map(|e| e.name.clone()).collect();
    println!("bytecode = {} bytes", c.bytecode.len());
    println!("abi = {names:?}");
    assert!(names.iter().any(|n| n.contains("spend")), "spend entrypoint present");
    assert!(names.iter().any(|n| n == "revoke"));
    assert!(names.iter().any(|n| n == "reclaim"));
    // Guard against silent bloat: depth 16 measured at 1,988 bytes.
    assert!(c.bytecode.len() < 2_500, "bytecode grew unexpectedly: {}", c.bytecode.len());
}

#[test]
fn scaffolding_executes_against_the_node_engine() {
    // Smoke test for the harness itself: build a transaction and run it through
    // the engine. We assert only that we reach a real script verdict rather
    // than a construction panic — the spend-path vectors come next, and this
    // proves the plumbing before they do.
    let c = compile(4);
    let script = plain_sigscript(&c, "reclaim", vec![Expr::bytes(vec![0u8; 65])]);
    let tx = Transaction::new(
        1,
        vec![tx_input(0, script)],
        vec![continuation_output(&c, 1_000), payment_output(200)],
        0,
        Default::default(),
        0,
        vec![],
    );
    let result = execute(tx, vec![covenant_utxo(&c, 1_500)], 0);
    println!("engine verdict: {result:?}");
    // reclaim requires tx.daa >= expiresAt and a valid principal signature, so
    // a rejection here is CORRECT. What matters is that the engine ran.
    assert!(result.is_err(), "unsigned reclaim before expiry must not pass");
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
fn byte32_array(items: Vec<[u8; 32]>) -> Expr<'static> {
    Expr::array(
        TypeRef { base: TypeBase::Byte, array_dims: vec![ArrayDim::Fixed(32), ArrayDim::Dynamic] },
        items.into_iter().map(|b| Expr::bytes(b.to_vec())).collect(),
    )
}

fn bool_array(items: Vec<bool>) -> Expr<'static> {
    Expr::array(
        TypeRef { base: TypeBase::Bool, array_dims: vec![ArrayDim::Dynamic] },
        items.into_iter().map(Expr::bool).collect(),
    )
}

const KAS: i64 = 100_000_000;

fn state(spent: i64, reserved: i64, epoch_index: i64, epoch_spent: i64) -> Expr<'static> {
    struct_object(
        "State",
        vec![
            ("spentTotal", Expr::int(spent)),
            ("reserved", Expr::int(reserved)),
            ("epochIndex", Expr::int(epoch_index)),
            ("epochSpent", Expr::int(epoch_spent)),
        ],
    )
}

/// Build a spend attempt. The Merkle proof is deliberately a single dummy
/// sibling: every guard we exercise here fires before the proof is checked,
/// so a real proof would not change the verdict — and pretending otherwise
/// would make these tests prove less than they appear to.
fn spend_attempt(c: &CompiledContract<'_>, amount: i64, claimed_daa: i64, new_state: Expr<'static>) -> Vec<u8> {
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

fn run_spend(c: &CompiledContract<'_>, amount: i64, claimed_daa: i64, new_state: Expr<'static>) -> Result<(), TxScriptError> {
    run_spend_with_locktime(c, amount, claimed_daa, new_state, claimed_daa.max(0) as u64)
}

fn run_spend_with_locktime(
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

#[test]
fn attack_overspend_is_rejected() {
    let c = compile(4);
    // maxPerSpend is 2 KAS. Ask for 20 — the prompt-injection scenario.
    let over = run_spend(&c, 20 * KAS, 1_000_500, state(20 * KAS, 0, 0, 20 * KAS));
    println!("overspend  -> {over:?}");
    assert!(over.is_err(), "20 KAS against a 2 KAS per-spend cap must not pass");
}

#[test]
fn attack_zero_amount_is_rejected() {
    let c = compile(4);
    let zero = run_spend(&c, 0, 1_000_500, state(0, 0, 0, 0));
    println!("zero       -> {zero:?}");
    assert!(zero.is_err(), "non-positive amount must not pass");
}

#[test]
fn attack_before_not_before_is_rejected() {
    let c = compile(4);
    // notBefore is 1_000_000. Claim an earlier DAA.
    let early = run_spend(&c, KAS / 2, 999_999, state(KAS / 2, 0, 0, KAS / 2));
    println!("too early  -> {early:?}");
    assert!(early.is_err(), "spend before not_before must not pass");
}

/// KNOWN LIMITATION, recorded so nobody mistakes these tests for more than
/// they are: the engine collapses EVERY failed `require` into one opaque
/// `VerifyError`. It never says which rule rejected.
///
/// So "assert it was rejected" cannot, on its own, prove a specific guard
/// works — a malformed sigscript would produce the same verdict as a working
/// per-spend cap. Two ways to close that gap:
///
///   1. this test — arrange for a DISTINGUISHABLE failure downstream, so an
///      over-limit spend and an in-limit spend fail at provably different
///      points;
///   2. a valid happy path that flips to rejection when one field changes.
///      That needs a real Merkle proof and a covenant-aware Rust signature,
///      and is the next piece of work.
///
/// Until (2) exists, treat every `is_err()` below as "the covenant rejected
/// this", never as "the covenant rejected this FOR THE STATED REASON".
#[test]
fn per_spend_cap_fires_before_the_daa_lock() {
    let c = compile(4);
    // lock_time deliberately 0, so an otherwise-valid spend fails at CLTV with
    // a NAMED error. An over-limit spend never gets that far: its require()
    // fires first and yields VerifyError. Different verdicts, same transaction
    // shape, one field changed — that is what makes the guard provable.
    let over = run_spend_with_locktime(&c, 20 * KAS, 1_000_500, state(20 * KAS, 0, 0, 20 * KAS), 0);
    let within = run_spend_with_locktime(&c, KAS / 2, 1_000_500, state(KAS / 2, 0, 0, KAS / 2), 0);

    println!("over-limit  (locktime 0) -> {over:?}");
    println!("within-limit(locktime 0) -> {within:?}");

    assert!(matches!(over, Err(TxScriptError::VerifyError)), "over-limit must die at a require()");
    assert!(
        matches!(within, Err(TxScriptError::UnsatisfiedLockTime(_))),
        "an in-limit spend must clear every amount guard and reach the DAA lock"
    );
}
