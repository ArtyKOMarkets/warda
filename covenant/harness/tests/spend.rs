//! Warda spend covenant — execution proof.
//!
//! The builders live in `src/lib.rs` so this suite and `src/bin/audit.rs` run
//! against ONE copy of them. Two copies of an argument list is this repo's
//! most expensive recurring shape, and it has already broken this file once:
//! `ctor()` declared itself "v2 constructor order" for two covenant versions
//! while `covenant/deploy` moved on, and 32 of 33 tests failed to compile
//! with nobody watching.

use kaspa_consensus_core::tx::{
    CovenantBinding, ScriptPublicKey, Transaction, TransactionId, TransactionInput,
    TransactionOutpoint, TransactionOutput,
};
use kaspa_txscript::pay_to_script_hash_script;
use kaspa_txscript_errors::TxScriptError;
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{compile_contract, CompileOptions};
use warda_harness::*;

#[test]
fn covenant_compiles_and_exposes_expected_abi() {
    let c = compile(16);
    let names: Vec<_> = c.abi.iter().map(|e| e.name.clone()).collect();
    println!("bytecode = {} bytes", c.bytecode.len());
    println!("abi = {names:?}");
    assert!(names.iter().any(|n| n.contains("spend")), "spend entrypoint present");
    assert!(names.iter().any(|n| n.contains("delegate")), "delegate entrypoint present");
    assert!(names.iter().any(|n| n == "revoke"));
    assert!(names.iter().any(|n| n == "reclaim"));
    // Bloat guard. It has earned its keep twice: it caught delegation pushing
    // the covenant past 2,500 bytes, and it caught v4 at 8,680 — more than
    // double the 4,200 it was set to, because the guard was written for a
    // covenant two versions ago and nothing re-ran it.
    //
    // The number to compare against is NOT folklore. MAX_SCRIPTS_SIZE_POST_TOCCATA
    // is 1,000,000 bytes (see LIMITS.md), so 8,680 is 0.87% of the ceiling with
    // ~115x headroom. The earlier worry about 3,888 bytes being risky was
    // measured against a limit that does not exist.
    //
    // So this guards BLOAT, not safety: it exists to make a covenant that
    // doubles in size announce itself. Raise it deliberately, and say why.
    assert!(c.bytecode.len() < 12_000, "bytecode grew unexpectedly: {}", c.bytecode.len());
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

#[test]
fn delegation_baseline_is_accepted() {
    let r = run_delegation(&Child::narrower(), None);
    println!("delegation baseline -> {r:?}");
    assert!(r.is_ok(), "a properly attenuated child must be accepted: {r:?}");
}

#[test]
fn delegate_child_raising_per_spend_cap_rejected() {
    let mut ch = Child::narrower();
    ch.max_per_spend = 10 * KAS; // parent allows 2
    let r = run_delegation(&ch, None);
    println!("child cap raised     -> {r:?}");
    assert!(r.is_err(), "a child must not exceed its parent's per-spend cap");
}

#[test]
fn delegate_child_raising_epoch_limit_rejected() {
    let mut ch = Child::narrower();
    ch.epoch_limit = 50 * KAS; // parent allows 10
    let r = run_delegation(&ch, None);
    println!("child epoch raised   -> {r:?}");
    assert!(r.is_err(), "a child must not exceed its parent's epoch limit");
}

#[test]
fn delegate_child_outliving_parent_rejected() {
    let mut ch = Child::narrower();
    ch.expires_at = 2_000_000; // parent expires at 1_007_000
    let r = run_delegation(&ch, None);
    println!("child outlives       -> {r:?}");
    assert!(r.is_err(), "a child must not outlive its parent");
}

#[test]
fn delegate_child_starting_before_parent_rejected() {
    let mut ch = Child::narrower();
    ch.not_before = 999_000; // parent opens at 1_000_000
    let r = run_delegation(&ch, None);
    println!("child starts early   -> {r:?}");
    assert!(r.is_err(), "a child must not open before its parent");
}

#[test]
fn delegate_depth_cannot_be_extended() {
    let mut ch = Child::narrower();
    ch.delegation_depth = 2; // parent is 2; child must be strictly less
    let r = run_delegation(&ch, None);
    println!("child depth equal    -> {r:?}");
    assert!(r.is_err(), "delegation depth must strictly decrease");
}

#[test]
fn delegate_child_widening_allowlist_rejected() {
    let mut ch = Child::narrower();
    ch.root = Some([0xee; 32]);
    let r = run_delegation(&ch, None);
    println!("child root swapped   -> {r:?}");
    assert!(r.is_err(), "a child must not carry a different recipient root");
}

#[test]
fn delegate_child_born_pre_spent_rejected() {
    let mut ch = Child::narrower();
    ch.accounting = (0, 0, 0, -5 * KAS); // negative epochSpent = free allowance
    let r = run_delegation(&ch, None);
    println!("child born pre-spent -> {r:?}");
    assert!(r.is_err(), "a child must start with zeroed accounting");
}

#[test]
fn delegate_child_exceeding_available_budget_rejected() {
    let mut ch = Child::narrower();
    ch.budget = 200 * KAS; // parent's whole budget is 100 KAS
    let r = run_delegation(&ch, None);
    println!("child over-budget    -> {r:?}");
    assert!(r.is_err(), "a child must not receive more than the parent still has");
}

#[test]
fn delegate_without_reserving_is_rejected() {
    // The attack that would break conservation outright: hand the child 25 KAS
    // of authority while the parent's reserve stays at zero, so the tree now
    // holds 125 KAS of authority against 100 KAS of budget.
    let r = run_delegation(&Child::narrower(), Some(0));
    println!("no reserve           -> {r:?}");
    assert!(r.is_err(), "delegating without reserving must be rejected");
}

#[test]
fn delegate_under_reserving_is_rejected() {
    // Subtler: reserve something, but less than the child received.
    let ch = Child::narrower();
    let r = run_delegation(&ch, Some(ch.budget - 1));
    println!("under-reserve by 1   -> {r:?}");
    assert!(r.is_err(), "reserving less than the child's budget must be rejected");
}

#[test]
fn delegate_over_reserving_is_rejected() {
    // The mirror image. Over-reserving destroys authority rather than creating
    // it, which is safe for the principal but still not conservation — and a
    // covenant that tolerates it has a sloppy equality somewhere.
    let ch = Child::narrower();
    let r = run_delegation(&ch, Some(ch.budget + 1));
    println!("over-reserve by 1    -> {r:?}");
    assert!(r.is_err(), "reserving more than the child's budget must be rejected");
}

#[test]
fn report_compute_budget_consumption() {
    // Same construction as the accepted baseline, with the meter read out.
    let kp = agent_keypair();
    let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
    let tree = Tree::new(vec![[0xa1; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]]);
    let recipient = [0xa1u8; 32];
    let (sibs, lefts) = tree.proof(&recipient);
    let amount: i64 = KAS / 2;
    let claimed_daa: i64 = 1_000_500;
    let in_value: u64 = 10_000_000_000;

    for depth in [4i64, 8, 16] {
        let c = compile_contract(SOURCE, &ctor_with(tree.root(), agent_xonly, depth), CompileOptions::default())
            .expect("compiles");
        let successor = compile_contract(
            SOURCE,
            &ctor_at_state(tree.root(), agent_xonly, depth, amount, 0, 0, amount),
            CompileOptions::default(),
        )
        .expect("successor");

        let mut p2pk = vec![0x20u8];
        p2pk.extend_from_slice(&recipient);
        p2pk.push(0xac);

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
                vec![TransactionInput::new_with_compute_budget(
                    TransactionOutpoint { transaction_id: TransactionId::from_bytes([1; 32]), index: 0 },
                    sigscript(&c, "spend", args),
                    0,
                    u16::MAX, // generous, so the meter is not what stops us
                )],
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
        let (r, used) = measure_units(build(sig), entries.clone(), 0);
        // Peak combined stack depth, against MAX_STACK_SIZE = 244.
        let sig2 = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &kp);
        let (_, trace) = execute_traced(build(sig2), entries, 0);
        let peak = trace
            .lines()
            .map(|l| {
                let a = l.matches("astack: [").next().map(|_| l.split("astack: [").nth(1).unwrap_or(""));
                let d = l.split("dstack: [").nth(1).unwrap_or("");
                let count = |x: &str| if x.trim_start().starts_with(']') { 0 } else { x.matches("0x").count() };
                count(a.unwrap_or("")) + count(d)
            })
            .max()
            .unwrap_or(0);
        // Budget units: SCRIPT_UNITS_PER_COMPUTE_BUDGET_UNIT = 10_000, u16 max.
        /* The engine here runs with `sigop_script_units: 0`, so `used` is the
           covenant's arithmetic and Merkle fold ONLY — none of its signature
           cost. One signature verification is 100,000 script units
           (GRAMS_PER_SIGOP_COUNT_UNIT 1000 x SCRIPT_UNITS_PER_GRAM 100) and
           dwarfs everything else, so a budget figure computed from `used`
           alone understates the real charge by a factor of three.

           LIMITS.md documents this as a correction made AFTER deployment, with
           the lesson that a measurement taken with a flag set to a convenient
           value measures the flag. The bare figure was still what this line
           printed, so the trap stayed set for the next reader. Both are printed
           now, and the real one is named as such. */
        /* u64, because `used_script_units()` returns one. It was `usize`, which
           compiles nowhere and was committed anyway: this line went in one
           commit AFTER the run that reported 33/33, and nothing re-ran the
           suite in between. The commit's own subject was about the harness
           printing a stale figure. */
        const SIGOP_SCRIPT_UNITS: u64 = 100_000;
        let budget_bare = used / 10_000 + 1;
        let budget = (used + SIGOP_SCRIPT_UNITS) / 10_000 + 1;
        println!(
            "BUDGET depth={depth:<3} bytes={:<5} script_units={used:<7} budget_units_REAL={budget:<4} (bare_no_sigop={budget_bare}) peak_stack={peak:<4}/244 verdict={r:?}",
            c.bytecode.len()
        );
    }
}

#[test]
fn covenant_binding_is_committed_by_the_signature() {
    let kp = agent_keypair();
    let agent_xonly: [u8; 32] = kp.x_only_public_key().0.serialize();
    let tree = Tree::new(vec![[0xa1; 32], [0xa2; 32], [0xa3; 32], [0xa4; 32]]);
    let recipient = [0xa1u8; 32];
    let (sibs, lefts) = tree.proof(&recipient);
    let amount: i64 = KAS / 2;
    let claimed_daa: i64 = 1_000_500;
    let in_value: u64 = 10_000_000_000;

    let c = compile_contract(SOURCE, &ctor_with(tree.root(), agent_xonly, 4), CompileOptions::default())
        .expect("compiles");
    let successor = compile_contract(
        SOURCE,
        &ctor_at_state(tree.root(), agent_xonly, 4, amount, 0, 0, amount),
        CompileOptions::default(),
    )
    .expect("successor");

    let mut p2pk = vec![0x20u8];
    p2pk.extend_from_slice(&recipient);
    p2pk.push(0xac);

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
            1, // VERSION 1 — the gate. At v0 the covenant binding is not hashed.
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
    let placeholder = build(vec![0u8; 65]);

    let good_sig = sign_input(placeholder.clone(), entries.clone(), 0, &kp);
    let bad_sig = sign_input(strip_covenants(&placeholder), entries.clone(), 0, &kp);

    let accepted = execute(build(good_sig.clone()), entries.clone(), 0);
    let rejected = execute(build(bad_sig.clone()), entries, 0);

    println!("digests differ           = {}", good_sig != bad_sig);
    println!("correct signature        -> {accepted:?}");
    println!("covenant-stripped digest -> {rejected:?}");

    assert!(good_sig != bad_sig, "stripping the covenant binding must change the digest");
    assert!(accepted.is_ok(), "a correctly signed v1 covenant spend must be accepted");
    assert!(
        rejected.is_err(),
        "a signature over a covenant-stripped digest must NOT validate — this is KOM bug #3"
    );
}
