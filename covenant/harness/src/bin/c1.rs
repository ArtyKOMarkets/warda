//! `c1` — the conservation specification for 1:N delegation, and a builder for it.
//!
//!     cargo run --release --bin c1 --manifest-path covenant/harness/Cargo.toml
//!
//! covenant/V5.md's C1 is atomic delegation: one transaction, a parent
//! continuation and N children. The language compiles it and the engine
//! authorises it (`--bin fanout`). What does not exist is the covenant body
//! that keeps conservation across N children, and THAT is where the design
//! risk lives.
//!
//! This is not a test suite yet, and it says so rather than looking like one.
//! v4's `delegate` refuses any transaction with more than one child before it
//! reaches a single conservation rule, so every multi-child case below is
//! refused for the arity and not for the rule it names. A probe that fails for
//! the wrong reason is worse than no probe — it is recorded as evidence of
//! safety — so none of them is reported as passing.
//!
//! What it DOES do today, which is the point of writing it now:
//!
//!   1. The N-child builder exists and is proven. At N = 1 it must produce a
//!      transaction the engine ACCEPTS, which is the same known-good path
//!      `run_delegation` walks. A generalisation that breaks it is a
//!      generalisation that would have silently produced malformed
//!      transactions for every case above it.
//!   2. v4's refusal at N = 2 and N = 3 is demonstrated rather than assumed.
//!   3. The cases are written down in executable form, each with the rule that
//!      must do the refusing, so C1 is built against a specification rather
//!      than towards one.
//!
//! When C1 lands, `SOURCE` becomes the new covenant and this file becomes the
//! test suite without a single expectation changing.
use kaspa_consensus_core::hashing::sighash::{calc_schnorr_signature_hash, SigHashReusedValuesUnsync};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::tx::{
    CovenantBinding, MutableTransaction, Transaction, TransactionOutput, UtxoEntry,
};
use kaspa_txscript::pay_to_script_hash_script;
use kaspa_txscript_errors::TxScriptError;
use silverscript_lang::ast::{ArrayDim, Expr, TypeBase, TypeRef};
use silverscript_lang::compiler::{compile_contract, struct_object, CompileOptions};
use warda_harness::{
    agent_keypair, authority_fields, child_ctor, child_id, child_state, covenant_utxo,
    ctor_at_state, ctor_at_state_with_reserve, empty_reserve, execute, members, proof_depth,
    execute_all, plain_sigscript, push_child, revocation_keypair, sign_input, sigscript,
    template_geometry_of, template_id_of, tx_input,
    Authority, Child, Tree, COV, KAS, SOURCE, SOURCE_V5,
};
use warda_harness::{ctor_full, principal_keypair};

/// One child, and the key it will be created under.
struct Kid {
    child: Child,
    key: [u8; 32],
}

/// What the parent claims about itself in its successor. Every field here is a
/// lever a C1 case needs, because conservation across N children is exactly
/// the arithmetic these three numbers have to satisfy.
struct ParentClaim {
    /// `reserved` in the successor. `None` = prev + the sum of the budgets,
    /// which is the honest value.
    reserved: Option<i64>,
    /// The reserve chain the successor commits to. `None` = every child
    /// pushed, in output order.
    chain: Option<[u8; 32]>,
}

impl Default for ParentClaim {
    fn default() -> Self {
        ParentClaim { reserved: None, chain: None }
    }
}

/// A delegation with N children, built the way `run_delegation_full` builds
/// one — same helpers, same order, so the two cannot drift.
fn delegate_n(kids: &[Kid], claim: &ParentClaim) -> Result<(), TxScriptError> {
    let kp = agent_keypair();
    let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
    let tree = Tree::new(members());
    let depth = proof_depth();
    let (prev_spent, prev_reserved) = (0i64, 0i64);

    let parent = compile_contract(
        SOURCE,
        &ctor_at_state(tree.root(), agent_xonly, depth, prev_spent, prev_reserved, 0, 0),
        CompileOptions::default(),
    )
    .expect("parent compiles");

    // The chain, pushed in OUTPUT order. Which order is not a detail: a
    // successor compiled at a differently-ordered chain is a different
    // address, so "the same children in another order" is a distinct
    // transaction and a case of its own.
    let mut chain = empty_reserve();
    for k in kids {
        let cid = child_id(
            k.key,
            k.child.budget,
            k.child.max_per_spend,
            k.child.epoch_limit,
            1_000,
            k.child.root.unwrap_or(tree.root()),
            k.child.not_before,
            k.child.expires_at,
            k.child.delegation_depth,
        );
        chain = push_child(chain, cid);
    }
    let chain = claim.chain.unwrap_or(chain);

    let total: i64 = kids.iter().map(|k| k.child.budget).sum();
    let reserved_after = claim.reserved.unwrap_or(prev_reserved + total);

    let parent_next = compile_contract(
        SOURCE,
        &ctor_at_state_with_reserve(
            tree.root(), agent_xonly, depth, prev_spent, reserved_after, 0, 0, chain,
        ),
        CompileOptions::default(),
    )
    .expect("parent successor compiles");

    let child_contracts: Vec<_> = kids
        .iter()
        .map(|k| {
            compile_contract(
                SOURCE,
                &child_ctor(tree.root(), k.key, &k.child, depth),
                CompileOptions::default(),
            )
            .expect("child compiles")
        })
        .collect();

    let mut parent_fields = authority_fields(tree.root(), agent_xonly);
    parent_fields.push(("spentTotal", Expr::int(prev_spent)));
    parent_fields.push(("reserved", Expr::int(reserved_after)));
    parent_fields.push(("epochIndex", Expr::int(0)));
    parent_fields.push(("epochSpent", Expr::int(0)));
    parent_fields.push(("reserveRoot", Expr::bytes(chain.to_vec())));

    let mut states = vec![struct_object("State", parent_fields)];
    for k in kids {
        states.push(child_state(tree.root(), k.key, &k.child));
    }
    let new_states = Expr::array(
        TypeRef { base: TypeBase::Custom("State".to_string()), array_dims: vec![ArrayDim::Dynamic] },
        states,
    );

    let in_value: u64 = 10_000_000_000;
    let build = |sig: Vec<u8>| {
        let mut outs = vec![TransactionOutput {
            value: in_value.saturating_sub(total.max(0) as u64).saturating_sub(1_000),
            script_public_key: pay_to_script_hash_script(&parent_next.bytecode),
            covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
        }];
        for (k, c) in kids.iter().zip(child_contracts.iter()) {
            outs.push(TransactionOutput {
                value: k.child.budget.max(0) as u64,
                script_public_key: pay_to_script_hash_script(&c.bytecode),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
            });
        }
        // The EMPTY subset witness: "these children inherit the parent's
        // allowlist exactly", which is what every case here intends.
        let args = vec![
            new_states.clone(),
            Expr::array(
                TypeRef { base: TypeBase::Byte, array_dims: vec![ArrayDim::Fixed(32), ArrayDim::Dynamic] },
                vec![],
            ),
            Expr::array(TypeRef { base: TypeBase::Bool, array_dims: vec![ArrayDim::Dynamic] }, vec![]),
            Expr::bytes(sig),
        ];
        Transaction::new(
            1,
            vec![tx_input(0, sigscript(&parent, "delegate", args))],
            outs,
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

fn kid(i: u8) -> Kid {
    Kid { child: Child::narrower(), key: [0x90 + i; 32] }
}

/// A case C1 must satisfy: what is attempted, what must happen, and the rule
/// that must be the one to make it happen.
struct Case {
    attempt: &'static str,
    expect_accept: bool,
    because: &'static str,
    /// Whether v4 can answer it. A case that needs more than one child cannot
    /// be tested until C1 exists, and saying so is the whole point.
    testable_on_v4: bool,
}

fn main() {
    println!("C1 — conservation across N children\n");

    // ---- the builder, proved ------------------------------------------
    //
    // Every line below that means anything is a FLIP: it derives from a
    // baseline the engine accepted and changes exactly one field, so the
    // refusal can only have been caused by that field. audit.rs says why —
    // "assert!(is_err()) against a baseline that never passed proves nothing:
    // the transaction might be refused for any reason at all." The engine's
    // own message is the same sentence for every refusal, so the construction
    // has to carry the meaning rather than the error text.
    println!("BUILDER");
    let one = delegate_n(&[kid(0)], &ParentClaim::default());
    match &one {
        Ok(()) => println!("  N = 1, honest              ACCEPTED   — the baseline. Every flip below derives from it."),
        Err(e) => {
            println!("  N = 1, honest              REFUSED — {e}");
            println!("\n  The builder is wrong, not the covenant. Nothing below means anything:");
            println!("  a case list run through a builder that cannot construct a valid");
            println!("  delegation reports the builder's shape, not the covenant's rules.");
            std::process::exit(1);
        }
    }
    let over = delegate_n(&[kid(0), kid(1)], &ParentClaim::default());
    println!(
        "  N = 2, honest              {}   [NOT a flip — see below]",
        match &over {
            Ok(()) => "ACCEPTED   — v4 was supposed to refuse this. Read the covenant before reading anything else.".to_string(),
            Err(e) => format!("REFUSED — {e}"),
        }
    );
    // The conservation lever, exercised at N = 1 where v4 CAN answer. These
    // two reproduce audit.rs's known result through the new builder, which is
    // the check that matters: a generalisation that still refuses an
    // under-reserve and an over-reserve has preserved the behaviour it
    // generalised, and one that does not has broken it silently.
    let budget = Child::narrower().budget;
    for (label, claim) in [
        ("under-reserve by 1", ParentClaim { reserved: Some(budget - 1), chain: None }),
        ("over-reserve by 1", ParentClaim { reserved: Some(budget + 1), chain: None }),
    ] {
        let r = delegate_n(&[kid(0)], &claim);
        println!(
            "  N = 1, {label:<18} {}   [flip of the accepted baseline: meaningful]",
            match &r {
                Ok(()) => "ACCEPTED   — conservation is NOT being checked. Stop and read the covenant.".to_string(),
                Err(e) => format!("REFUSED — {e}"),
            }
        );
    }

    let three = delegate_n(&[kid(0), kid(1), kid(2)], &ParentClaim::default());
    println!(
        "  N = 3, honest              {}   [NOT a flip — see below]",
        match &three {
            Ok(()) => "ACCEPTED   — v4 was supposed to refuse this too.".to_string(),
            Err(e) => format!("REFUSED — {e}"),
        }
    );

    println!();
    println!("  The two N = 1 flips are evidence: the baseline was accepted, one field moved,");
    println!("  and the engine refused. The N = 2 and N = 3 lines are NOT — there is no");
    println!("  accepted multi-child baseline to flip against on v4, so all they show is that");
    println!("  the arity check refuses them. They say nothing about conservation, and the");
    println!("  engine's message is the same sentence either way.");

    // ---- the specification ---------------------------------------------
    let cases = [
        Case { attempt: "N properly attenuated children", expect_accept: true,
               because: "delegate accepts a fanout whose every child is narrower on all six axes", testable_on_v4: false },
        Case { attempt: "N+1 children where N were reserved", expect_accept: false,
               because: "OpAuthOutputCount == N+1, and the reserve must account for every authorised output", testable_on_v4: false },
        Case { attempt: "reserve is the sum of the budgets minus one", expect_accept: false,
               because: "parentNext.reserved == reserved + sum(child.budgetTotal), an equality", testable_on_v4: true },
        Case { attempt: "reserve is the sum of the budgets plus one", expect_accept: false,
               because: "the same equality — over-reserving is safe for the principal and still refused", testable_on_v4: true },
        Case { attempt: "child 2 of 3 reserved twice, child 3 not at all", expect_accept: false,
               because: "the sum is right and the chain is not; the chain is what names WHICH children", testable_on_v4: false },
        Case { attempt: "the LAST child exceeds the parent on one axis", expect_accept: false,
               because: "attenuation is checked for every child, not for the first one", testable_on_v4: false },
        Case { attempt: "the FIRST child exceeds the parent on one axis", expect_accept: false,
               because: "the same rule; v4 already proves it at N = 1", testable_on_v4: true },
        Case { attempt: "the same child appears at two output indices", expect_accept: false,
               because: "one delegation creates distinct authorities; two outputs under one key is one authority issued twice", testable_on_v4: false },
        Case { attempt: "chain pushed in an order other than output order", expect_accept: false,
               because: "settlement pops the chain from the end, so the order IS the LIFO discipline", testable_on_v4: false },
        Case { attempt: "one child's id omitted from the chain", expect_accept: false,
               because: "an unchained child can never be reabsorbed, and its coin leaves the tree's accounting", testable_on_v4: false },
        Case { attempt: "a child starts with spentTotal or reserved non-zero", expect_accept: false,
               because: "a child starts clean; v4 already proves it at N = 1", testable_on_v4: true },
        Case { attempt: "child 2 narrows the allowlist and child 3 widens it", expect_accept: false,
               because: "a child may narrow to a subtree and never widen, per child", testable_on_v4: true },
    ];

    println!("\nSPECIFICATION  ({} cases)", cases.len());
    let mut pending = 0;
    for c in &cases {
        let mark = if c.testable_on_v4 { "v4 covers the N = 1 form" } else { pending += 1; "PENDING — needs C1" };
        println!("  [{}] {:<52} {}", if c.expect_accept { "accept" } else { "refuse" }, c.attempt, mark);
        println!("       {}", c.because);
    }

    println!("\n{pending} of {} cases cannot be tested until C1 exists. They are refused today", cases.len());
    println!("by the fanout arity, before any rule they name is reached — which is a refusal");
    println!("for the wrong reason, and is reported here as pending rather than as passing.");
    println!("\nThe two worth writing first are the ones a loop gets wrong: a violation in the");
    println!("LAST child rather than the first, and the same child counted twice. Both pass a");
    println!("check written for one child and applied N times carelessly.");

    v5_suite();
    settle_suite();

    let argv: Vec<String> = std::env::args().collect();
    if let Some(i) = argv.iter().position(|a| a == "--emit") {
        match argv.get(i + 1) {
            Some(path) => emit_golden(path),
            None => {
                println!("\n--emit needs a path: --emit ../../sdk/golden-delegation2.json");
                std::process::exit(2);
            }
        }
    }
}

// ===========================================================================
// v5 — the same specification, against a covenant that has `delegate2`.
//
// Everything above runs on v4 and reports what v4 cannot answer. Everything
// below runs on covenant/warda_grant_v5.sil and answers it. The two live in
// one file on purpose: the cases are the same cases, and a suite that moved
// house when the covenant changed would be a suite nobody could compare.
// ===========================================================================

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
fn v5_authority() -> Authority {
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
const TEMPLATE_MAX_FEE: i64 = 5_000_000;

fn v5_ctor_base() -> Vec<Expr<'static>> {
    let geo = template_geometry_of(SOURCE_V5);
    let tid = template_id_of(SOURCE_V5, v5_authority());
    let mut v = ctor_full(proof_depth(), v5_authority(), tid, geo);
    v[2] = Expr::int(TEMPLATE_MAX_FEE);
    v
}

fn v5_parent_ctor(root: [u8; 32], agent: [u8; 32], spent: i64, reserved: i64, chain: [u8; 32]) -> Vec<Expr<'static>> {
    let mut v = v5_ctor_base();
    v[3] = Expr::bytes(agent.to_vec());
    v[8] = Expr::bytes(root.to_vec());
    v[16] = Expr::int(spent);
    v[17] = Expr::int(reserved);
    v[20] = Expr::bytes(chain.to_vec());
    v
}

fn v5_child_ctor(root: [u8; 32], key: [u8; 32], ch: &Child) -> Vec<Expr<'static>> {
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

fn v5_child_state(root: [u8; 32], key: [u8; 32], ch: &Child) -> Expr<'static> {
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
            ("templateId", Expr::bytes(template_id_of(SOURCE_V5, v5_authority()).to_vec())),
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
#[derive(Default)]
struct Flip {
    /// The chain pushed B-then-A instead of A-then-B.
    reverse_chain: bool,
    /// Both children under the same agent key.
    same_key: bool,
    /// `parentNext.reserved`, when it should not be the honest sum.
    reserved: Option<i64>,
    /// What the parent had already committed before this delegation. Needed to
    /// separate the SEQUENTIAL budget bound from the input-value check: with an
    /// empty parent both refuse the same transaction, and a case refused for
    /// two reasons tests neither.
    prev_reserved: i64,
}

/// The sighash the agent signs, recomputed rather than taken on trust — the
/// golden vector's whole job is to let the SDK check its own against it.
fn sighash_of(tx: &Transaction, entries: &[UtxoEntry], idx: usize) -> [u8; 32] {
    let mtx = MutableTransaction::with_entries(tx.clone(), entries.to_vec());
    let reused = SigHashReusedValuesUnsync::new();
    // Bound to a local: the verifiable view borrows `mtx`, and returning the
    // expression directly drops `mtx` while that borrow is still live.
    let h = calc_schnorr_signature_hash(&mtx.as_verifiable(), idx, SIG_HASH_ALL, &reused).as_bytes();
    h
}

fn delegate2_run(a: &Child, b: &Child, f: &Flip) -> Result<(), TxScriptError> {
    delegate2_artifacts(a, b, f).0
}

/// The same build, returning what it built. One implementation, so the vector
/// and the verdict cannot describe two different transactions.
fn delegate2_artifacts(
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
        SOURCE_V5,
        &v5_parent_ctor(tree.root(), agent_xonly, 0, f.prev_reserved, empty_reserve()),
        CompileOptions::default(),
    )
    .expect("v5 parent compiles");

    let cid = |key: [u8; 32], ch: &Child| {
        child_id(key, ch.budget, ch.max_per_spend, ch.epoch_limit, 1_000,
                 ch.root.unwrap_or(tree.root()), ch.not_before, ch.expires_at, ch.delegation_depth)
    };
    let chain = if f.reverse_chain {
        push_child(push_child(empty_reserve(), cid(key_b, b)), cid(key_a, a))
    } else {
        push_child(push_child(empty_reserve(), cid(key_a, a)), cid(key_b, b))
    };
    let total = a.budget + b.budget;
    let reserved_after = f.reserved.unwrap_or(f.prev_reserved + total);

    let parent_next = compile_contract(
        SOURCE_V5,
        &v5_parent_ctor(tree.root(), agent_xonly, 0, reserved_after, chain),
        CompileOptions::default(),
    )
    .expect("v5 successor compiles");
    let ca = compile_contract(SOURCE_V5, &v5_child_ctor(tree.root(), key_a, a), CompileOptions::default()).expect("child A compiles");
    let cb = compile_contract(SOURCE_V5, &v5_child_ctor(tree.root(), key_b, b), CompileOptions::default()).expect("child B compiles");

    let mut pf = authority_fields(tree.root(), agent_xonly);
    // authority_fields bakes v4's templateId, and this covenant is not v4.
    for field in pf.iter_mut() {
        if field.0 == "templateId" {
            field.1 = Expr::bytes(template_id_of(SOURCE_V5, v5_authority()).to_vec());
        }
    }
    pf.push(("spentTotal", Expr::int(0)));
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

fn v5_suite() {
    println!("\n\nv5 — delegate2, against covenant/warda_grant_v5.sil\n");
    let base = || Child::narrower();

    let baseline = delegate2_run(&base(), &base(), &Flip::default());
    match &baseline {
        Ok(()) => println!("  two children, honest          ACCEPTED   — the baseline. Every flip derives from it."),
        Err(e) => {
            println!("  two children, honest          REFUSED — {e}");
            println!("\n  No accepted baseline, so no flip below means anything. Fix this first:");
            println!("  a refusal here is the builder, the geometry or the covenant, and the");
            println!("  engine's message does not say which.");
            return;
        }
    }

    // Each of these moves exactly one thing.
    // The SEQUENTIAL bound needs a parent with something already committed,
    // so the sum can exceed the headroom while staying under the input value.
    // Its own baseline, because a flip is only a flip from something accepted.
    let committed = Flip { prev_reserved: 60 * KAS, ..Default::default() };
    let mut small = base(); small.budget = 5 * KAS;
    let seq_base = delegate2_run(&small, &small, &committed);
    println!("  60 KAS already reserved, 5 + 5  {}",
        match &seq_base { Ok(()) => "ACCEPTED   — the second baseline".to_string(), Err(e) => format!("REFUSED — {e}") });
    let mut over_a = base(); over_a.budget = 30 * KAS;
    let mut over_b = base(); over_b.budget = 30 * KAS;
    let mut wide_b = base(); wide_b.max_per_spend = 500 * KAS;      // above the parent's 2 KAS
    let mut wide_a = base(); wide_a.max_per_spend = 500 * KAS;
    let mut dirty_b = base(); dirty_b.accounting = (1, 0, 0, 0);

    let cases: Vec<(&str, Result<(), TxScriptError>, bool)> = vec![
        ("each fits, together they do not", delegate2_run(&over_a, &over_b, &Flip { prev_reserved: 60 * KAS, ..Default::default() }), false),
        ("both children under one key", delegate2_run(&base(), &base(), &Flip { same_key: true, ..Default::default() }), false),
        ("chain pushed B then A", delegate2_run(&base(), &base(), &Flip { reverse_chain: true, ..Default::default() }), false),
        ("reserve is the sum minus one", delegate2_run(&base(), &base(), &Flip { reserved: Some(50 * KAS - 1), ..Default::default() }), false),
        ("reserve is the sum plus one", delegate2_run(&base(), &base(), &Flip { reserved: Some(50 * KAS + 1), ..Default::default() }), false),
        ("the LAST child exceeds maxPerSpend", delegate2_run(&base(), &wide_b, &Flip::default()), false),
        ("the FIRST child exceeds maxPerSpend", delegate2_run(&wide_a, &base(), &Flip::default()), false),
        ("the LAST child starts with spentTotal 1", delegate2_run(&base(), &dirty_b, &Flip::default()), false),
    ];

    let mut wrong = 0;
    for (name, got, expect_accept) in &cases {
        let accepted = got.is_ok();
        let ok = accepted == *expect_accept;
        if !ok { wrong += 1; }
        println!("  {:<30} {:<10} {}", name,
            if accepted { "ACCEPTED" } else { "refused" },
            if ok { "" } else { "  <-- NOT what the covenant claims" });
    }
    println!();
    if wrong == 0 {
        println!("  {} flips, every one refused, each one field from an accepted baseline.", cases.len());
    } else {
        println!("  {wrong} of {} did not behave as delegate2 claims. Read the covenant.", cases.len());
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// Settling what delegate2 created.
//
// C2 (a 1:N reabsorb) is an optimisation, not a prerequisite: v4's `reabsorb`
// should settle delegate2's children unchanged, because the chain it built is
// H(H(empty || cidA) || cidB) and popping from the end gives B then A — which
// is exactly what reabsorb checks. `should` is the word that preceded the v4
// pre-release bug where a child with live grandchildren released its parent's
// full reserve and the grandchildren's coin left every grant's accounting.
//
// So this walks it. Two settlements, in order, each one a real transaction the
// engine either accepts or does not.
// ---------------------------------------------------------------------------

/// One `reabsorb` + `settle` pair against v5. Returns the parent's state after
/// it, so the caller can walk the chain down.
struct Unwind {
    spent: i64,
    reserved: i64,
    chain: [u8; 32],
    value: u64,
}

fn reabsorb_step(
    root: [u8; 32],
    agent: [u8; 32],
    before: &Unwind,
    child: &Child,
    child_key: [u8; 32],
    child_spent: i64,
    prev_root: [u8; 32],
) -> (Result<(), TxScriptError>, Unwind) {
    let agent_kp = agent_keypair();
    let rev_kp = revocation_keypair();
    let tid = template_id_of(SOURCE_V5, v5_authority());

    let parent = compile_contract(
        SOURCE_V5,
        &v5_parent_ctor(root, agent, before.spent, before.reserved, before.chain),
        CompileOptions::default(),
    )
    .expect("parent compiles");

    let after = Unwind {
        spent: before.spent + child_spent,
        reserved: before.reserved - child.budget,
        chain: prev_root,
        value: 0, // filled below
    };
    let parent_next = compile_contract(
        SOURCE_V5,
        &v5_parent_ctor(root, agent, after.spent, after.reserved, after.chain),
        CompileOptions::default(),
    )
    .expect("successor compiles");

    // The child AS IT IS when settled: its identity is immutable, so a child
    // that has been spending still matches the id its parent committed to.
    let mut spent_child = child.clone();
    spent_child.accounting = (child_spent, 0, 0, 0);
    let child_c = compile_contract(
        SOURCE_V5,
        &v5_child_ctor(root, child_key, &spent_child),
        CompileOptions::default(),
    )
    .expect("child compiles");

    let mut fields = authority_fields(root, agent);
    for f in fields.iter_mut() {
        if f.0 == "templateId" { f.1 = Expr::bytes(tid.to_vec()); }
    }
    fields.push(("spentTotal", Expr::int(after.spent)));
    fields.push(("reserved", Expr::int(after.reserved)));
    fields.push(("epochIndex", Expr::int(0)));
    fields.push(("epochSpent", Expr::int(0)));
    fields.push(("reserveRoot", Expr::bytes(prev_root.to_vec())));
    let new_states = Expr::array(
        TypeRef { base: TypeBase::Custom("State".to_string()), array_dims: vec![ArrayDim::Dynamic] },
        vec![struct_object("State", fields)],
    );

    let child_value = (child.budget - child_spent).max(0) as u64;
    let combined = before.value + child_value;
    let out_value = combined.saturating_sub(1_000);

    let build = |psig: Vec<u8>, csig: Vec<u8>| {
        Transaction::new(
            1,
            vec![
                tx_input(0, sigscript(&parent, "reabsorb", vec![
                    new_states.clone(),
                    Expr::int(1),
                    Expr::bytes(prev_root.to_vec()),
                    Expr::bytes(psig),
                ])),
                tx_input(1, plain_sigscript(&child_c, "settle", vec![Expr::bytes(csig)])),
            ],
            vec![TransactionOutput {
                value: out_value,
                script_public_key: pay_to_script_hash_script(&parent_next.bytecode),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
            }],
            0, Default::default(), 0, vec![],
        )
    };

    let entries = vec![covenant_utxo(&parent, before.value), covenant_utxo(&child_c, child_value)];
    let unsigned = build(vec![0u8; 65], vec![0u8; 65]);
    let psig = sign_input(unsigned.clone(), entries.clone(), 0, &agent_kp);
    let csig = sign_input(unsigned, entries.clone(), 1, &rev_kp);
    let verdict = execute_all(build(psig, csig), entries);
    (verdict, Unwind { value: out_value, ..after })
}

fn settle_suite() {
    println!("\nSETTLING WHAT delegate2 CREATED  (v4's reabsorb, unchanged)\n");
    let kp = agent_keypair();
    let agent: [u8; 32] = kp.x_only_public_key().0.serialize();
    let tree = Tree::new(members());
    let root = tree.root();
    let a = Child::narrower();
    let b = Child::narrower();
    let key_a = [0x90u8; 32];
    let key_b = [0x91u8; 32];
    let cid = |key: [u8; 32], ch: &Child| {
        child_id(key, ch.budget, ch.max_per_spend, ch.epoch_limit, 1_000,
                 ch.root.unwrap_or(root), ch.not_before, ch.expires_at, ch.delegation_depth)
    };
    let after_a = push_child(empty_reserve(), cid(key_a, &a));
    let after_b = push_child(after_a, cid(key_b, &b));

    // THE CONTROL, and it comes first because without it nothing below is
    // readable. This settle builder is new — a fresh construction against v5,
    // never proved against anything. A refusal from an unproved builder says
    // "this builder produced a transaction the engine would not take", which
    // is a sentence about the builder and not about the covenant.
    //
    // So: settle a child of a SINGLE-child delegate, where the chain is
    // H(empty || cidA) and reabsorb's own tests already say the shape works.
    // If this is refused, every line after it is noise.
    let single = Unwind {
        spent: 0,
        reserved: a.budget,
        chain: after_a,
        value: 10_000_000_000u64.saturating_sub(a.budget as u64).saturating_sub(1_000),
    };
    let (control, _) = reabsorb_step(root, agent, &single, &a, key_a, 5 * KAS, empty_reserve());
    match &control {
        Ok(()) => println!("  CONTROL: one child, one chain ACCEPTED   — the settle builder works"),
        Err(e) => {
            println!("  CONTROL: one child, one chain REFUSED — {e}");
            println!();
            println!("  The builder cannot settle even a single-child chain, which v4's own");
            println!("  tests do settle. So this is the construction, not the covenant, and");
            println!("  nothing below would mean anything. Fix the builder first.");
            return;
        }
    }

    // Exactly what delegate2 leaves behind, with the same arithmetic the
    // builder above uses — so this starts where that ended rather than at a
    // state somebody typed.
    let total = a.budget + b.budget;
    let start = Unwind {
        spent: 0,
        reserved: total,
        chain: after_b,
        value: 10_000_000_000u64.saturating_sub(total as u64).saturating_sub(1_000),
    };

    // B first: the chain pops from the end, and B was pushed last.
    let (v1, mid) = reabsorb_step(root, agent, &start, &b, key_b, 5 * KAS, after_a);
    println!("  settle B (hired last)         {}",
        match &v1 { Ok(()) => "ACCEPTED   — v4's reabsorb settles a delegate2 child unchanged".to_string(), Err(e) => format!("REFUSED — {e}") });

    if v1.is_ok() {
        let (v2, end) = reabsorb_step(root, agent, &mid, &a, key_a, 5 * KAS, empty_reserve());
        println!("  then settle A                 {}",
            match &v2 { Ok(()) => format!("ACCEPTED   — reserved back to {}, chain empty again", end.reserved), Err(e) => format!("REFUSED — {e}") });
        if v2.is_ok() && end.reserved != 0 {
            println!("  reserve did NOT return to zero: {} left committed", end.reserved);
            std::process::exit(1);
        }
    }

    // A first, which the LIFO discipline must refuse: no prevRoot the prover
    // can supply satisfies reserveRoot == H(prevRoot || cidA) when the chain
    // ends in cidB.
    let (out_of_order, _) = reabsorb_step(root, agent, &start, &a, key_a, 5 * KAS, after_a);
    println!("  settle A first, out of order  {}",
        match &out_of_order { Ok(()) => "ACCEPTED   <-- the LIFO discipline is NOT enforced".to_string(), Err(e) => format!("refused — {e}") });

    if out_of_order.is_ok() {
        println!("\n  The LIFO discipline is NOT enforced: a parent settled its first child");
        println!("  while the chain ended in its second. That is the door the grandchildren");
        println!("  bug came through.");
        std::process::exit(1);
    }
    if v1.is_err() {
        println!("\n  The control passed and this did not, so the two-child chain is the");
        println!("  difference: v4's reabsorb does NOT settle what delegate2 created, and C2");
        println!("  is a prerequisite rather than an optimisation. V5.md says the opposite.");
        println!("  Fix the file before touching the covenant.");
        std::process::exit(1);
    }
}

// ---------------------------------------------------------------------------
// The golden vector, for the SDK.
//
// Nothing in JavaScript can build a delegate2 transaction yet. When it can,
// the question is whether what it builds is what the chain accepts — and the
// SDK has no engine to ask. The repo's answer for `delegate` is a golden
// vector emitted by the Rust side and compared byte-for-byte in
// sdk/test/delegate.test.ts.
//
// This is the same thing for delegate2, with one difference worth having: the
// existing goldens are emitted by a builder, and this one is emitted by a
// transaction the ENGINE ACCEPTED two functions above. A vector that merely
// records what some code produced pins that code's behaviour; this pins
// behaviour the engine agreed with.
//
// It emits the UNSIGNED form. The signature script with a placeholder, the
// sighash, and every output's scriptPublicKey are deterministic; the signature
// is not — secp256k1's schnorr signing takes auxiliary randomness — so a
// vector containing one would fail against an SDK that is behaving perfectly.
// ---------------------------------------------------------------------------

/* The compute budget `tx_input` commits to. The field on TransactionInput is
   `compute_commit`, an encoded form rather than the number, so the number is
   named here instead of decoded back out of it — and a drift cannot pass
   silently: the commit is covered by the sighash, so a harness that changed it
   would produce a vector whose sighash no SDK could reproduce. */
const COMPUTE_BUDGET: u64 = 1000;

fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn emit_golden(path: &str) {
    let kp = agent_keypair();
    let agent: [u8; 32] = kp.x_only_public_key().0.serialize();
    let tree = Tree::new(members());
    let root = tree.root();
    let a = Child::narrower();
    let b = Child::narrower();
    let key_a = [0x90u8; 32];
    let key_b = [0x91u8; 32];
    let auth = v5_authority();
    let tid = template_id_of(SOURCE_V5, auth);

    // Exactly what the accepted baseline builds, rebuilt here so the vector and
    // the verdict cannot describe two different transactions.
    let (verdict, tx, entry, sighash) = delegate2_artifacts(&a, &b, &Flip::default());

    let outs = tx.outputs.iter().map(|o| format!(
        "    {{ \"value\": {}, \"scriptPublicKeyVersion\": {}, \"scriptPublicKeyHex\": \"{}\", \"covenant\": {{ \"authorizingInput\": 0, \"covenantId\": \"{}\" }} }}",
        o.value, o.script_public_key.version(), hexs(o.script_public_key.script()), hexs(COV.as_bytes().as_slice())
    )).collect::<Vec<_>>().join(",\n");

    let members_json = members().iter().map(|m| format!("\"{}\"", hexs(m))).collect::<Vec<_>>().join(", ");

    let json = format!(
"{{
  \"generatedBy\": \"warda-harness c1 --emit\",
  \"note\": \"An atomic 1:3 fanout: the parent continues at output 0 and TWO children are created at 1 and 2. Emitted from a transaction TxScriptEngine accepted, not from a builder — the engine verdict is recorded below. Unsigned: the signature script carries a 65-byte placeholder, because schnorr signing is randomised and a signature here would fail an SDK that is correct.\",
  \"engine\": \"{}\",
  \"params\": {{
    \"principalKey\": \"{}\",
    \"revocationKey\": \"{}\",
    \"agentKey\": \"{}\",
    \"templateId\": \"{}\",
    \"recipientsRoot\": \"{}\",
    \"recipients\": [{}],
    \"budgetTotal\": {},
    \"maxPerSpend\": {},
    \"epochLimit\": {},
    \"epochLength\": {},
    \"notBefore\": {},
    \"expiresAt\": {},
    \"delegationDepth\": {},
    \"spentTotal\": 0,
    \"reserved\": 0,
    \"epochIndex\": 0,
    \"epochSpent\": 0,
    \"reserveRoot\": \"{}\"
  }},
  \"children\": [
    {{ \"agentKey\": \"{}\", \"budgetTotal\": {}, \"maxPerSpend\": {}, \"epochLimit\": {}, \"notBefore\": {}, \"expiresAt\": {}, \"delegationDepth\": {} }},
    {{ \"agentKey\": \"{}\", \"budgetTotal\": {}, \"maxPerSpend\": {}, \"epochLimit\": {}, \"notBefore\": {}, \"expiresAt\": {}, \"delegationDepth\": {} }}
  ],
  \"utxo\": {{
    \"outpointTransactionId\": \"{}\",
    \"outpointIndex\": {},
    \"value\": {},
    \"blockDaaScore\": {},
    \"isCoinbase\": {},
    \"covenantId\": \"{}\",
    \"scriptPublicKeyVersion\": {},
    \"scriptPublicKeyHex\": \"{}\"
  }},
  \"sighashHex\": \"{}\",
  \"unsignedSignatureScriptHex\": \"{}\",
  \"transaction\": {{
    \"version\": {},
    \"lockTime\": \"{}\",
    \"subnetworkId\": \"0000000000000000000000000000000000000000\",
    \"gas\": \"{}\",
    \"payloadHex\": \"{}\",
    \"input\": {{ \"previousOutpointTransactionId\": \"{}\", \"previousOutpointIndex\": {}, \"sequence\": \"{}\", \"computeBudget\": {} }},
    \"outputs\": [
{}
    ]
  }}
}}
",
        match &verdict { Ok(()) => "ACCEPTED".to_string(), Err(e) => format!("REFUSED — {e}") },
        hexs(&auth.principal), hexs(&auth.revocation), hexs(&agent), hexs(&tid), hexs(&root), members_json,
        10_000_000_000i64, 200_000_000i64, 1_000_000_000i64, 1_000i64, 1_000_000i64, 1_007_000i64, 2i64,
        hexs(&empty_reserve()),
        hexs(&key_a), a.budget, a.max_per_spend, a.epoch_limit, a.not_before, a.expires_at, a.delegation_depth,
        hexs(&key_b), b.budget, b.max_per_spend, b.epoch_limit, b.not_before, b.expires_at, b.delegation_depth,
        hexs(tx.inputs[0].previous_outpoint.transaction_id.as_bytes().as_slice()), tx.inputs[0].previous_outpoint.index,
        entry.amount, entry.block_daa_score, entry.is_coinbase, hexs(COV.as_bytes().as_slice()),
        entry.script_public_key.version(), hexs(entry.script_public_key.script()),
        hexs(&sighash), hexs(&tx.inputs[0].signature_script),
        tx.version, tx.lock_time, tx.gas, hexs(&tx.payload),
        hexs(tx.inputs[0].previous_outpoint.transaction_id.as_bytes().as_slice()), tx.inputs[0].previous_outpoint.index,
        tx.inputs[0].sequence, COMPUTE_BUDGET,
        outs);

    std::fs::write(path, &json).expect("write the golden vector");
    println!("\nwrote {path}  (engine: {})", match &verdict { Ok(()) => "ACCEPTED", Err(_) => "REFUSED" });
    if verdict.is_err() {
        println!("  and it is a vector for a transaction the engine REFUSED. Do not ship it.");
        std::process::exit(1);
    }
}
