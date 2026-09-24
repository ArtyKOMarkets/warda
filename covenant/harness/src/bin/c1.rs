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
use kaspa_consensus_core::tx::{CovenantBinding, Transaction, TransactionOutput};
use kaspa_txscript::pay_to_script_hash_script;
use kaspa_txscript_errors::TxScriptError;
use silverscript_lang::ast::{ArrayDim, Expr, TypeBase, TypeRef};
use silverscript_lang::compiler::{compile_contract, struct_object, CompileOptions};
use warda_harness::{
    agent_keypair, authority_fields, child_ctor, child_id, child_state, covenant_utxo,
    ctor_at_state, ctor_at_state_with_reserve, empty_reserve, execute, members, proof_depth,
    push_child, sign_input, sigscript, template_geometry_of, template_id_of, tx_input,
    Child, Tree, COV, KAS, SOURCE, SOURCE_V5,
};
use warda_harness::{ctor_full, default_authority};

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
fn v5_ctor_base() -> Vec<Expr<'static>> {
    let geo = template_geometry_of(SOURCE_V5);
    let tid = template_id_of(SOURCE_V5, default_authority());
    ctor_full(proof_depth(), default_authority(), tid, geo)
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
            ("templateId", Expr::bytes(template_id_of(SOURCE_V5, default_authority()).to_vec())),
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

fn delegate2_run(a: &Child, b: &Child, f: &Flip) -> Result<(), TxScriptError> {
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
            field.1 = Expr::bytes(template_id_of(SOURCE_V5, default_authority()).to_vec());
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
    let sig = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &kp);
    execute(build(sig), entries, 0)
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
