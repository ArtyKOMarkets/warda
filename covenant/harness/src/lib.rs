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

/// C1's working draft: v4 plus `delegate2`. Not audited, not deployed, and no
/// grant runs it — it is here so the probes can drive it. See covenant/V5.md.
pub const SOURCE_V5: &str = include_str!("../../warda_grant_v5.sil");

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
/// Both keys the template hash covers. The id is a property of the PAIR:
/// `principalKey` and `revocationKey` are constructor constants compiled into
/// the suffix, so a function taking only one of them cannot be correct. That
/// was vulnerability 4, and making it unrepresentable is the fix.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Authority {
    pub principal: [u8; 32],
    pub revocation: [u8; 32],
}

impl Authority {
    pub fn new(principal: [u8; 32], revocation: [u8; 32]) -> Self { Self { principal, revocation } }
}

/// The authority the spend and delegate suites compile against: two distinct
/// constants, so anything keyed on the pair cannot accidentally pass with one.
pub fn default_authority() -> Authority { Authority::new([0x11; 32], [0x44; 32]) }

pub fn ctor(max_proof_depth: i64) -> Vec<Expr<'static>> {
    ctor_full(max_proof_depth, default_authority(), template_id_for(default_authority()), template_geometry())
}

#[allow(clippy::needless_range_loop)]
pub fn ctor_full(max_proof_depth: i64, authority: Authority, template_id: [u8; 32], geometry: (i64, i64)) -> Vec<Expr<'static>> {
    vec![
        Expr::bytes(authority.principal.to_vec()),  //  0 principalKey
        Expr::bytes(authority.revocation.to_vec()), //  1 revocationKey
        Expr::int(100_000),               //  2 maxFee
        Expr::bytes(vec![0x22; 32]),      //  3 genesisAgentKey
        // One source for the shape, not three. These were literals, and the
        // same seven numbers appeared again in the constants below and a
        // third time in `authority_fields` — a triplication that survived
        // only because nobody ever changed the shape, which was itself the
        // reason nobody ever changed it.
        Expr::int(budget_total()),        //  4 genesisBudgetTotal
        Expr::int(max_per_spend()),       //  5 genesisMaxPerSpend
        Expr::int(epoch_limit()),         //  6 genesisEpochLimit
        Expr::int(epoch_length()),        //  7 genesisEpochLength
        Expr::bytes(vec![0x13; 32]),      //  8 genesisRecipientsRoot
        Expr::int(not_before()),          //  9 genesisNotBefore
        Expr::int(expires_at()),          // 10 genesisExpiresAt
        Expr::int(delegation_depth()),    // 11 genesisDelegationDepth
        // A wrong templateId is not a compile error and not a security hole:
        // the covenant's own comment says it simply yields a different address,
        // one nobody funded. Only the splice path reads it, and nothing here
        // exercises that path yet.
        Expr::bytes(template_id.to_vec()),          // 12 genesisTemplateId
        // Geometry. These are LENGTHS, and the deploy tool derives them from
        // the compiled size by iterating to a fixed point. They must stay small
        // and plausible: a large value lands in a for-loop bound and the
        // compiler refuses it far from where the mistake was made.
        Expr::int(geometry.0),                      // 13 templatePrefixLen
        Expr::int(geometry.1),                      // 14 templateSuffixLen
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
    authority_fields_of(SOURCE, root, agent_xonly)
}

/// The same, for a source that is not `SOURCE`.
///
/// `templateId` is the one field here that is not a constant: it is a hash
/// over the compiled prefix and suffix, so it moves when the source does. The
/// covenant requires `parentNext.templateId == templateId`, comparing this
/// DECLARED value against the one baked into the running bytecode — so a
/// mutant run declaring SOURCE's hash is refused for the template rather than
/// for the rule under test, and the mutant comes back looking clean. A mutant
/// that cannot fire is the one failure this whole approach cannot survive.
pub fn authority_fields_of(
    src: &'static str,
    root: [u8; 32],
    agent_xonly: [u8; 32],
) -> Vec<(&'static str, Expr<'static>)> {
    vec![
        ("agentKey", Expr::bytes(agent_xonly.to_vec())),
        ("budgetTotal", Expr::int(budget_total())),
        ("maxPerSpend", Expr::int(max_per_spend())),
        ("epochLimit", Expr::int(epoch_limit())),
        ("epochLength", Expr::int(epoch_length())),
        ("recipientsRoot", Expr::bytes(root.to_vec())),
        ("notBefore", Expr::int(not_before())),
        ("expiresAt", Expr::int(expires_at())),
        ("delegationDepth", Expr::int(delegation_depth())),
        // v4. Authority, not accounting: `spend` asserts it unchanged, so it
        // must equal ctor slot 12 or every successor is a different grant.
        ("templateId", Expr::bytes(template_id_of(src, default_authority()).to_vec())),
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

    /// The witness a child supplies to claim an INTERIOR node as its own
    /// allowlist root: the node, then the siblings from it up to this tree's
    /// root, with a side per sibling.
    ///
    /// `proof` is this walk started at level 0. Sharing the loop rather than
    /// writing a second one is deliberate: promotion (an odd node carried up
    /// without a partner) pushes no sibling but still halves the index, and
    /// two copies of that rule is two chances to get the subset case subtly
    /// right and the leaf case subtly wrong.
    ///
    /// `level` 0 is the leaf hashes, so `node_witness(0, i)` is how a child
    /// narrows to the single member at sorted position `i`. The top level is
    /// the root itself, whose witness is empty — which is the inherit case,
    /// and the covenant checks it with the same fold.
    pub fn node_witness(&self, level: usize, idx: usize) -> ([u8; 32], Vec<[u8; 32]>, Vec<bool>) {
        let node = self.levels[level][idx];
        let (mut sibs, mut lefts) = (Vec::new(), Vec::new());
        let mut i = idx;
        for l in &self.levels[level..self.levels.len() - 1] {
            let pair = if i % 2 == 0 { i + 1 } else { i - 1 };
            if pair < l.len() {
                sibs.push(l[pair]);
                lefts.push(pair < i);
            }
            i /= 2;
        }
        (node, sibs, lefts)
    }

    /// The members beneath `levels[level][idx]` — what a child narrowed to
    /// that node may actually pay. Used to assert that narrowing narrowed.
    pub fn leaves_under(&self, level: usize, idx: usize) -> Vec<[u8; 32]> {
        let span = 1usize << level;
        let start = idx * span;
        self.members[start.min(self.members.len())..(start + span).min(self.members.len())].to_vec()
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

/// The grant every attempt below is built against.
///
/// These were `pub const`, and the same seven numbers were written out twice
/// more — once as literals in `ctor_full`, once again in `authority_fields`.
/// Three copies of one shape, which held only because nobody had ever changed
/// it. That is also WHY nobody had: changing it meant editing the instrument
/// in three places and hoping.
///
/// `AUDIT.md`'s "what this run did not test" names the consequence directly:
/// *"One grant shape per run. Every case here runs against a single
/// parameterisation — 100 KAS, a 2 KAS per-spend cap, delegation depth 2 […]
/// Whether the same boundaries hold at another shape — a one-sompi budget, a
/// different delegation depth — is untested by this run."*
///
/// Now there is one copy, and it is an environment variable:
///
/// ```text
/// WARDA_BUDGET=1 WARDA_MAX_PER_SPEND=1 cargo run --bin audit
/// ```
///
/// Functions rather than constants, which costs every call site a pair of
/// brackets and buys the ability to ask the question at all.
fn env_i64(name: &str, fallback: i64) -> i64 {
    std::env::var(name).ok().and_then(|s| s.parse().ok()).unwrap_or(fallback)
}

pub fn budget_total() -> i64 {
    env_i64("WARDA_BUDGET", 10_000_000_000) // 100 KAS
}
pub fn max_per_spend() -> i64 {
    env_i64("WARDA_MAX_PER_SPEND", 200_000_000) // 2 KAS
}
pub fn epoch_limit() -> i64 {
    env_i64("WARDA_EPOCH_LIMIT", 1_000_000_000) // 10 KAS
}
pub fn epoch_length() -> i64 {
    env_i64("WARDA_EPOCH_LENGTH", 1_000)
}
pub fn not_before() -> i64 {
    env_i64("WARDA_NOT_BEFORE", 1_000_000)
}
pub fn expires_at() -> i64 {
    env_i64("WARDA_EXPIRES_AT", 1_007_000)
}
pub fn delegation_depth() -> i64 {
    env_i64("WARDA_DELEGATION_DEPTH", 2)
}

/// A DAA score inside epoch `e`, whatever an epoch currently is.
///
/// Every case that says "an earlier epoch" or "a later epoch" means a position
/// relative to `epochLength`, and writing that as a fixed DAA offset only
/// works at one length. Half an epoch in, so a case is never sitting on a
/// boundary it did not mean to test.
pub fn mid_epoch(e: i64) -> i64 {
    not_before() + e * epoch_length() + (epoch_length() / 2)
}

/// Every axis of the shape, for a report that has to say which one it ran.
///
/// A suite that does not print its parameterisation is a suite whose numbers
/// cannot be compared to anybody else's — including its own, from last week.
pub fn shape_line() -> String {
    format!(
        "budget {} · cap {} · epoch {} per {} · window {}..{} · depth {} · allowlist {} · proof depth {}",
        budget_total(),
        max_per_spend(),
        epoch_limit(),
        epoch_length(),
        not_before(),
        expires_at(),
        delegation_depth(),
        tree_leaves(),
        proof_depth(),
    )
}

/// The run's shape, overridable from the environment.
///
/// `AUDIT.md`'s own "what this run did not test" named this as its largest
/// hole: *"Any grant shape but one. Every case runs against a single
/// parameterisation - ... a four-member allowlist, maxProofDepth 4. Whether
/// the same boundaries hold at depth 16, or with a 65,536-member tree, ... is
/// untested."* It was untested because the shape was six literals scattered
/// through this file, so re-running at another one meant editing the
/// instrument. Now it is two environment variables, and the report says which
/// it used.
///
///   WARDA_PROOF_DEPTH=16 WARDA_TREE_LEAVES=65536 cargo run --bin audit
pub fn proof_depth() -> i64 {
    std::env::var("WARDA_PROOF_DEPTH").ok().and_then(|s| s.parse().ok()).unwrap_or(4)
}

pub fn tree_leaves() -> usize {
    std::env::var("WARDA_TREE_LEAVES").ok().and_then(|s| s.parse().ok()).unwrap_or(4)
}

/// The allowlist every case is built against.
///
/// The original four are kept, byte for byte and first, because cases name
/// `[0xa1; 32]` as the payee and a run that quietly paid somebody else would
/// be a different audit wearing this one's numbers. Extra members are appended
/// to lengthen the proofs, which is the only thing a bigger tree changes.
pub fn members() -> Vec<[u8; 32]> {
    let mut v = vec![[0xa1u8; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]];
    for i in 4..tree_leaves() {
        let mut m = [0u8; 32];
        m[0] = 0xb0;
        m[24..32].copy_from_slice(&(i as u64).to_be_bytes());
        v.push(m);
    }
    v
}
pub const MAX_FEE: i64 = 100_000;
/// What the grant's own UTXO holds.
///
/// This was a constant, and it was the third thing welded to one shape. A
/// grant whose budget is a thousand times its coin cannot express any case
/// about money: the built transaction saturates, the covenant is handed
/// something the case never meant, and the verdict describes neither. Run the
/// suite at a 10^15 budget with this pinned at 10^10 and it reports a
/// VIOLATION on the delegation budget rule — the covenant accepting a child
/// one sompi larger than the parent had left — which is not true, and is the
/// harness building a transaction whose outputs it silently clamped.
///
/// So the coin follows the budget, which is the relationship a real grant has.
/// The baked fee ceiling every exit is measured against. It is a CONSTRUCTOR
/// argument, not an environment variable, because it is compiled into the
/// bytecode — a different fee is a different script and a different address.
/// That asymmetry is the whole reason `shape_incoherence` below exists.
pub const BAKED_MAX_FEE: i64 = 5_000_000;

/// Why this shape cannot mean anything, if it cannot.
///
/// `covenant/SHAPES.md` already refuses to report four shapes — an epoch
/// longer than the whole window, a per-spend cap of one sompi against cases
/// that pay half a KAS — on the grounds that *"a suite that cannot build one
/// valid transaction at a shape has not tested that shape, whatever its output
/// columns say."* It decided that by hand, by noticing there was no accepted
/// baseline.
///
/// A baseline is not enough. At a 1,000-sompi budget the spend cases fail to
/// build but the DELEGATION baseline is accepted, so the suite runs, and the
/// two exit-conservation cases — "one sompi more than maxFee burned" — report
/// the covenant ACCEPTING what the guarantees forbid. It is arithmetic: maxFee
/// is 5,000,000 and the grant holds 1,000, so "maxFee + 1" is more than the
/// grant has ever been worth and the case cannot express what it means.
///
/// Two violations, in the serious direction, from a shape that is nonsense.
/// The instrument has to say so itself rather than leaving it to whoever reads
/// the table.
pub fn shape_incoherence() -> Option<String> {
    if budget_total() <= BAKED_MAX_FEE {
        return Some(format!(
            "the grant's whole budget ({}) is no more than the baked maxFee ({BAKED_MAX_FEE}). \
             Every conservation case is written as a fee at or around that ceiling, so at this \
             shape they ask about more money than the grant has ever held. maxFee is compiled \
             into the bytecode and cannot follow WARDA_BUDGET: a different fee is a different \
             covenant.",
            budget_total()
        ));
    }
    if max_per_spend() > epoch_limit() {
        return Some(format!(
            "the per-spend cap ({}) is above the epoch allowance ({}). A single payment at the \
             cap would exceed what the whole epoch permits, so the covenant refuses it — \
             correctly — and every case written as \"exactly the cap\" reads as an over-refusal. \
             The two figures move independently as environment variables and a real grant would \
             not be issued this way.",
            max_per_spend(),
            epoch_limit()
        ));
    }
    if epoch_length() > expires_at() - not_before() {
        return Some(format!(
            "an epoch ({}) is longer than the grant's whole window ({}). The ratchet cases have \
             no second epoch to move to.",
            epoch_length(),
            expires_at() - not_before()
        ));
    }
    None
}

/// Is this run at the parameterisation the deployed template was built with?/// Is this run at the parameterisation the deployed template was built with?
///
/// Only one thing needs to ask: a fixture. `covenant/SHAPES.md` exists because
/// evidence at one shape is not evidence, and everything in this harness is
/// free to move — but a golden vector is a claim about a SPECIFIC script that
/// exists on chain, and one emitted at another budget is a file that looks like
/// the real thing and is not. The suites vary; the fixture refuses.
pub fn is_default_shape() -> bool {
    budget_total() == 10_000_000_000
        && max_per_spend() == 200_000_000
        && epoch_limit() == 1_000_000_000
        && epoch_length() == 1_000
        && not_before() == 1_000_000
        && expires_at() == 1_007_000
        && delegation_depth() == 2
        && tree_leaves() == 4
        && proof_depth() == 4
}

pub fn in_value() -> u64 {
    budget_total().max(0) as u64
}

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
    /// The covenant to run against. Only the mutation runs change it.
    pub src: &'static str,
    /// Spend as a NARROWED CHILD rather than as the parent: the allowlist root
    /// the grant was born with, and the inclusion proof this payment offers
    /// against it.
    ///
    /// `None` is the parent's full tree, which is every other case here. `Some`
    /// is what delegation is for — a child narrowed to one payee, or to a
    /// subtree, being asked whether it can still reach the rest of its parent's
    /// allowlist. That question cannot be asked of a single transaction built
    /// from the parent's root, which is why the subset witness went untested
    /// for as long as it did.
    pub allowlist: Option<([u8; 32], Vec<[u8; 32]>, Vec<bool>)>,
}

impl Spend {
    pub fn valid() -> Self {
        Spend {
            authority_override: None,
            amount: KAS / 2,
            recipient: [0xa1; 32],
            /* Inside the first epoch, derived rather than written down.
               1_000_500 is the middle of epoch 0 only while an epoch is 1,000
               DAA long; at WARDA_EPOCH_LENGTH=1 the same number is epoch 500,
               and every case built on it claims a LATER epoch than it means
               to. Three of them then read as the covenant accepting a replayed
               epoch, which is the harness lying about what it built. */
            claimed_daa: mid_epoch(0),
            successor: None,
            pay_to: None,
            prev: (0, 0, 0, 0),
            tx_daa: None,
            extra_fee: 0,
            wrong_key: false,
            src: SOURCE,
            allowlist: None,
        }
    }

    pub fn run(&self) -> Result<(), TxScriptError> {
        let kp = agent_keypair();
        let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
        let tree = Tree::new(members());
        let root = self.allowlist.as_ref().map(|(r, _, _)| *r).unwrap_or(tree.root());
        let (ps, pr, pi, pe) = self.prev;
        let c = compiled(self.src, &ctor_at_state(root, agent_xonly, proof_depth(), ps, pr, pi, pe));

        /* The honest successor, which is what the covenant recomputes for
           itself. An epoch that has moved on resets the epoch spend to this
           payment; an epoch still in progress adds to it. Getting this wrong
           makes every boundary case fail for the successor comparison rather
           than for the rule under test — one opaque VerifyError, a long way
           from the cause. */
        let cur_epoch = (self.claimed_daa - not_before()).div_euclid(epoch_length());
        let honest = if cur_epoch > pi {
            (ps + self.amount, pr, cur_epoch, self.amount)
        } else {
            (ps + self.amount, pr, pi, pe + self.amount)
        };
        let (ss, sr, si, se) = self.successor.unwrap_or(honest);
        let successor = compiled(self.src, &ctor_at_state(root, agent_xonly, proof_depth(), ss, sr, si, se));

        // A recipient outside the tree has no proof; borrowing a valid one is
        // the best an attacker can do, and is exactly what a rogue agent would
        // try.
        let proof_for = if tree.members.contains(&self.recipient) { self.recipient } else { [0xa1; 32] };
        let (sibs, lefts) = match &self.allowlist {
            Some((_, s, l)) => (s.clone(), l.clone()),
            None => tree.proof(&proof_for),
        };

        let payee = self.pay_to.unwrap_or(self.recipient);
        let mut p2pk = vec![0x20u8];
        p2pk.extend_from_slice(&payee);
        p2pk.push(0xac);

        let in_value: u64 = in_value();
        let amount = self.amount;
        let claimed_daa = self.claimed_daa;
        let tx_daa = self.tx_daa.unwrap_or(claimed_daa);
        let extra_fee = self.extra_fee;
        let build = |sig: Vec<u8>| {
            let args = vec![
                {
                    let mut fields = authority_fields(root, agent_xonly);
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
#[derive(Clone)]
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
    /// A child narrower than its parent on every axis — AT WHATEVER SHAPE THE
    /// PARENT HAS.
    ///
    /// This was seven literals: 25 KAS, a 1 KAS cap, depth 1. They are exactly
    /// a quarter, a half and one-less of the DEFAULT parent, and they are
    /// nothing in particular at any other. At `WARDA_DELEGATION_DEPTH=1` a
    /// child of depth 1 is not narrower than its parent at all, so the baseline
    /// was refused and the shape reported nothing; at a budget of 10^15 a
    /// 25-KAS child is not narrower in any interesting sense, merely tiny.
    ///
    /// `covenant/SHAPES.md` names this pattern three times over — *"a
    /// relationship expressed as a literal is a relationship that holds at one
    /// shape"* — and then listed eleven over-refusals at depth 1 as
    /// probably-more-of-the-same. The fractions below produce the identical
    /// seven numbers at the default shape, so nothing about the shipped report
    /// moves, and the depth-1 column stops describing a child that was never
    /// narrower to begin with.
    pub fn narrower() -> Self {
        Child {
            budget: budget_total() / 4,
            max_per_spend: max_per_spend() / 2,
            epoch_limit: epoch_limit() / 2,
            expires_at: expires_at(),
            not_before: not_before(),
            delegation_depth: (delegation_depth() - 1).max(0),
            root: None,
            accounting: (0, 0, 0, 0),
        }
    }
}

pub fn child_state(root: [u8; 32], child_key: [u8; 32], ch: &Child) -> Expr<'static> {
    child_state_of(SOURCE, root, child_key, ch)
}

/// Retarget a constructor vector at another source.
///
/// Slots 12, 13 and 14 are the template hash and the two state-region lengths,
/// and all three are derived FROM THE COMPILED SIZE. A mutant is a different
/// source, so it is a different size, so these are different numbers — and the
/// covenant splices its own bytecode at those offsets to derive the successor
/// address it demands. Carry SOURCE's numbers into a mutant compile and the
/// splice lands in the wrong place: nothing is accepted, the mutant run comes
/// back empty, and an empty mutant run reads as "the oracle cannot fire" when
/// it means "the harness never ran it". That is the worst failure this file
/// has, because it is indistinguishable from a clean result.
pub fn for_source(mut ctor: Vec<Expr<'static>>, src: &'static str) -> Vec<Expr<'static>> {
    let (prefix, suffix) = template_geometry_of(src);
    ctor[12] = Expr::bytes(template_id_of(src, default_authority()).to_vec());
    ctor[13] = Expr::int(prefix);
    ctor[14] = Expr::int(suffix);
    ctor
}

pub fn child_state_of(src: &'static str, root: [u8; 32], child_key: [u8; 32], ch: &Child) -> Expr<'static> {
    let (s, r, ei, es) = ch.accounting;
    struct_object(
        "State",
        vec![
            ("agentKey", Expr::bytes(child_key.to_vec())),
            ("budgetTotal", Expr::int(ch.budget)),
            ("maxPerSpend", Expr::int(ch.max_per_spend)),
            ("epochLimit", Expr::int(ch.epoch_limit)),
            /* The child's epoch is its PARENT's epoch. This was the literal
               1_000 here, in `child_ctor` and in `child_id` — three copies,
               all agreeing with each other and with nothing else once
               WARDA_EPOCH_LENGTH moved. The covenant requires a child no wider
               than its parent, so at every epoch length but the default the
               child was wrong and EVERY delegation was refused: 2, 10 and 100
               all fail, 1,000 passes. The shape matrix's "epoch length 1" row
               was measuring this. */
            ("epochLength", Expr::int(epoch_length())),
            ("recipientsRoot", Expr::bytes(ch.root.unwrap_or(root).to_vec())),
            ("notBefore", Expr::int(ch.not_before)),
            ("expiresAt", Expr::int(ch.expires_at)),
            ("delegationDepth", Expr::int(ch.delegation_depth)),
            ("templateId", Expr::bytes(template_id_of(src, default_authority()).to_vec())),
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
        Expr::int(epoch_length()), // see child_state_of: this was a literal 1_000

        Expr::bytes(ch.root.unwrap_or(root).to_vec()),
        Expr::int(ch.not_before),
        Expr::int(ch.expires_at),
        Expr::int(ch.delegation_depth),
        Expr::bytes(template_id_for(default_authority()).to_vec()), // 12 genesisTemplateId — same template
        Expr::int(template_geometry().0),                           // 13 templatePrefixLen
        Expr::int(template_geometry().1),                           // 14 templateSuffixLen
        Expr::int(depth),              // 15 maxProofDepth  (was 12 in v2)
        Expr::int(s),
        Expr::int(r),
        Expr::int(ei),
        Expr::int(es),
        Expr::bytes(empty_reserve().to_vec()),   // 20 initReserveRoot
    ]
}

/// A delegation, with every lever the published guarantees name.
///
/// `run_delegation` is this with the defaults, kept because the flip tests
/// call it. One implementation: the parent's coin, its prior state and the
/// output count are all things the covenant checks, and a claim nobody can
/// reach is a claim nobody has tested.
pub struct Delegate {
    pub child: Child,
    pub parent_reserved_override: Option<i64>,
    /// What the parent has already spent and reserved. The child's budget is
    /// capped by what is left of those two, which is unreachable from genesis.
    pub parent_prev: (i64, i64),
    /// `outputs[1].value`, when it should not follow `child.budgetTotal`.
    pub coin_override: Option<i64>,
    /// A third output, to break `OpAuthOutputCount == 2`.
    pub extra_output: bool,
    /// The subset witness: siblings and sides folding `child.root` up to the
    /// parent's `recipientsRoot`.
    ///
    /// `None` is an EMPTY witness, which is not a placeholder — it is the
    /// statement "this child inherits the parent's allowlist exactly", and the
    /// covenant checks it with the same fold. `Some` is how a narrowing child
    /// proves the node it claims is really in its parent's tree, and how a
    /// forged one is offered the chance to prove it is not.
    pub subset: Option<(Vec<[u8; 32]>, Vec<bool>)>,
    /// The covenant to run against. Only the mutation runs change it —
    /// `Spend` has carried one since the oracle was written for spends, and
    /// delegation could not be mutated at all until it had the same field.
    pub src: &'static str,
}

impl Delegate {
    pub fn valid() -> Self {
        Delegate {
            child: Child::narrower(),
            parent_reserved_override: None,
            parent_prev: (0, 0),
            coin_override: None,
            extra_output: false,
            subset: None,
            src: SOURCE,
        }
    }

    pub fn run(&self) -> Result<(), TxScriptError> {
        run_delegation_full(self)
    }
}

pub fn run_delegation(ch: &Child, parent_reserved_override: Option<i64>) -> Result<(), TxScriptError> {
    run_delegation_full(&Delegate { child: ch.clone(), parent_reserved_override, ..Delegate::valid() })
}

fn run_delegation_full(d: &Delegate) -> Result<(), TxScriptError> {
    let ch = &d.child;
    let parent_reserved_override = d.parent_reserved_override;
    let (prev_spent, prev_reserved) = d.parent_prev;
    let kp = agent_keypair();
    let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
    let child_key = [0x99u8; 32];
    let tree = Tree::new(members());
    let depth = proof_depth();

    let parent = compile_contract(
        d.src,
        &for_source(ctor_at_state(tree.root(), agent_xonly, depth, prev_spent, prev_reserved, 0, 0), d.src),
        CompileOptions::default(),
    )
    .expect("parent compiles");

    let reserved_after = parent_reserved_override.unwrap_or(prev_reserved + ch.budget);

    /* The child's identity, and the chain it pushes onto. Computed here rather
       than beside the declared state, because the parent's CONTINUATION must
       be compiled at this reserve root — the address commits the state, so a
       successor compiled at the wrong one is a different address. */
    let cid = child_id(
        child_key,
        ch.budget,
        ch.max_per_spend,
        ch.epoch_limit,
        epoch_length(), // the identity hash: must agree with child_ctor exactly

        ch.root.unwrap_or(tree.root()),
        ch.not_before,
        ch.expires_at,
        ch.delegation_depth,
    );
    let pushed = push_child(empty_reserve(), cid);

    // Parent continuation: same authority, reserved advanced, chain pushed.
    let parent_next = compile_contract(
        d.src,
        &for_source(
            ctor_at_state_with_reserve(tree.root(), agent_xonly, depth, prev_spent, reserved_after, 0, 0, pushed),
            d.src,
        ),
        CompileOptions::default(),
    )
    .expect("parent successor compiles");

    let child_contract = compile_contract(
        d.src,
        &for_source(child_ctor(tree.root(), child_key, ch, depth), d.src),
        CompileOptions::default(),
    )
    .expect("child compiles");

    let mut parent_fields = authority_fields_of(d.src, tree.root(), agent_xonly);
    parent_fields.push(("spentTotal", Expr::int(prev_spent)));
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
        vec![parent_next_state, child_state_of(d.src, tree.root(), child_key, ch)],
    );

    /* The coin in the parent's own UTXO. `covenant/SHAPES.md` records this
       exact bug being found and fixed once — *"IN_VALUE, the coin in the
       grant's own UTXO, was pinned at 10^10 while the budget was a hundred
       thousand times that"* — and it was fixed in the SPEND builder. This
       copy, in the delegation builder, was missed, and it is why every v4
       delegation case over-refused above a budget of 4 x 10^10: that is
       precisely where a child taking a quarter of the budget stops fitting
       inside a parent holding ten billion sompi whatever it claims. The
       covenant was right every time. */
    let in_value: u64 = in_value();
    let build = |sig: Vec<u8>| {
        /* v4 added the subset witness, so delegate takes four arguments after
           the injected prevState, not two. An EMPTY witness is not a
           placeholder: it is the statement "this child inherits the parent's
           allowlist exactly", which is what every test here except the
           widening one intends. A child claiming a different root with an
           empty witness is precisely what the covenant must refuse, so
           delegate_child_widening_allowlist_rejected is now testing its own
           rule rather than an arity error. */
        let (sub_sibs, sub_lefts) = d.subset.clone().unwrap_or_default();
        let args = vec![
            new_states.clone(),
            byte32_array(sub_sibs),
            bool_array(sub_lefts),
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
                    /* "Coin follows authority": the child's output must hold
                       exactly what its budget says. An override is the only
                       way to ask the engine whether that is checked. */
                    value: d.coin_override.unwrap_or(ch.budget).max(0) as u64,
                    script_public_key: pay_to_script_hash_script(&child_contract.bytecode),
                    covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
                },
            ]
            .into_iter()
            .chain(d.extra_output.then(|| TransactionOutput {
                // A second child, which the fanout of 2 must refuse.
                value: 1_000,
                script_public_key: pay_to_script_hash_script(&child_contract.bytecode),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
            }))
            .collect::<Vec<_>>(),
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

// ---------------------------------------------------------------------------
// The exits. `revoke` and `reclaim` are plain entries — no continuation, no
// successor, one signature and one output — and until now nothing in this
// repo had ever run either of them to an accepted verdict. The report counted
// five published claims it had never executed.
// ---------------------------------------------------------------------------

/// The principal's key, as a real keypair rather than the constant `[0x11; 32]`
/// the default constructor carries. `checkSig` cannot be exercised against a
/// key nobody holds.
pub fn principal_keypair() -> Keypair {
    let secp = Secp256k1::new();
    Keypair::from_seckey_slice(&secp, &[0x31u8; 32]).expect("valid key")
}

/// The revocation key. Separate from the principal on purpose: a monitor that
/// can stop a grant must not thereby be trusted with its balance.
pub fn revocation_keypair() -> Keypair {
    let secp = Secp256k1::new();
    Keypair::from_seckey_slice(&secp, &[0x4du8; 32]).expect("valid key")
}

/// `ctor_with`, plus real principal and revocation keys in slots 0 and 1.
pub fn ctor_with_authority(root: [u8; 32], agent_xonly: [u8; 32], depth: i64) -> Vec<Expr<'static>> {
    let mut v = ctor_with(root, agent_xonly, depth);
    v[0] = Expr::bytes(principal_keypair().x_only_public_key().0.serialize().to_vec());
    v[1] = Expr::bytes(revocation_keypair().x_only_public_key().0.serialize().to_vec());
    v
}

/// The 34-byte P2PK script the covenant builds for itself and compares against.
pub fn p2pk(key: [u8; 32]) -> Vec<u8> {
    let mut s = vec![0x20u8];
    s.extend_from_slice(&key);
    s.push(0xac);
    s
}

#[derive(Clone, Copy, PartialEq)]
pub enum Which {
    Revoke,
    Reclaim,
}

/// How a settlement's outputs are arranged. See `Settle::outputs`.
#[derive(Clone, Copy, PartialEq)]
pub enum Outputs {
    /// One output: the parent's continuation, at index 0, authorised by it.
    Normal,
    /// A plain payment at 0, the authorised continuation at 1.
    Displaced,
    /// The continuation at 0, and a second output authorised by the same input.
    Doubled,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Signer {
    Principal,
    Revocation,
    Agent,
}

pub struct Exit {
    pub which: Which,
    pub signer: Signer,
    /// Where the coin goes. `None` is P2PK(principalKey), which is the only
    /// destination either exit permits.
    pub pay_to: Option<[u8; 32]>,
    /// Taken out of the output, on top of nothing. The covenant allows up to
    /// `maxFee`.
    pub fee: i64,
    pub tx_daa: i64,
    /// The covenant to run against. Only the mutation runs change it.
    pub src: &'static str,
}

impl Exit {
    /// `revoke`, correctly signed, paying the principal, at exactly maxFee.
    pub fn revoke() -> Self {
        Exit { which: Which::Revoke, signer: Signer::Revocation, pay_to: None, fee: MAX_FEE, tx_daa: mid_epoch(0), src: SOURCE }
    }

    /// `reclaim`, at the first DAA the term allows.
    pub fn reclaim() -> Self {
        Exit { which: Which::Reclaim, signer: Signer::Principal, pay_to: None, fee: MAX_FEE, tx_daa: expires_at(), src: SOURCE }
    }

    pub fn run(&self) -> Result<(), TxScriptError> {
        let agent = agent_keypair();
        let agent_xonly: [u8; 32] = agent.x_only_public_key().0.serialize();
        let principal = principal_keypair();
        let revocation = revocation_keypair();
        let tree = Tree::new(members());
        /* No `for_source` here, deliberately. The template hash and the two
           state-region lengths are how one grant reads another's state, and
           neither exit reads anybody's state: `revoke` and `reclaim` check a
           signature, the output's script and the output's value, and nothing
           else. Retargeting them would be ceremony that implies this path
           depends on something it does not. */
        let c = compile_contract(
            self.src,
            &ctor_with_authority(tree.root(), agent_xonly, proof_depth()),
            CompileOptions::default(),
        )
        .expect("compiles");

        let payee = self.pay_to.unwrap_or_else(|| principal.x_only_public_key().0.serialize());
        let script = p2pk(payee);
        let in_value: u64 = in_value();
        let name = if self.which == Which::Revoke { "revoke" } else { "reclaim" };
        let tx_daa = self.tx_daa;
        let fee = self.fee;

        let build = |sig: Vec<u8>| {
            Transaction::new(
                1,
                vec![tx_input(0, plain_sigscript(&c, name, vec![Expr::bytes(sig)]))],
                vec![TransactionOutput {
                    value: in_value.saturating_sub(fee.max(0) as u64),
                    script_public_key: ScriptPublicKey::new(0, script.clone().into()),
                    covenant: None,
                }],
                tx_daa.max(0) as u64,
                Default::default(),
                0,
                vec![],
            )
        };

        let entries = vec![covenant_utxo(&c, in_value)];
        let kp = match self.signer {
            Signer::Principal => principal,
            Signer::Revocation => revocation,
            Signer::Agent => agent,
        };
        let sig = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &kp);
        execute(build(sig), entries, 0)
    }
}

// ---------------------------------------------------------------------------
// A compile cache, and a source that can be mutated.
//
// The claims suite compiles two contracts per case, which is fine for a
// hundred cases and hopeless for a few thousand. The generator below reuses
// the same instance and successor states over and over, so the compiler is
// asked the same question repeatedly; the answer is leaked once and handed
// back. Bounded by the number of distinct states in a run, which is small.
// ---------------------------------------------------------------------------

use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static CACHE: RefCell<HashMap<String, &'static CompiledContract<'static>>> = RefCell::new(HashMap::new());
}

/// Compile, or hand back the compilation of this exact source and constructor.
pub fn compiled(src: &'static str, ctor: &[Expr<'static>]) -> &'static CompiledContract<'static> {
    let key = format!("{:p}|{:?}", src.as_ptr(), ctor);
    CACHE.with(|c| {
        if let Some(v) = c.borrow().get(&key) {
            return *v;
        }
        let made: &'static CompiledContract<'static> =
            Box::leak(Box::new(compile_contract(src, ctor, CompileOptions::default()).expect("compiles")));
        c.borrow_mut().insert(key, made);
        made
    })
}

/// The covenant with one `require` removed, for proving that an oracle fires.
///
/// An oracle that has never fired is indistinguishable from one that cannot.
/// So the auditor reintroduces a vulnerability this covenant actually had and
/// checks that its own oracle catches it — the only evidence that a clean run
/// means anything.
pub fn source_without(line: &str) -> &'static str {
    source_without_in(SOURCE, line)
}

/// The same, for a covenant that is not v4.
///
/// `source_without` was written when there was one covenant to mutate. v5 is
/// a different one, and an oracle that can only put holes back in v4 cannot
/// say anything about the entrypoint v5 exists for.
pub fn source_without_in(src: &'static str, line: &str) -> &'static str {
    let out: String = src
        .lines()
        .map(|l| if l.trim() == line { format!("// MUTANT: removed — {l}") } else { l.to_string() })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(out.contains("// MUTANT: removed"), "no line matched {line:?}");
    Box::leak(out.into_boxed_str())
}
pub mod audit;
pub mod oracle;
pub mod v5;


// ---------------------------------------------------------------------------
// The template: where a grant's state sits inside its own bytecode, and the
// hash that lets one grant read another's state without trusting it.
//
// Ported from `covenant/deploy`, which is the second copy of this and one too
// many — but the alternative was a harness that cannot exercise the splice
// path at all, which is where the fifth recorded vulnerability lived. Change
// one and search for the other.
// ---------------------------------------------------------------------------

/// Where the state region sits: (prefix length, suffix length).
///
/// A fixed point — these are constructor arguments derived from the compiled
/// size, so changing them changes the bytecode, which changes them. Solved
/// once, cached, and it refuses to guess if it does not settle.
pub fn template_geometry() -> (i64, i64) {
    template_geometry_of(SOURCE)
}

/// The same fixed point, for any source.
///
/// v5 is a longer script, so its prefix and suffix are different numbers and
/// its templateId is a different hash. A probe that drove v5 with v4's
/// geometry would compile children whose templateId never matches, and the
/// engine would refuse every one of them for a reason that names nothing —
/// which is the failure mode this whole file exists to avoid.
pub fn template_geometry_of(src: &'static str) -> (i64, i64) {
    if let Some(v) = TEMPLATE_GEOMETRY.lock().unwrap().get(&(src.as_ptr() as usize)) {
        return *v;
    }
    let g = solve_geometry(src).expect("template geometry must settle");
    TEMPLATE_GEOMETRY.lock().unwrap().insert(src.as_ptr() as usize, g);
    g
}
static TEMPLATE_GEOMETRY: std::sync::LazyLock<std::sync::Mutex<HashMap<usize, (i64, i64)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

fn solve_geometry(src: &'static str) -> Result<(i64, i64), String> {
    let a = default_authority();
    let (mut prefix, mut suffix) = (1i64, 2900i64);
    for round in 0..8 {
        let probe = compile_contract(src, &ctor_full(proof_depth(), a, [0x51; 32], (prefix, suffix)), CompileOptions::default())
            .map_err(|e| format!("{e:?}"))?;
        let (p, sfx) = measure_state_region(src, &probe.bytecode, a, (prefix, suffix))?;
        if (p, sfx) == (prefix, suffix) {
            return Ok((prefix, suffix));
        }
        if round == 7 {
            return Err(format!("template geometry did not settle: {prefix}/{suffix} then {p}/{sfx}"));
        }
        prefix = p;
        suffix = sfx;
    }
    unreachable!()
}

/// Diff two compilations that differ ONLY in fixed-width state fields.
///
/// Integers compile at minimal width, so two probes with different numbers
/// have different lengths and cannot be diffed positionally. `agentKey` is the
/// first state field and `reserveRoot` the last, both `byte[32]`, so they
/// bracket the region exactly. Off by one is not cosmetic: a foreign redeem
/// script sliced one byte early decodes every field shifted and reads garbage
/// as a budget.
fn measure_state_region(src: &'static str, reference: &[u8], authority: Authority, geometry: (i64, i64)) -> Result<(i64, i64), String> {
    /* The SAME source as the reference probe. This read SOURCE outright, which
       is invisible while there is one covenant and a panic the moment there are
       two: the reference was v5 at 10,375 bytes, the other was v4 at 6,912, and
       "state probes differ in length" is what a positional diff says when it
       has been handed two different contracts. */
    let other = compile_contract(src, &ctor_probe(authority, geometry), CompileOptions::default())
        .map_err(|e| format!("{e:?}"))?;
    let (a, b) = (reference, &other.bytecode);
    if a.len() != b.len() {
        return Err(format!("state probes differ in length: {} vs {}", a.len(), b.len()));
    }
    let first = (0..a.len()).find(|&i| a[i] != b[i]).ok_or("state probes are identical")?;
    let last = (0..a.len()).rev().find(|&i| a[i] != b[i]).unwrap();
    if a[first - 1] != 0x20 {
        return Err(format!("expected OP_DATA_32 before the state region at {}, found {:#04x}", first - 1, a[first - 1]));
    }
    Ok(((first - 1) as i64, (a.len() - last - 1) as i64))
}

/// The same constructor with every byte[32] state field moved and every
/// integer left alone.
fn ctor_probe(authority: Authority, geometry: (i64, i64)) -> Vec<Expr<'static>> {
    let mut v = ctor_full(proof_depth(), authority, [0x47; 32], geometry);
    v[3] = Expr::bytes(vec![0x44; 32]);   // genesisAgentKey
    v[8] = Expr::bytes(vec![0x46; 32]);   // genesisRecipientsRoot
    v[20] = Expr::bytes(vec![0x48; 32]);  // initReserveRoot
    v
}

/// blake3 over `len(prefix) || prefix || len(suffix) || suffix`.
///
/// The lengths are in the preimage on purpose: they bind WHERE the state is
/// inserted, so a covenant cannot be passed off as one with a differently
/// placed state region. Keyed on the authority, because both keys live in the
/// suffix the hash covers — which is the binding that stops a parent
/// reabsorbing a child it does not own.
pub fn template_id_for(authority: Authority) -> [u8; 32] {
    template_id_of(SOURCE, authority)
}

/// The template hash `readInputStateWithTemplate` recomputes, for any source.
pub fn template_id_of(src: &'static str, authority: Authority) -> [u8; 32] {
    if let Some(v) = TEMPLATE_IDS.lock().unwrap().get(&(src.as_ptr() as usize, authority)) {
        return *v;
    }
    let (p, sfx) = template_geometry_of(src);
    let probe = compile_contract(src, &ctor_full(proof_depth(), authority, [0u8; 32], (p, sfx)), CompileOptions::default())
        .expect("template id probe must compile");
    let code = &probe.bytecode;
    let mut pre = Vec::new();
    pre.extend_from_slice(&(p).to_le_bytes());
    pre.extend_from_slice(&code[..p as usize]);
    pre.extend_from_slice(&(sfx).to_le_bytes());
    pre.extend_from_slice(&code[code.len() - sfx as usize..]);
    let id = *blake3::hash(&pre).as_bytes();
    TEMPLATE_IDS.lock().unwrap().insert((src.as_ptr() as usize, authority), id);
    id
}

static TEMPLATE_IDS: std::sync::LazyLock<std::sync::Mutex<HashMap<(usize, Authority), [u8; 32]>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Run the engine over EVERY input, not just one.
///
/// Settlement is the first transaction this repo builds with two inputs under
/// two entrypoints and two keys. Judging only input 0 would run the parent's
/// `reabsorb` and never run the child's `settle` at all — so the half
/// authorised by the revocation key, which is the half vulnerability 5 lived
/// in, would go untested. The first failing input is returned, so a caller
/// still gets one verdict.
pub fn execute_all(tx: Transaction, entries: Vec<UtxoEntry>) -> Result<(), TxScriptError> {
    if entries.len() != tx.inputs.len() {
        return Err(TxScriptError::MalformedPush(entries.len(), tx.inputs.len()));
    }
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    for idx in 0..tx.inputs.len() {
        let input = tx.inputs[idx].clone();
        let utxo = populated.utxo(idx).expect("utxo");
        let mut vm = TxScriptEngine::from_transaction_input(
            &populated, &input, idx, utxo,
            EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx),
            EngineFlags { covenants_enabled: true, sigop_script_units: 0.into() },
        );
        vm.execute()?;
    }
    Ok(())
}

/// Settlement: the parent runs `reabsorb`, the child runs `settle`, in one
/// transaction, under two different keys.
///
/// The child's half is signed by the REVOCATION key on purpose — if
/// settlement needed the child's cooperation, an unresponsive child could lock
/// its parent's budget forever, which is the failure this path exists to
/// remove.
pub struct Settle {
    /// What the child has spent by the time it is settled.
    pub child_spent: i64,
    pub child_budget: i64,
    /// The parent's state before settlement: spent, reserved.
    pub parent_spent: i64,
    pub parent_reserved: i64,
    /// The parent's declared successor, defaulted from the arithmetic the
    /// covenant requires.
    pub successor: Option<(i64, i64)>,
    /// Taken out of the single continuation, beyond the 1,000 the baseline
    /// already leaves. The covenant allows up to `maxFee` across both inputs.
    pub extra_fee: i64,
    /// Sign the child's half with something other than the revocation key.
    pub child_signer: Signer,
    /// Sign the parent's half with something other than its agent key.
    pub parent_signer: Signer,
    /// Declare a reserve root the parent does not actually carry.
    pub wrong_prev_root: bool,
    /// Give the child a child of its own, which must be refused: a subtree
    /// settles from the leaves up.
    pub child_reserved: i64,
    /// Which input the parent claims its child is. The covenant bounds it and
    /// refuses the parent's own index.
    pub child_idx: i64,
    /// Move one of the parent's authority fields in the declared successor.
    /// Everything about the parent must stand still across a settlement.
    pub authority_override: Option<(&'static str, Expr<'static>)>,
    /// Drop the child's input, leaving the revocation key holding a `settle`
    /// with nothing tying it to a parent. This is vulnerability 5's shape.
    pub lone_child: bool,
    /// Rearrange the outputs so that output 0 is NOT the parent's single
    /// authorised continuation — the one published claim this report has
    /// always listed as `not covered`.
    ///
    /// `Displaced` puts a plain payment at index 0 and the parent's
    /// continuation at index 1, still authorised by the parent's input. The
    /// count is one and the index is one, so `OpAuthOutputIdx(parentIdx, 0)
    /// == 0` is the only thing that can fail — output 0 holds nearly all the
    /// coin, so the value clause passes, and the co-input is a real grant, so
    /// the template check passes.
    ///
    /// `Doubled` keeps the continuation at index 0 and authorises a SECOND
    /// output from the same input, so `OpAuthOutputCount(parentIdx) == 1` is
    /// the only thing that can fail.
    ///
    /// One flip per line of the claim, which is what "covered" has to mean.
    pub outputs: Outputs,
    /// Execute ONE input's script rather than the whole transaction.
    ///
    /// Needed for exactly the claim above, and the reason it went uncovered
    /// for so long. The parent's `reabsorb` requires
    /// `OpAuthOutputCount(this.activeInputIndex) == 1` and
    /// `OpAuthOutputIdx(this.activeInputIndex, 0) == 0`; the child's `settle`
    /// requires the identical predicate about the identical input. The two
    /// are redundant by construction, so no whole transaction can violate the
    /// child's version without violating the parent's, and the parent's input
    /// is verified first. A refusal of the pair proves only that ONE of them
    /// fired.
    ///
    /// Running the child's script alone is not a claim about what a node
    /// would do with the transaction. It is a claim about what the child's
    /// script enforces, which is what the guarantee says and what this report
    /// audits — and it is the same per-input execution every other case here
    /// is built on.
    pub only_input: Option<usize>,
    /// The covenant to run against. Only the mutation runs change it.
    ///
    /// Settlement is the one family where this is not a convenience: `settle`
    /// reads its co-input through `readInputStateWithTemplate`, so the
    /// template hash and the two state-region lengths are not decoration here
    /// — they are how one grant reads another's state without trusting it. A
    /// mutant compiled at SOURCE's numbers does not merely fail; it fails in
    /// the splice, before any rule under test is reached.
    pub src: &'static str,
}

impl Settle {
    pub fn valid() -> Self {
        Settle {
            child_spent: 5 * KAS,
            child_budget: 25 * KAS,
            parent_spent: 0,
            parent_reserved: 25 * KAS,
            successor: None,
            extra_fee: 0,
            child_signer: Signer::Revocation,
            parent_signer: Signer::Agent,
            wrong_prev_root: false,
            child_reserved: 0,
            child_idx: 1,
            authority_override: None,
            lone_child: false,
            outputs: Outputs::Normal,
            only_input: None,
            src: SOURCE,
        }
    }

    pub fn run(&self) -> Result<(), TxScriptError> {
        let agent = agent_keypair();
        let agent_xonly: [u8; 32] = agent.x_only_public_key().0.serialize();
        let principal = principal_keypair();
        let revocation = revocation_keypair();
        let authority = Authority::new(
            principal.x_only_public_key().0.serialize(),
            revocation.x_only_public_key().0.serialize(),
        );
        let tid = template_id_of(self.src, authority);
        let geo = template_geometry_of(self.src);
        let tree = Tree::new(members());
        let child_key = [0x99u8; 32];
        let depth = proof_depth();

        let ch = Child {
            budget: self.child_budget,
            max_per_spend: KAS,
            epoch_limit: 5 * KAS,
            expires_at: expires_at(),
            not_before: not_before(),
            delegation_depth: 1,
            root: None,
            accounting: (self.child_spent, self.child_reserved, 0, 0),
        };

        /* The child's identity, rebuilt from its IMMUTABLE fields — which is
           why a child that has been spending still matches what the parent
           committed to when it delegated. */
        let cid = child_id(child_key, ch.budget, ch.max_per_spend, ch.epoch_limit, epoch_length(),
            tree.root(), ch.not_before, ch.expires_at, ch.delegation_depth);
        let carried = push_child(empty_reserve(), cid);
        let prev_root = if self.wrong_prev_root { [0x66u8; 32] } else { empty_reserve() };

        /* `authority_override` moves a field in the DECLARED successor. It has
           to move the same field in the successor's COMPILED constructor too,
           and for a long time it did not.

           A grant's address is a hash of its state, so a successor declared
           with a raised per-spend cap and compiled without one is not that
           grant — and the covenant refuses it at the address, before reaching
           `require(newState.maxPerSpend == maxPerSpend)` at all. Three cases
           in `audit.rs` claim to prove "everything else about the parent
           stands still" and were being refused for the wrong reason: delete
           the rule they name and they are still refused, which is precisely
           the failure AUDIT.md warns about in other people's suites.

           Found by the generative oracle, which removed that `require` and
           could not get a single transaction past the address check to notice.

           Applied ONLY to the successor: the parent's own constructor is the
           state the grant is already in, and moving that would change which
           grant is being settled rather than what it claims to become. */
        let ov_index = |name: &str| -> usize {
            match name {
                "agentKey" => 3,
                "budgetTotal" => 4,
                "maxPerSpend" => 5,
                "epochLimit" => 6,
                "epochLength" => 7,
                "recipientsRoot" => 8,
                "notBefore" => 9,
                "expiresAt" => 10,
                "delegationDepth" => 11,
                "templateId" => 12,
                other => panic!("no constructor slot for authority field {other}"),
            }
        };
        let parent_ctor = |spent: i64, reserved: i64, root: [u8; 32], with_override: bool| {
            let mut v = ctor_full(depth, authority, tid, geo);
            v[3] = Expr::bytes(agent_xonly.to_vec());
            v[8] = Expr::bytes(tree.root().to_vec());
            v[16] = Expr::int(spent);
            v[17] = Expr::int(reserved);
            v[20] = Expr::bytes(root.to_vec());
            if with_override {
                if let Some((name, ref value)) = self.authority_override {
                    v[ov_index(name)] = value.clone();
                }
            }
            v
        };
        let parent = compiled(self.src, &parent_ctor(self.parent_spent, self.parent_reserved, carried, false));

        let (ns, nr) = self.successor.unwrap_or((
            self.parent_spent + self.child_spent,
            self.parent_reserved - self.child_budget,
        ));
        let parent_next = compiled(self.src, &parent_ctor(ns, nr, prev_root, true));

        /* The child must share the parent's authority, because the template
           id is keyed on the pair — which is the binding that stops a parent
           reabsorbing a child it does not own. */
        let mut child_c = child_ctor(tree.root(), child_key, &ch, depth);
        child_c[0] = Expr::bytes(authority.principal.to_vec());
        child_c[1] = Expr::bytes(authority.revocation.to_vec());
        child_c[12] = Expr::bytes(tid.to_vec());
        child_c[13] = Expr::int(geo.0);
        child_c[14] = Expr::int(geo.1);
        let child = compiled(self.src, &child_c);

        let parent_value: u64 = 50 * KAS as u64;
        let child_value: u64 = self.child_budget.max(1) as u64;
        let combined = parent_value + child_value;
        let extra = self.extra_fee;

        let mut fields = authority_fields(tree.root(), agent_xonly);
        for f in fields.iter_mut() {
            if f.0 == "templateId" { f.1 = Expr::bytes(tid.to_vec()); }
            if let Some((name, ref v)) = self.authority_override {
                if f.0 == name { f.1 = v.clone(); }
            }
        }
        fields.push(("spentTotal", Expr::int(ns)));
        fields.push(("reserved", Expr::int(nr)));
        fields.push(("epochIndex", Expr::int(0)));
        fields.push(("epochSpent", Expr::int(0)));
        fields.push(("reserveRoot", Expr::bytes(prev_root.to_vec())));
        let new_states = Expr::array(
            TypeRef { base: TypeBase::Custom("State".to_string()), array_dims: vec![ArrayDim::Dynamic] },
            vec![struct_object("State", fields)],
        );

        let lone = self.lone_child;
        let arrangement = self.outputs;
        let build = |psig: Vec<u8>, csig: Vec<u8>| {
            let mut inputs = vec![tx_input(0, sigscript(parent, "reabsorb", vec![
                new_states.clone(),
                Expr::int(self.child_idx),
                Expr::bytes(prev_root.to_vec()),
                Expr::bytes(psig),
            ]))];
            let child_in = tx_input(1, plain_sigscript(child, "settle", vec![Expr::bytes(csig)]));
            if lone {
                // The revocation key alone, with its own dust as the co-input.
                inputs = vec![child_in, tx_input(2, vec![OpTrue])];
            } else {
                inputs.push(child_in);
            }
            let paid = combined.saturating_sub(1_000).saturating_sub(extra.max(0) as u64);
            let cont = |value: u64| TransactionOutput {
                value,
                script_public_key: pay_to_script_hash_script(&parent_next.bytecode),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
            };
            let outs = match arrangement {
                Outputs::Normal => vec![cont(paid)],
                /* Nearly all the coin at index 0, so the value clause is
                   satisfied and cannot be the thing that refuses; the parent's
                   authorised continuation demoted to index 1. */
                Outputs::Displaced => vec![
                    TransactionOutput {
                        value: paid,
                        script_public_key: ScriptPublicKey::new(0, p2pk([0xa1; 32]).into()),
                        covenant: None,
                    },
                    cont(1_000),
                ],
                /* Two outputs from one authorising input. Index 0 is still the
                   continuation, so only the COUNT can fail. */
                Outputs::Doubled => vec![cont(paid), cont(0)],
            };
            Transaction::new(1, inputs, outs, 0, Default::default(), 0, vec![])
        };

        let entries = if lone {
            vec![covenant_utxo(child, child_value), UtxoEntry::new(parent_value, pay_to_script_hash_script(&[OpTrue]), 0, false, None)]
        } else {
            vec![covenant_utxo(parent, parent_value), covenant_utxo(child, child_value)]
        };

        let pick = |w: Signer| match w {
            Signer::Principal => principal,
            Signer::Revocation => revocation,
            Signer::Agent => agent,
        };
        let unsigned = build(vec![0u8; 65], vec![0u8; 65]);
        let psig = sign_input(unsigned.clone(), entries.clone(), if lone { 1 } else { 0 }, &pick(self.parent_signer));
        let csig = sign_input(unsigned, entries.clone(), if lone { 0 } else { 1 }, &pick(self.child_signer));
        match self.only_input {
            Some(i) => execute(build(psig, csig), entries, i),
            None => execute_all(build(psig, csig), entries),
        }
    }
}
