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

/// v2 constructor order. Authority is now GENESIS values for state fields,
/// not immutable params — see DELEGATION.md for why that had to change.
fn ctor(max_proof_depth: i64) -> Vec<Expr<'static>> {
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
        Expr::int(max_proof_depth),       // 12 maxProofDepth
        Expr::int(0),                     // 13 initSpentTotal
        Expr::int(0),                     // 14 initReserved
        Expr::int(0),                     // 15 initEpochIndex
        Expr::int(0),                     // 16 initEpochSpent
    ]
}

/// The authority half of State, constant across every spend. `spend` asserts
/// each of these is unchanged in the successor — without that an agent
/// rewrites its own cap and every limit becomes decorative.
fn authority_fields(root: [u8; 32], agent_xonly: [u8; 32]) -> Vec<(&'static str, Expr<'static>)> {
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

/// Full State: nine authority fields plus four accounting fields, in
/// declaration order. The authority half must match the contract instance
/// exactly or the successor comparison fails for the wrong reason.
fn state_full(
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
    struct_object("State", fields)
}

/// Default-instance shorthand, matching `ctor()`'s genesis values.
fn state(spent: i64, reserved: i64, epoch_index: i64, epoch_spent: i64) -> Expr<'static> {
    state_full([0x13; 32], [0x22; 32], spent, reserved, epoch_index, epoch_spent)
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

// ---------------------------------------------------------------------------
// Recipient allowlist — a real Merkle proof.
//
// OpBlake2b is `blake2b_simd::Params::new().hash_length(32)`: plain
// BLAKE2b-256, unkeyed, no personalization. Anything else here silently
// produces a root the covenant will never match.
// ---------------------------------------------------------------------------

// Non-zero on purpose — 0x00 compiles to an empty push in Kaspa script and the
// domain separation vanishes. Must match warda_grant.sil exactly.
const LEAF: u8 = 0x01;
const NODE: u8 = 0x02;

fn b2b(parts: &[&[u8]]) -> [u8; 32] {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    for p in parts {
        state.update(p);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(state.finalize().as_bytes());
    out
}

fn leaf_hash(recipient: &[u8; 32]) -> [u8; 32] {
    b2b(&[&[LEAF], recipient])
}

/// Mirrors RecipientSet in @warda/core: domain-separated leaves and nodes,
/// odd nodes promoted rather than duplicated, canonical sort.
struct Tree {
    levels: Vec<Vec<[u8; 32]>>,
    members: Vec<[u8; 32]>,
}

impl Tree {
    fn new(mut members: Vec<[u8; 32]>) -> Self {
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

    fn root(&self) -> [u8; 32] {
        self.levels.last().unwrap()[0]
    }

    /// (siblings, is_left) — side travels per-sibling because promotion skips
    /// a level and index parity alone desynchronises.
    fn proof(&self, recipient: &[u8; 32]) -> (Vec<[u8; 32]>, Vec<bool>) {
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

#[test]
fn merkle_root_matches_between_rust_and_the_covenant() {
    // Four recipients, so no promotion edge case in the tree itself.
    let members: Vec<[u8; 32]> = vec![[0xa1; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]];
    let tree = Tree::new(members.clone());
    let (sibs, lefts) = tree.proof(&[0xa1; 32]);

    // Recompute the fold exactly as the covenant does, to confirm the Rust
    // side agrees with itself before asking the engine.
    let mut node = leaf_hash(&[0xa1; 32]);
    for (s, is_left) in sibs.iter().zip(lefts.iter()) {
        node = if *is_left { b2b(&[&[NODE], s, &node]) } else { b2b(&[&[NODE], &node, s]) };
    }
    assert_eq!(node, tree.root(), "rust fold must reproduce the root");
    println!("root = {}", hex(&tree.root()));
    println!("proof depth = {}", sibs.len());
}

fn hex(b: &[u8]) -> String {
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

fn agent_keypair() -> Keypair {
    let secp = Secp256k1::new();
    Keypair::from_seckey_slice(&secp, &[0x42u8; 32]).expect("valid secret key")
}

/// 64-byte schnorr signature + the SIG_HASH_ALL byte = 65. Anything else is
/// rejected as a type mismatch before it ever reaches the engine.
fn sign_input(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize, kp: &Keypair) -> Vec<u8> {
    let mtx = MutableTransaction::with_entries(tx, entries);
    let reused = SigHashReusedValuesUnsync::new();
    let sig_hash = calc_schnorr_signature_hash(&mtx.as_verifiable(), input_idx, SIG_HASH_ALL, &reused);
    let msg = secp256k1::Message::from_digest_slice(sig_hash.as_bytes().as_slice()).expect("sighash");
    let mut sig = kp.sign_schnorr(msg).as_ref().to_vec();
    sig.push(SIG_HASH_ALL.to_u8());
    sig
}

fn ctor_with(root: [u8; 32], agent_xonly: [u8; 32], depth: i64) -> Vec<Expr<'static>> {
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
fn ctor_at_state(
    root: [u8; 32],
    agent_xonly: [u8; 32],
    depth: i64,
    spent: i64,
    reserved: i64,
    epoch_index: i64,
    epoch_spent: i64,
) -> Vec<Expr<'static>> {
    let mut v = ctor_with(root, agent_xonly, depth);
    v[13] = Expr::int(spent);
    v[14] = Expr::int(reserved);
    v[15] = Expr::int(epoch_index);
    v[16] = Expr::int(epoch_spent);
    v
}

#[test]
fn happy_path_spend_is_accepted_by_the_engine() {
    let kp = agent_keypair();
    let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();

    let members: Vec<[u8; 32]> = vec![[0xa1; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]];
    let tree = Tree::new(members);
    let recipient = [0xa1u8; 32];
    let (sibs, lefts) = tree.proof(&recipient);

    let c = compile_contract(SOURCE, &ctor_with(tree.root(), agent_xonly, 4), CompileOptions::default())
        .expect("compiles with real root");

    let amount: i64 = KAS / 2; // 0.5 KAS, inside the 2 KAS per-spend cap
    let claimed_daa: i64 = 1_000_500;
    let in_value: u64 = 10_000_000_000; // 100 KAS, matching budgetTotal

    // Kaspa P2PK is 34 bytes: 0x20 push, 32-byte x-only pubkey, 0xac OpCheckSig.
    // The covenant builds this itself via `new ScriptPubKeyP2PK(pubkey(recipient))`
    // and compares byte-for-byte, so an OpTrue placeholder output cannot pass.
    let mut p2pk = vec![0x20u8];
    p2pk.extend_from_slice(&recipient);
    p2pk.push(0xac);
    let pay_out = TransactionOutput {
        value: amount as u64,
        script_public_key: ScriptPublicKey::new(0, p2pk.clone().into()),
        covenant: None,
    };

    // The successor lives at a DIFFERENT address — one encoding the new state.
    let successor = compile_contract(
        SOURCE,
        &ctor_at_state(tree.root(), agent_xonly, 4, amount, 0, 0, amount),
        CompileOptions::default(),
    )
    .expect("successor compiles");
    let successor_spk = pay_to_script_hash_script(&successor.bytecode);

    let build = |sig: Vec<u8>| {
        let args = vec![
            state_full(tree.root(), agent_xonly, amount, 0, 0, amount),
            Expr::int(amount),
            Expr::bytes(recipient.to_vec()),
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
                    value: in_value - amount as u64 - 1_000,
                    script_public_key: successor_spk.clone(),
                    covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
                },
                pay_out.clone(),
            ],
            claimed_daa as u64,
            Default::default(),
            0,
            vec![],
        )
    };

    // Sighash covers transaction structure, not signature scripts, so a
    // placeholder sig yields the same hash as the real one.
    let entries = vec![covenant_utxo(&c, in_value)];
    let sig = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &kp);
    let (verdict, trace) = execute_traced(build(sig), entries, 0);

    println!("happy path -> {verdict:?}");
    if false {
        let lines: Vec<&str> = trace.lines().collect();
        println!("--- last 12 opcodes before failure ---");
        for l in lines.iter().rev().take(2).rev() {
            println!("{}", l);
        }
    }
    assert!(verdict.is_ok(), "a fully valid spend must be ACCEPTED, got {verdict:?}");
}

/// Same as `execute`, but captures a per-opcode trace. The engine has this
/// built in via `with_opcode_execution_log_buffer` — no need to patch
/// rusty-kaspa locally the way KOM had to.
fn execute_traced(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> (Result<(), TxScriptError>, String) {
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


/// THE demo. A valid spend, with exactly one field changed: the payee.
///
/// This is the flip test the whole harness was built to make possible. The
/// baseline is ACCEPTED, so a rejection here can only be caused by the changed
/// field — which is what upgrades "the covenant refused it" into "the covenant
/// refused it because the recipient is not on the allowlist".
#[test]
fn prompt_injection_to_an_unlisted_recipient_is_rejected() {
    let kp = agent_keypair();
    let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
    let members: Vec<[u8; 32]> = vec![[0xa1; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]];
    let tree = Tree::new(members);
    let attacker = [0xeeu8; 32]; // not in the tree

    let c = compile_contract(SOURCE, &ctor_with(tree.root(), agent_xonly, 4), CompileOptions::default())
        .expect("compiles");

    let amount: i64 = KAS / 2;
    let claimed_daa: i64 = 1_000_500;
    let in_value: u64 = 10_000_000_000;

    let successor = compile_contract(
        SOURCE,
        &ctor_at_state(tree.root(), agent_xonly, 4, amount, 0, 0, amount),
        CompileOptions::default(),
    )
    .expect("successor compiles");

    // The agent genuinely attempts the payment. It is not filtered, sandboxed
    // or flagged — it builds the transaction and signs it. There is simply no
    // proof that puts the attacker in the tree, so it borrows a valid one.
    let (sibs, lefts) = tree.proof(&[0xa1; 32]);

    let mut p2pk = vec![0x20u8];
    p2pk.extend_from_slice(&attacker);
    p2pk.push(0xac);

    let build = |sig: Vec<u8>| {
        let args = vec![
            state_full(tree.root(), agent_xonly, amount, 0, 0, amount),
            Expr::int(amount),
            Expr::bytes(attacker.to_vec()),
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
                    value: in_value - amount as u64 - 1_000,
                    script_public_key: pay_to_script_hash_script(&successor.bytecode),
                    covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
                },
                TransactionOutput {
                    value: amount as u64,
                    script_public_key: ScriptPublicKey::new(0, p2pk.clone().into()),
                    covenant: None,
                },
            ],
            claimed_daa as u64,
            Default::default(),
            0,
            vec![],
        )
    };

    let entries = vec![covenant_utxo(&c, in_value)];
    let sig = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &kp);
    let verdict = execute(build(sig), entries, 0);

    println!("prompt injection -> {verdict:?}");
    assert!(verdict.is_err(), "payment to an unlisted recipient must be rejected");
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

struct Spend {
    /// Override the successor's authority half — used to prove the v2
    /// immutability guards. `None` keeps it identical to the instance.
    authority_override: Option<(&'static str, Expr<'static>)>,
    amount: i64,
    recipient: [u8; 32],
    claimed_daa: i64,
    /// Successor state, defaulted from `amount` unless overridden.
    successor: Option<(i64, i64, i64, i64)>,
    pay_to: Option<[u8; 32]>,
}

impl Spend {
    fn valid() -> Self {
        Spend {
            authority_override: None,
            amount: KAS / 2,
            recipient: [0xa1; 32],
            claimed_daa: 1_000_500,
            successor: None,
            pay_to: None,
        }
    }

    fn run(&self) -> Result<(), TxScriptError> {
        let kp = agent_keypair();
        let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
        let tree = Tree::new(vec![[0xa1; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]]);
        let c = compile_contract(SOURCE, &ctor_with(tree.root(), agent_xonly, 4), CompileOptions::default())
            .expect("compiles");

        let (ss, sr, si, se) = self.successor.unwrap_or((self.amount, 0, 0, self.amount));
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

        let in_value: u64 = 10_000_000_000;
        let amount = self.amount;
        let claimed_daa = self.claimed_daa;
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
                        value: in_value - amount.max(0) as u64 - 1_000,
                        script_public_key: pay_to_script_hash_script(&successor.bytecode),
                        covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
                    },
                    TransactionOutput {
                        value: amount.max(1) as u64,
                        script_public_key: ScriptPublicKey::new(0, p2pk.clone().into()),
                        covenant: None,
                    },
                ],
                claimed_daa.max(0) as u64,
                Default::default(),
                0,
                vec![],
            )
        };

        let entries = vec![covenant_utxo(&c, in_value)];
        let sig = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &kp);
        execute(build(sig), entries, 0)
    }
}

#[test]
fn flip_baseline_is_accepted() {
    let v = Spend::valid().run();
    println!("baseline           -> {v:?}");
    assert!(v.is_ok(), "the baseline every flip test depends on must pass: {v:?}");
}

#[test]
fn flip_overspend_rejected() {
    let mut s = Spend::valid();
    s.amount = 20 * KAS; // cap is 2 KAS
    s.successor = Some((20 * KAS, 0, 0, 20 * KAS));
    let r = s.run();
    println!("overspend flip     -> {r:?}");
    assert!(r.is_err(), "20 KAS against a 2 KAS cap must reject");
}

#[test]
fn flip_unlisted_recipient_rejected() {
    let mut s = Spend::valid();
    s.recipient = [0xee; 32]; // not in the allowlist
    let r = s.run();
    println!("unlisted recipient -> {r:?}");
    assert!(r.is_err(), "payment to an unlisted recipient must reject");
}

#[test]
fn flip_successor_budget_not_advanced_rejected() {
    // The load-bearing one: spend the money, do not record the spend.
    let mut s = Spend::valid();
    s.successor = Some((0, 0, 0, 0));
    let r = s.run();
    println!("successor unmoved  -> {r:?}");
    assert!(r.is_err(), "a successor that does not record the spend must reject");
}

#[test]
fn flip_successor_reserved_tampered_rejected() {
    // Named precisely: the baseline has reserved = 0, so there is nothing to
    // "release" here. What this proves is narrower and still worth having —
    // the reserved field cannot be moved independently of the spend. Proving
    // that a delegated reserve cannot be reclaimed needs a delegation first,
    // and that covenant does not exist yet.
    let mut s = Spend::valid();
    s.successor = Some((s.amount, -1_000, 0, s.amount));
    let r = s.run();
    println!("reserved tampered  -> {r:?}");
    assert!(r.is_err(), "the reserved field must not move independently of the spend");
}

#[test]
fn flip_payment_diverted_to_attacker_rejected() {
    // Proof and recipient field are for an allowlisted API, but the money
    // actually goes somewhere else.
    let mut s = Spend::valid();
    s.pay_to = Some([0xee; 32]);
    let r = s.run();
    println!("payment diverted   -> {r:?}");
    assert!(r.is_err(), "paying an address other than the named recipient must reject");
}


// ---------------------------------------------------------------------------
// v2 only: authority now lives in State, so it CAN be tampered with. These
// prove the nine immutability guards that the move made necessary. Under v1
// these attacks were impossible by construction; under v2 they are impossible
// only because the covenant checks.
// ---------------------------------------------------------------------------

#[test]
fn flip_agent_raises_its_own_per_spend_cap_rejected() {
    // The attack the v2 architecture creates: spend a legal amount, but write
    // a HIGHER cap into the successor so the next spend can be larger.
    let mut s = Spend::valid();
    s.authority_override = Some(("maxPerSpend", Expr::int(100 * KAS)));
    let r = s.run();
    println!("cap raised         -> {r:?}");
    assert!(r.is_err(), "an agent must not rewrite its own per-spend cap");
}

#[test]
fn flip_agent_widens_its_own_allowlist_rejected() {
    let mut s = Spend::valid();
    s.authority_override = Some(("recipientsRoot", Expr::bytes(vec![0xee; 32])));
    let r = s.run();
    println!("allowlist swapped  -> {r:?}");
    assert!(r.is_err(), "an agent must not swap its own recipient root");
}

#[test]
fn flip_agent_extends_its_own_expiry_rejected() {
    let mut s = Spend::valid();
    s.authority_override = Some(("expiresAt", Expr::int(9_999_999)));
    let r = s.run();
    println!("expiry extended    -> {r:?}");
    assert!(r.is_err(), "an agent must not extend its own expiry");
}

#[test]
fn flip_agent_inflates_its_own_budget_rejected() {
    let mut s = Spend::valid();
    s.authority_override = Some(("budgetTotal", Expr::int(1_000_000_000_000)));
    let r = s.run();
    println!("budget inflated    -> {r:?}");
    assert!(r.is_err(), "an agent must not inflate its own total budget");
}
