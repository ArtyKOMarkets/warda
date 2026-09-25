//! v5's builders, lifted out of `bin/c1.rs` so a second binary can use them.
//!
//! They were bin-local for as long as only `c1` needed them, which was the
//! right call at the time and stopped being it the moment the generative
//! oracle wanted `delegate2`. Nothing here changed in the move except what
//! the two notes below say changed.
//!
//! v5 is a DIFFERENT COVENANT, not a newer one. It has its own geometry, its
//! own template hash and its own baked maxFee, and driving it with v4's
//! numbers compiles children whose templateId never matches anything — for
//! which the engine's only message is that verification failed.

use kaspa_consensus_core::hashing::sighash::{calc_schnorr_signature_hash, SigHashReusedValuesUnsync};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::tx::{
    CovenantBinding, MutableTransaction, Transaction, TransactionOutput, UtxoEntry,
};
use kaspa_txscript::pay_to_script_hash_script;
use kaspa_txscript_errors::TxScriptError;
use silverscript_lang::ast::{ArrayDim, Expr, TypeBase, TypeRef};
use silverscript_lang::compiler::{compile_contract, struct_object, CompileOptions};

use crate::*;

/// v5's own geometry and template hash. A longer script has a different prefix,
/// a different suffix and therefore a different templateId — driving v5 with
/// v4's numbers compiles children whose templateId never matches, and the
/// engine refuses each one for a reason that names nothing.
/// The authority every v5 grant here is built under, and it is built from the
/// REAL keypairs rather than from `default_authority`'s 0x11/0x44 placeholders.
///
/// `delegate` and `delegate2` never check it — they verify the agent's
/// signature and nothing else — so the placeholders work fine right up until a
/// child runs `settle`, which requires `checkSig(s, revocationKey)`. A
/// signature cannot verify against 0x44 repeated thirty-two times, and the
/// engine says only "verification failed". The whole v5 section uses one
/// authority so that what delegate2 creates is a thing the settle suite can
/// actually settle.
pub fn v5_authority() -> Authority {
    Authority::new(
        principal_keypair().x_only_public_key().0.serialize(),
        revocation_keypair().x_only_public_key().0.serialize(),
    )
}

/// The maxFee the DEPLOYED template bakes, which is not the harness's default.
///
/// `ctor_full` uses 100,000 — fine for cases that only ask what the covenant
/// refuses, since every one of them is internally consistent. It is not fine
/// for a golden vector: maxFee is a baked constructor constant, so it is part
/// of the bytecode and NOT a state field the SDK can splice. A vector emitted
/// at 100,000 can never be reproduced from sdk/covenant-template-v5.json,
/// which bakes 5,000,000, and the mismatch surfaces 1,879 bytes into an
/// 11,120-byte signature script — which is where it surfaced.
pub const TEMPLATE_MAX_FEE: i64 = 5_000_000;

/// v5's template id AT THE DEPLOYED maxFee.
///
/// `template_id_of` computes the hash from `ctor_full`, which bakes the
/// harness's 100,000 — and maxFee sits in the SUFFIX, so the id it returns is
/// the id of a contract nobody deploys. The width is the same (both encode in
/// three script bytes, so the geometry is unchanged), which is exactly why
/// this hid: every address still derived, every delegate2 case still passed,
/// because `delegate2` only requires the child's templateId to EQUAL the
/// parent's and both were the same wrong value.
///
/// `reabsorb` and `settle` are the only paths that USE it — they slice a
/// foreign redeem script with it — and they refused, which is how it surfaced.
/// A grant issued at one maxFee and settled against an id computed at another
/// can delegate and can never come home.
pub fn v5_template_id() -> [u8; 32] {
    let (p, sfx) = template_geometry_of(SOURCE_V5);
    let mut ctor = ctor_full(proof_depth(), v5_authority(), [0u8; 32], (p, sfx));
    ctor[2] = Expr::int(TEMPLATE_MAX_FEE);
    let probe = compile_contract(SOURCE_V5, &ctor, CompileOptions::default())
        .expect("template id probe must compile");
    let code = &probe.bytecode;
    let mut pre = Vec::new();
    pre.extend_from_slice(&p.to_le_bytes());
    pre.extend_from_slice(&code[..p as usize]);
    pre.extend_from_slice(&sfx.to_le_bytes());
    pre.extend_from_slice(&code[code.len() - sfx as usize..]);
    *blake3::hash(&pre).as_bytes()
}

pub fn v5_ctor_base() -> Vec<Expr<'static>> {
    let geo = template_geometry_of(SOURCE_V5);
    let mut v = ctor_full(proof_depth(), v5_authority(), v5_template_id(), geo);
    v[2] = Expr::int(TEMPLATE_MAX_FEE);
    v
}

pub fn v5_parent_ctor(root: [u8; 32], agent: [u8; 32], spent: i64, reserved: i64, chain: [u8; 32]) -> Vec<Expr<'static>> {
    let mut v = v5_ctor_base();
    v[3] = Expr::bytes(agent.to_vec());
    v[8] = Expr::bytes(root.to_vec());
    v[16] = Expr::int(spent);
    v[17] = Expr::int(reserved);
    v[20] = Expr::bytes(chain.to_vec());
    v
}

pub fn v5_child_ctor(root: [u8; 32], key: [u8; 32], ch: &Child) -> Vec<Expr<'static>> {
    let mut v = v5_ctor_base();
    v[3] = Expr::bytes(key.to_vec());
    v[4] = Expr::int(ch.budget);
    v[5] = Expr::int(ch.max_per_spend);
    v[6] = Expr::int(ch.epoch_limit);
    v[7] = Expr::int(1_000);
    v[8] = Expr::bytes(ch.root.unwrap_or(root).to_vec());
    v[9] = Expr::int(ch.not_before);
    v[10] = Expr::int(ch.expires_at);
    v[11] = Expr::int(ch.delegation_depth);
    /* The child's ACCOUNTING, which this dropped. A grant's state is compiled
       into its address, so a child that has spent is a different script from
       the one it was born as. Leaving these at zero built a child whose script
       said spentTotal = 0 while the settlement declared it had spent 5 KAS,
       and `reabsorb` — which reads the child's real state out of its redeem
       script — refused the arithmetic it was handed.
       It was invisible in the delegate2 suite because a newborn child's
       accounting IS all zeroes. Only settling reads a child that has moved. */
    v[16] = Expr::int(ch.accounting.0);
    v[17] = Expr::int(ch.accounting.1);
    v[18] = Expr::int(ch.accounting.2);
    v[19] = Expr::int(ch.accounting.3);
    v
}

pub fn v5_child_state(root: [u8; 32], key: [u8; 32], ch: &Child) -> Expr<'static> {
    struct_object(
        "State",
        vec![
            ("agentKey", Expr::bytes(key.to_vec())),
            ("budgetTotal", Expr::int(ch.budget)),
            ("maxPerSpend", Expr::int(ch.max_per_spend)),
            ("epochLimit", Expr::int(ch.epoch_limit)),
            ("epochLength", Expr::int(1_000)),
            ("recipientsRoot", Expr::bytes(ch.root.unwrap_or(root).to_vec())),
            ("notBefore", Expr::int(ch.not_before)),
            ("expiresAt", Expr::int(ch.expires_at)),
            ("delegationDepth", Expr::int(ch.delegation_depth)),
            ("templateId", Expr::bytes(v5_template_id().to_vec())),
            ("spentTotal", Expr::int(ch.accounting.0)),
            ("reserved", Expr::int(ch.accounting.1)),
            ("epochIndex", Expr::int(ch.accounting.2)),
            ("epochSpent", Expr::int(ch.accounting.3)),
            ("reserveRoot", Expr::bytes(empty_reserve().to_vec())),
        ],
    )
}

/// Every lever a `delegate2` case needs. Each is one field away from a
/// baseline the engine accepts, which is what makes a refusal mean something.
pub struct Flip {
    /// The chain pushed B-then-A instead of A-then-B.
    pub reverse_chain: bool,
    /// Both children under the same agent key.
    pub same_key: bool,
    /// `parentNext.reserved`, when it should not be the honest sum.
    pub reserved: Option<i64>,
    /// What the parent had already committed before this delegation. Needed to
    /// separate the SEQUENTIAL budget bound from the input-value check: with an
    /// empty parent both refuse the same transaction, and a case refused for
    /// two reasons tests neither.
    pub prev_reserved: i64,
    /// What the parent had already SPENT. Added for the generative oracle,
    /// which needs the tree's capacity before a delegation to be something
    /// other than the whole budget — a parent at genesis cannot double-promise
    /// anything, so every conservation question asked of one is trivial.
    pub prev_spent: i64,
    /// The covenant to run against. `SOURCE_V5` unless a mutation run says
    /// otherwise; see `Spend`, `Delegate`, `Settle` and `Exit`, which each
    /// carry the same field for the same reason.
    pub src: &'static str,
    /// Push only child A onto the reserve chain, leaving B unchained.
    ///
    /// The case the specification calls "one child's id omitted from the
    /// chain", and the reason it matters is not the sum: the parent's
    /// `reserved` can be perfectly correct while the chain names only one of
    /// the two children. An unchained child can never be reabsorbed — nothing
    /// can produce the preimage that pops it — so its coin sits inside the
    /// parent's reserve for the grant's whole life while belonging to a grant
    /// the parent cannot name. The sum says the money is accounted for; the
    /// chain is what says WHICH children it is accounted for by.
    pub chain_omits_b: bool,
}

impl Default for Flip {
    fn default() -> Self {
        Flip {
            reverse_chain: false,
            same_key: false,
            reserved: None,
            prev_reserved: 0,
            prev_spent: 0,
            src: SOURCE_V5,
            chain_omits_b: false,
        }
    }
}

/// The sighash the agent signs, recomputed rather than taken on trust — the
/// golden vector's whole job is to let the SDK check its own against it.
pub fn sighash_of(tx: &Transaction, entries: &[UtxoEntry], idx: usize) -> [u8; 32] {
    let mtx = MutableTransaction::with_entries(tx.clone(), entries.to_vec());
    let reused = SigHashReusedValuesUnsync::new();
    // Bound to a local: the verifiable view borrows `mtx`, and returning the
    // expression directly drops `mtx` while that borrow is still live.
    let h = calc_schnorr_signature_hash(&mtx.as_verifiable(), idx, SIG_HASH_ALL, &reused).as_bytes();
    h
}

pub fn delegate2_run(a: &Child, b: &Child, f: &Flip) -> Result<(), TxScriptError> {
    delegate2_artifacts(a, b, f).0
}

/// The same build, returning what it built. One implementation, so the vector
/// and the verdict cannot describe two different transactions.
pub fn delegate2_artifacts(
    a: &Child,
    b: &Child,
    f: &Flip,
) -> (Result<(), TxScriptError>, Transaction, UtxoEntry, [u8; 32]) {
    let kp = agent_keypair();
    let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
    let tree = Tree::new(members());
    let key_a = [0x90u8; 32];
    let key_b = if f.same_key { key_a } else { [0x91u8; 32] };

    let parent = compile_contract(
        f.src,
        &v5_parent_ctor(tree.root(), agent_xonly, f.prev_spent, f.prev_reserved, empty_reserve()),
        CompileOptions::default(),
    )
    .expect("v5 parent compiles");

    let cid = |key: [u8; 32], ch: &Child| {
        child_id(key, ch.budget, ch.max_per_spend, ch.epoch_limit, 1_000,
                 ch.root.unwrap_or(tree.root()), ch.not_before, ch.expires_at, ch.delegation_depth)
    };
    let chain = if f.chain_omits_b {
        push_child(empty_reserve(), cid(key_a, a))
    } else if f.reverse_chain {
        push_child(push_child(empty_reserve(), cid(key_b, b)), cid(key_a, a))
    } else {
        push_child(push_child(empty_reserve(), cid(key_a, a)), cid(key_b, b))
    };
    let total = a.budget + b.budget;
    let reserved_after = f.reserved.unwrap_or(f.prev_reserved + total);

    let parent_next = compile_contract(
        f.src,
        &v5_parent_ctor(tree.root(), agent_xonly, f.prev_spent, reserved_after, chain),
        CompileOptions::default(),
    )
    .expect("v5 successor compiles");
    let ca = compile_contract(f.src, &v5_child_ctor(tree.root(), key_a, a), CompileOptions::default()).expect("child A compiles");
    let cb = compile_contract(f.src, &v5_child_ctor(tree.root(), key_b, b), CompileOptions::default()).expect("child B compiles");

    let mut pf = authority_fields(tree.root(), agent_xonly);
    // authority_fields bakes v4's templateId, and this covenant is not v4.
    for field in pf.iter_mut() {
        if field.0 == "templateId" {
            field.1 = Expr::bytes(v5_template_id().to_vec());
        }
    }
    pf.push(("spentTotal", Expr::int(f.prev_spent)));
    pf.push(("reserved", Expr::int(reserved_after)));
    pf.push(("epochIndex", Expr::int(0)));
    pf.push(("epochSpent", Expr::int(0)));
    pf.push(("reserveRoot", Expr::bytes(chain.to_vec())));

    let new_states = Expr::array(
        TypeRef { base: TypeBase::Custom("State".to_string()), array_dims: vec![ArrayDim::Dynamic] },
        vec![struct_object("State", pf), v5_child_state(tree.root(), key_a, a), v5_child_state(tree.root(), key_b, b)],
    );

    let in_value: u64 = 10_000_000_000;
    let empty_sibs = || Expr::array(
        TypeRef { base: TypeBase::Byte, array_dims: vec![ArrayDim::Fixed(32), ArrayDim::Dynamic] },
        vec![],
    );
    let empty_lefts = || Expr::array(TypeRef { base: TypeBase::Bool, array_dims: vec![ArrayDim::Dynamic] }, vec![]);

    let build = |sig: Vec<u8>| {
        let out = |value: u64, code: &[u8]| TransactionOutput {
            value,
            script_public_key: pay_to_script_hash_script(code),
            covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
        };
        Transaction::new(
            1,
            vec![tx_input(0, sigscript(&parent, "delegate2", vec![
                new_states.clone(), empty_sibs(), empty_lefts(), empty_sibs(), empty_lefts(), Expr::bytes(sig),
            ]))],
            vec![
                out(in_value.saturating_sub(total.max(0) as u64).saturating_sub(1_000), &parent_next.bytecode),
                out(a.budget.max(0) as u64, &ca.bytecode),
                out(b.budget.max(0) as u64, &cb.bytecode),
            ],
            0,
            Default::default(),
            0,
            vec![],
        )
    };

    let entries = vec![covenant_utxo(&parent, in_value)];
    let unsigned = build(vec![0u8; 65]);
    let sighash = sighash_of(&unsigned, &entries, 0);
    let sig = sign_input(unsigned.clone(), entries.clone(), 0, &kp);
    let verdict = execute(build(sig), entries.clone(), 0);
    (verdict, unsigned, entries[0].clone(), sighash)
}
