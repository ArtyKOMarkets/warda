//! Warda's covenant, audited.
//!
//! The machinery is in `warda_harness::audit` and knows nothing about Warda.
//! This file is the covenant-specific half, and it is the worked example a
//! second covenant copies: a `Subject` that names the thing and admits what
//! the run could not reach, the claims its own documentation makes, and the
//! cases that exercise them.
//!
//! See PORTING.md.

use kaspa_txscript_errors::TxScriptError;
use silverscript_lang::ast::Expr;
use warda_harness::audit::{case, probed, Claim, Case, Dir, Expect, Subject};
use warda_harness::*;

const CLAIMS: &[Claim] = &[
    Claim { entry: "auth_spend", text: "the payee is on the allowlist", rule: "allowlist" },
    Claim { entry: "auth_spend", text: "the amount is within the per-spend cap", rule: "per-spend cap" },
    Claim { entry: "auth_spend", text: "total spending stays within budget", rule: "budget" },
    Claim { entry: "auth_spend", text: "per-epoch spending stays within the epoch cap", rule: "epoch limit" },
    Claim { entry: "auth_spend", text: "epochs are consumed once, in order", rule: "epoch ratchet" },
    Claim { entry: "auth_spend", text: "the claimed time has actually arrived", rule: "cltv" },
    Claim { entry: "auth_spend", text: "the window has opened", rule: "window opens" },
    Claim { entry: "auth_spend", text: "the window has not closed", rule: "window closes" },
    Claim { entry: "auth_spend", text: "authority is unchanged in the successor", rule: "authority immutable" },
    Claim { entry: "auth_spend", text: "the successor state is exactly right", rule: "successor accounting" },
    Claim { entry: "auth_spend", text: "the continuation keeps the remainder", rule: "continuation value" },
    Claim { entry: "auth_spend", text: "the agent signed it", rule: "signature" },

    Claim { entry: "delegate", text: "the child cannot exceed the parent's uncommitted budget", rule: "delegation budget" },
    Claim { entry: "delegate", text: "every attenuable field only narrows", rule: "delegation attenuation" },
    Claim { entry: "delegate", text: "the allowlist is inherited exactly", rule: "delegation allowlist" },
    Claim { entry: "delegate", text: "the child starts clean", rule: "delegation start" },
    Claim { entry: "delegate", text: "the parent changes in exactly one way", rule: "delegation reserve" },
    Claim { entry: "delegate", text: "coin follows authority", rule: "delegation coin" },
    Claim { entry: "delegate", text: "exactly one child", rule: "delegation fanout" },

    Claim { entry: "revoke", text: "signed by the revocation key", rule: "revoke signature" },
    Claim { entry: "revoke", text: "the output is P2PK(principalKey)", rule: "revoke destination" },
    Claim { entry: "revoke", text: "the output keeps the balance, less maxFee", rule: "revoke conservation" },

    Claim { entry: "reclaim", text: "the term is over — tx.daa >= expiresAt", rule: "reclaim term" },
    Claim { entry: "reclaim", text: "signed by the principal key", rule: "reclaim signature" },
    Claim { entry: "reclaim", text: "the output is P2PK(principalKey)", rule: "reclaim destination" },
    Claim { entry: "reclaim", text: "the output keeps the balance, less maxFee", rule: "reclaim conservation" },
];

/// A spend that differs from the accepted baseline in exactly the ways the
/// closure sets.
fn spend(f: impl Fn(&mut Spend)) -> Result<(), TxScriptError> {
    let mut s = Spend::valid();
    f(&mut s);
    s.run()
}

fn cases() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();

    // -----------------------------------------------------------------------
    // The baseline. Everything below is a single field away from this, so if
    // it does not pass, nothing else in this report means anything.
    // -----------------------------------------------------------------------
    v.push(case(
        "baseline",
        "a fully valid signed spend is accepted",
        "0.5 KAS to an allowlisted payee, in the window, within every cap",
        Expect::Accept,
        || spend(|_| {}),
    ));

    // -----------------------------------------------------------------------
    // R1 per-spend cap
    // -----------------------------------------------------------------------
    const R1: &str = "amount <= maxPerSpend";
    for (amt, exp, note, probe) in [
        (MAX_PER_SPEND, Expect::Accept, "exactly the cap".to_string(), true),
        (MAX_PER_SPEND - 1, Expect::Accept, "one sompi under the cap".to_string(), false),
        (MAX_PER_SPEND + 1, Expect::Reject, "one sompi over the cap".to_string(), true),
        (MAX_PER_SPEND * 100, Expect::Reject, "a hundred times the cap".to_string(), false),
        (1, Expect::Accept, "one sompi".to_string(), false),
        (0, Expect::Reject, "nothing at all".to_string(), false),
        (-1, Expect::Reject, "a negative amount".to_string(), false),
    ] {
        let run = move || spend(|s| s.amount = amt);
        v.push(if probe {
            probed("per-spend cap", R1, note, exp, "amount, against the per-spend cap", "sompi", amt, Dir::Upper, run)
        } else {
            case("per-spend cap", R1, note, exp, run)
        });
    }

    // -----------------------------------------------------------------------
    // R2 budget. Reachable only from a grant that has already spent, so the
    // instance starts at a state rather than at genesis.
    // -----------------------------------------------------------------------
    const R2: &str = "amount <= budgetTotal - (spentTotal + reserved)";
    let room = 150_000_000i64; // inside the per-spend cap, so only the budget binds
    for (spent, reserved, amt, exp, note, axis) in [
        (BUDGET_TOTAL - room, 0, room, Expect::Accept, "exactly the uncommitted budget", "amount, against an unreserved budget"),
        (BUDGET_TOTAL - room, 0, room + 1, Expect::Reject, "one sompi past the uncommitted budget", "amount, against an unreserved budget"),
        (BUDGET_TOTAL - room * 2, room, room, Expect::Accept, "exactly what is left once reserve is counted", "amount, with 1.5 KAS reserved"),
        (BUDGET_TOTAL - room * 2, room, room + 1, Expect::Reject, "one sompi into the reserve", "amount, with 1.5 KAS reserved"),
    ] {
        v.push(probed("budget", R2, note, exp, axis, "sompi", amt, Dir::Upper, move || {
            spend(|s| {
                s.prev = (spent, reserved, 0, 0);
                s.amount = amt;
                s.successor = Some((spent + amt, reserved, 0, amt));
            })
        }));
    }

    // -----------------------------------------------------------------------
    // R3 epoch limit
    // -----------------------------------------------------------------------
    const R3: &str = "amount <= epochLimit - spentThisEpoch";
    for (amt, exp, note) in [
        (room, Expect::Accept, "exactly this epoch's remaining allowance"),
        (room + 1, Expect::Reject, "one sompi past this epoch's allowance"),
    ] {
        let used = EPOCH_LIMIT - room;
        v.push(probed("epoch limit", R3, note, exp, "amount, against this epoch's allowance", "sompi", amt, Dir::Upper, move || {
            spend(|s| {
                s.prev = (used, 0, 0, used);
                s.amount = amt;
                s.successor = Some((used + amt, 0, 0, used + amt));
            })
        }));
    }

    // -----------------------------------------------------------------------
    // R4 the epoch ratchet. This is the regression guard for vulnerability 1
    // (`a048b13e95125ad1`): an agent with an exhausted epoch claimed an
    // EARLIER one, the equality test found a mismatch, and the whole allowance
    // came back. Repeatably.
    // -----------------------------------------------------------------------
    const R4: &str = "currentEpoch >= prevState.epochIndex";
    let at = |e: i64| NOT_BEFORE + e * EPOCH_LENGTH + 500;
    for (epoch, exp, note) in [
        (4i64, Expect::Accept, "a later epoch, with its own fresh allowance"),
        (3, Expect::Reject, "the recorded epoch, which is already exhausted"),
        (2, Expect::Reject, "an EARLIER epoch — the v1 allowance reset"),
        (0, Expect::Reject, "the first epoch, long past"),
    ] {
        v.push(case("epoch ratchet", R4, note, exp, move || {
            spend(|s| {
                s.prev = (3 * KAS, 0, 3, EPOCH_LIMIT);
                s.claimed_daa = at(epoch);
            })
        }));
    }

    // -----------------------------------------------------------------------
    // R5 CLTV — the claimed time has actually arrived
    // -----------------------------------------------------------------------
    const R5: &str = "tx.daa >= claimedDaa";
    v.push(probed("cltv", R5, "locktime exactly the claimed DAA", Expect::Accept, "transaction locktime", "DAA", 1_000_500, Dir::Lower, || {
        spend(|s| s.tx_daa = Some(s.claimed_daa))
    }));
    v.push(probed("cltv", R5, "locktime one DAA below the claim", Expect::Reject, "transaction locktime", "DAA", 1_000_499, Dir::Lower, || {
        spend(|s| s.tx_daa = Some(s.claimed_daa - 1))
    }));

    // -----------------------------------------------------------------------
    // R6 notBefore / R7 expiresAt
    // -----------------------------------------------------------------------
    const R6: &str = "claimedDaa >= notBefore";
    v.push(probed("window opens", R6, "the first DAA of the window", Expect::Accept, "claimed DAA, at the window's start", "DAA", NOT_BEFORE, Dir::Lower, || {
        spend(|s| s.claimed_daa = NOT_BEFORE)
    }));
    v.push(probed("window opens", R6, "one DAA before the window opens", Expect::Reject, "claimed DAA, at the window's start", "DAA", NOT_BEFORE - 1, Dir::Lower, || {
        spend(|s| s.claimed_daa = NOT_BEFORE - 1)
    }));

    const R7: &str = "claimedDaa < expiresAt";
    v.push(probed("window closes", R7, "the last DAA of the window", Expect::Accept, "claimed DAA, at the window's end", "DAA", EXPIRES_AT - 1, Dir::Upper, || {
        spend(|s| s.claimed_daa = EXPIRES_AT - 1)
    }));
    v.push(probed("window closes", R7, "the first DAA after expiry", Expect::Reject, "claimed DAA, at the window's end", "DAA", EXPIRES_AT, Dir::Upper, || {
        spend(|s| s.claimed_daa = EXPIRES_AT)
    }));
    v.push(case("window closes", R7, "well past expiry", Expect::Reject, || {
        spend(|s| s.claimed_daa = EXPIRES_AT + EPOCH_LENGTH)
    }));

    // -----------------------------------------------------------------------
    // R8 authority immutability — nine equality checks plus templateId.
    //
    // Both directions for every numeric field. The rule is equality, not
    // monotonicity: a grant that let an agent LOWER its own cap would still be
    // a grant whose terms the agent controls, and the successor address is
    // derived from these fields, so a covenant that accepted either direction
    // would be a different grant wearing the same address.
    // -----------------------------------------------------------------------
    const R8: &str = "authority is unchanged in the successor (nine equality checks)";
    let ints: [(&str, i64); 7] = [
        ("budgetTotal", BUDGET_TOTAL),
        ("maxPerSpend", MAX_PER_SPEND),
        ("epochLimit", EPOCH_LIMIT),
        ("epochLength", EPOCH_LENGTH),
        ("notBefore", NOT_BEFORE),
        ("expiresAt", EXPIRES_AT),
        ("delegationDepth", DELEGATION_DEPTH),
    ];
    for (name, base) in ints {
        for (delta, word) in [(1i64, "raised by one"), (-1, "lowered by one")] {
            v.push(case("authority immutable", R8, format!("{name} {word} in the successor"), Expect::Reject, move || {
                spend(|s| s.authority_override = Some((name, Expr::int(base + delta))))
            }));
        }
    }
    for name in ["agentKey", "recipientsRoot", "templateId"] {
        v.push(case("authority immutable", R8, format!("{name} swapped in the successor"), Expect::Reject, move || {
            spend(|s| s.authority_override = Some((name, Expr::bytes(vec![0xee; 32]))))
        }));
    }

    // -----------------------------------------------------------------------
    // R9 successor accounting — four checks on spent/reserved/epoch
    // -----------------------------------------------------------------------
    const R9: &str = "the successor state is exactly right (four checks on spent/reserved/epoch)";
    let a = KAS / 2;
    for (succ, note) in [
        ((0i64, 0i64, 0i64, 0i64), "spend the money, record nothing"),
        ((a - 1, 0, 0, a), "spentTotal short by one"),
        ((a + 1, 0, 0, a), "spentTotal over by one"),
        ((a, 1, 0, a), "reserved raised by one"),
        ((a, -1, 0, a), "reserved lowered by one"),
        ((a, 0, 0, a - 1), "epochSpent short by one"),
        ((a, 0, 0, a + 1), "epochSpent over by one"),
        ((a, 0, 1, a), "epochIndex pushed forward"),
        ((a, 0, -1, a), "epochIndex pushed backward"),
    ] {
        v.push(case("successor accounting", R9, note, Expect::Reject, move || {
            spend(|s| s.successor = Some(succ))
        }));
    }

    // -----------------------------------------------------------------------
    // R10 the continuation keeps the remainder
    // -----------------------------------------------------------------------
    const R10: &str = "outputs[0].value >= inValue - amount - maxFee";
    v.push(probed("continuation value", R10, "a fee of exactly maxFee", Expect::Accept, "fee taken from the grant", "sompi", MAX_FEE, Dir::Upper, || {
        spend(|s| s.extra_fee = MAX_FEE - 1_000)
    }));
    v.push(probed("continuation value", R10, "a fee one sompi over maxFee", Expect::Reject, "fee taken from the grant", "sompi", MAX_FEE + 1, Dir::Upper, || {
        spend(|s| s.extra_fee = MAX_FEE - 1_000 + 1)
    }));
    v.push(case("continuation value", R10, "the whole remainder taken as fee", Expect::Reject, || {
        spend(|s| s.extra_fee = 1_000_000_000)
    }));

    // -----------------------------------------------------------------------
    // R11 the agent signed it
    // -----------------------------------------------------------------------
    v.push(case("signature", "checkSig(agentSig, agentKey)", "signed by a key that is not the agent's", Expect::Reject, || {
        spend(|s| s.wrong_key = true)
    }));

    // -----------------------------------------------------------------------
    // R12 the payee is on the allowlist, and is the one who gets paid
    // -----------------------------------------------------------------------
    const R12: &str = "merkleRoot(recipient, proof) == recipientsRoot";
    for m in [0xa1u8, 0xa2, 0xa3, 0xa4] {
        v.push(case("allowlist", R12, format!("member 0x{m:02x} of the allowlist"), Expect::Accept, move || {
            spend(|s| s.recipient = [m; 32])
        }));
    }
    v.push(case("allowlist", R12, "a payee absent from the allowlist", Expect::Reject, || {
        spend(|s| s.recipient = [0xee; 32])
    }));
    v.push(case("allowlist", R12, "a proof naming an allowlisted payee, money going elsewhere", Expect::Reject, || {
        spend(|s| s.pay_to = Some([0xee; 32]))
    }));

    // -----------------------------------------------------------------------
    // Delegation — the six attenuation axes, each at its boundary.
    // -----------------------------------------------------------------------
    const RD: &str = "every attenuable field only narrows";
    v.push(case("delegation baseline", "a narrower child is accepted", "a child narrower on every axis", Expect::Accept, || {
        run_delegation(&Child::narrower(), None)
    }));
    type Axis = (&'static str, fn(&mut Child, bool), &'static str, Dir, i64, i64);
    let axes: [Axis; 5] = [
        ("maxPerSpend", |c, over| c.max_per_spend = if over { MAX_PER_SPEND + 1 } else { MAX_PER_SPEND }, "sompi", Dir::Upper, MAX_PER_SPEND, MAX_PER_SPEND + 1),
        ("epochLimit", |c, over| c.epoch_limit = if over { EPOCH_LIMIT + 1 } else { EPOCH_LIMIT }, "sompi", Dir::Upper, EPOCH_LIMIT, EPOCH_LIMIT + 1),
        ("notBefore", |c, over| c.not_before = if over { NOT_BEFORE - 1 } else { NOT_BEFORE }, "DAA", Dir::Lower, NOT_BEFORE, NOT_BEFORE - 1),
        ("expiresAt", |c, over| c.expires_at = if over { EXPIRES_AT + 1 } else { EXPIRES_AT }, "DAA", Dir::Upper, EXPIRES_AT, EXPIRES_AT + 1),
        ("delegationDepth", |c, over| c.delegation_depth = if over { DELEGATION_DEPTH } else { DELEGATION_DEPTH - 1 }, "levels", Dir::Upper, DELEGATION_DEPTH - 1, DELEGATION_DEPTH),
    ];
    for (name, f, unit, dir, ok_v, no_v) in axes {
        /* Five of the six axes narrow with `<=`, so equalling the parent is
           the tightest PERMITTED value. `delegationDepth` is the exception —
           it narrows with `<`, so equalling the parent is the loosest
           FORBIDDEN one. Labelling both the same way would have reported a
           rule that does not exist. */
        let tightest = if name == "delegationDepth" { "one below the parent's" } else { "exactly equal to the parent's" };
        let loosest = if name == "delegationDepth" { "exactly equal to the parent's" } else { "one step wider than the parent's" };
        let axis: &'static str = Box::leak(format!("child {name}").into_boxed_str());
        v.push(probed("delegation attenuation", RD, format!("child {name} {tightest}"), Expect::Accept, axis, unit, ok_v, dir, move || {
            let mut c = Child::narrower(); f(&mut c, false); run_delegation(&c, None)
        }));
        v.push(probed("delegation attenuation", RD, format!("child {name} {loosest}"), Expect::Reject, axis, unit, no_v, dir, move || {
            let mut c = Child::narrower(); f(&mut c, true); run_delegation(&c, None)
        }));
    }
    v.push(case("delegation start", "the child starts clean", "a child born already having spent one sompi", Expect::Reject, || {
        let mut c = Child::narrower(); c.accounting = (1, 0, 0, 0); run_delegation(&c, None)
    }));
    for (res, note) in [(Some(0i64), "no reserve taken"), (Some(24 * KAS), "reserve one KAS short"), (Some(26 * KAS), "reserve one KAS over")] {
        v.push(case("delegation reserve", "the parent changes in exactly one way: reserved + child.budgetTotal", note, Expect::Reject, move || {
            run_delegation(&Child::narrower(), res)
        }));
    }

    // -----------------------------------------------------------------------
    // The rest of delegate: the four claims the first version left uncounted.
    // -----------------------------------------------------------------------
    const RB: &str = "child.budgetTotal <= budgetTotal - committed";
    // A parent that has already spent 60 and reserved 15 of 100 has 25 left.
    // That ceiling is unreachable from genesis, which is why it went untested.
    for (b, exp, note) in [
        (25 * KAS, Expect::Accept, "a child taking exactly the parent's uncommitted budget"),
        (25 * KAS + 1, Expect::Reject, "one sompi more than the parent has left"),
    ] {
        v.push(probed("delegation budget", RB, note, exp, "child budgetTotal", "sompi", b, Dir::Upper, move || {
            let mut d = Delegate::valid();
            d.parent_prev = (60 * KAS, 15 * KAS);
            d.child.budget = b;
            d.run()
        }));
    }
    v.push(case("delegation allowlist", "child.recipientsRoot == recipientsRoot",
        "a child claiming a different allowlist with an empty witness", Expect::Reject, || {
        let mut d = Delegate::valid(); d.child.root = Some([0x77; 32]); d.run()
    }));
    v.push(case("delegation coin", "outputs[1].value == child.budgetTotal",
        "the child's coin exactly its budget", Expect::Accept, || Delegate::valid().run()));
    for (delta, note) in [(-1i64, "the child's coin one sompi short of its budget"), (1, "one sompi over")] {
        v.push(case("delegation coin", "outputs[1].value == child.budgetTotal", note, Expect::Reject, move || {
            let mut d = Delegate::valid(); d.coin_override = Some(25 * KAS + delta); d.run()
        }));
    }
    v.push(case("delegation fanout", "OpAuthOutputCount == 2, fanout(to = 2)",
        "one child", Expect::Accept, || Delegate::valid().run()));
    v.push(case("delegation fanout", "OpAuthOutputCount == 2, fanout(to = 2)",
        "two children in one delegation", Expect::Reject, || {
        let mut d = Delegate::valid(); d.extra_output = true; d.run()
    }));

    // -----------------------------------------------------------------------
    // The exits. Neither had ever been run to an accepted verdict here, so
    // five published claims had never been executed at all — including the
    // value conservation added to `revoke` in v3, which exists because
    // without it the revocation key was a DESTROY capability rather than a
    // STOP one.
    // -----------------------------------------------------------------------
    v.push(case("revoke signature", "checkSig(s, revocationKey)", "the revocation key", Expect::Accept, || Exit::revoke().run()));
    for (who, note) in [(Signer::Agent, "the agent's key"), (Signer::Principal, "the principal's key")] {
        v.push(case("revoke signature", "checkSig(s, revocationKey)", format!("{note}, not the revocation key"), Expect::Reject, move || {
            let mut e = Exit::revoke(); e.signer = who; e.run()
        }));
    }
    v.push(case("revoke destination", "outputs[0].scriptPubKey == P2PK(principalKey)",
        "paying anybody but the principal", Expect::Reject, || {
        let mut e = Exit::revoke(); e.pay_to = Some([0xee; 32]); e.run()
    }));
    for (fee, exp, note) in [
        (MAX_FEE, Expect::Accept, "a fee of exactly maxFee"),
        (MAX_FEE + 1, Expect::Reject, "one sompi more than maxFee burned"),
    ] {
        v.push(probed("revoke conservation", "outputs[0].value >= inValue - maxFee", note, exp,
            "revoke fee", "sompi", fee, Dir::Upper, move || {
            let mut e = Exit::revoke(); e.fee = fee; e.run()
        }));
    }

    v.push(case("reclaim signature", "checkSig(s, principalKey)", "the principal's key", Expect::Accept, || Exit::reclaim().run()));
    for (who, note) in [(Signer::Agent, "the agent's key"), (Signer::Revocation, "the revocation key")] {
        v.push(case("reclaim signature", "checkSig(s, principalKey)", format!("{note}, not the principal's"), Expect::Reject, move || {
            let mut e = Exit::reclaim(); e.signer = who; e.run()
        }));
    }
    v.push(case("reclaim destination", "outputs[0].scriptPubKey == P2PK(principalKey)",
        "sweeping to anybody but the principal", Expect::Reject, || {
        let mut e = Exit::reclaim(); e.pay_to = Some([0xee; 32]); e.run()
    }));
    for (daa, exp, note) in [
        (EXPIRES_AT, Expect::Accept, "the first DAA the term allows"),
        (EXPIRES_AT - 1, Expect::Reject, "one DAA before the term is over"),
    ] {
        v.push(probed("reclaim term", "tx.daa >= expiresAt", note, exp, "reclaim locktime", "DAA", daa, Dir::Lower, move || {
            let mut e = Exit::reclaim(); e.tx_daa = daa; e.run()
        }));
    }
    for (fee, exp, note) in [
        (MAX_FEE, Expect::Accept, "a fee of exactly maxFee"),
        (MAX_FEE + 1, Expect::Reject, "one sompi more than maxFee burned"),
    ] {
        v.push(probed("reclaim conservation", "outputs[0].value >= inValue - maxFee", note, exp,
            "reclaim fee", "sompi", fee, Dir::Upper, move || {
            let mut e = Exit::reclaim(); e.fee = fee; e.run()
        }));
    }

    v
}

fn subject() -> Subject {
    Subject {
        line: "warda_grant.sil · v4 · fingerprint b3e5eeefacf2021f".into(),
        doc: "GUARANTEES.md".into(),
        by: "covenant/harness/src/bin/audit.rs".into(),
        repro: "cd covenant/harness && cargo run --bin audit".into(),
        mutation: "require(currentEpoch >= prevState.epochIndex)".into(),
        mutation_says: "It does: an agent whose epoch allowance is exhausted claims an \
                        earlier epoch, and the whole allowance comes back.".into(),
        out_md: "../AUDIT.md".into(),
        out_html: "../AUDIT.html".into(),
        out_json: "../audit.json".into(),
        untested: vec![
            "<code>settle</code> / <code>reabsorb</code> — the v4 splice path. It needs a real \
             foreign-input redeem script, which this harness does not yet build. It is also where \
             the fifth recorded vulnerability lived, which makes it the most important gap on this list.".into(),
            "The subset witness: a child narrowing its allowlist to a subtree.".into(),
            "<b>Any grant shape but one.</b> Every case runs against a single parameterisation — \
             100 KAS, a 2 KAS per-spend cap, delegation depth 2, a four-member allowlist, \
             <code>maxProofDepth</code> 4. Whether the same boundaries hold at depth 16, or with a \
             65,536-member tree, or a one-sompi budget, is untested.".into(),
            "Anything above the script engine — a node's mempool policy, relay rules, or what a \
             wallet does with a transaction before it is broadcast.".into(),
            "The residual described in <code>GUARANTEES.md</code>: allowance from unused epochs \
             stays spendable after the chain passes <code>expiresAt</code>. That is a property of \
             the design, correctly implemented, not a defect the engine can report.".into(),
        ],
        caveat: vec![
            "This instrument checks the bytecode against a written claim. It cannot notice a rule \
             that <em>should</em> exist and does not, because the document it takes its claims from \
             is the same document that would have omitted it.".into(),
            "That is not a hypothetical. Of the five vulnerabilities this covenant has had, \
             <b>none would have been caught by the claims suite</b>. The epoch cap that limited \
             nothing and the missing expiry check were both absent from the guarantees at the time. \
             The template-id defect is not engine-visible. The fifth was in <code>settle</code>, \
             which is still untested. Every one was found the same way: a person asked what an \
             adversary supplies at each input, built it, and watched the engine accept it.".into(),
            "The section above it is the answer to that, and the only one this tool has: an oracle \
             that consults no document, and a covenant with a known hole in it to prove the oracle \
             can fire.".into(),
        ],
    }
}

fn main() {
    std::process::exit(warda_harness::audit::run(&subject(), cases(), CLAIMS));
}
