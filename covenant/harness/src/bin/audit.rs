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
    Claim { entry: "delegate", text: "the allowlist is inherited, or narrowed to a subtree of it", rule: "delegation allowlist" },
    Claim { entry: "delegate", text: "a narrowed child cannot reach the rest of its parent's allowlist", rule: "subset narrows" },
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
    Claim { entry: "reabsorb", text: "the child is a real input, and not the parent itself", rule: "settle child index" },
    Claim { entry: "reabsorb", text: "the pop is proven — the parent carried exactly this child", rule: "settle pop" },
    Claim { entry: "reabsorb", text: "the child has no outstanding children of its own", rule: "settle leaves first" },
    Claim { entry: "reabsorb", text: "reserve is released by exactly the child's budget", rule: "settle reserve" },
    Claim { entry: "reabsorb", text: "the child's spending becomes the parent's", rule: "settle charge" },
    Claim { entry: "reabsorb", text: "everything else about the parent stands still", rule: "settle parent still" },
    Claim { entry: "reabsorb", text: "the parent's agent signed it", rule: "settle parent signature" },
    Claim { entry: "reabsorb", text: "one continuation, and the coin from both inputs lands in it", rule: "settle conservation" },
    Claim { entry: "settle", text: "signed by the revocation key", rule: "settle child signature" },
    Claim { entry: "settle", text: "the co-input is a grant of this template", rule: "settle co-input" },
    Claim { entry: "settle", text: "exactly two inputs", rule: "settle co-input" },
    Claim { entry: "settle", text: "output 0 is that grant's single authorised continuation", rule: "settle continuation" },
    Claim { entry: "settle", text: "the output keeps both inputs' coin, less maxFee", rule: "settle conservation" },
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
        (max_per_spend(), Expect::Accept, "exactly the cap".to_string(), true),
        (max_per_spend() - 1, Expect::Accept, "one sompi under the cap".to_string(), false),
        (max_per_spend() + 1, Expect::Reject, "one sompi over the cap".to_string(), true),
        (max_per_spend() * 100, Expect::Reject, "a hundred times the cap".to_string(), false),
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
        (budget_total() - room, 0, room, Expect::Accept, "exactly the uncommitted budget", "amount, against an unreserved budget"),
        (budget_total() - room, 0, room + 1, Expect::Reject, "one sompi past the uncommitted budget", "amount, against an unreserved budget"),
        (budget_total() - room * 2, room, room, Expect::Accept, "exactly what is left once reserve is counted", "amount, with 1.5 KAS reserved"),
        (budget_total() - room * 2, room, room + 1, Expect::Reject, "one sompi into the reserve", "amount, with 1.5 KAS reserved"),
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
        let used = epoch_limit() - room;
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
    let at = mid_epoch;
    for (epoch, exp, note) in [
        (4i64, Expect::Accept, "a later epoch, with its own fresh allowance"),
        (3, Expect::Reject, "the recorded epoch, which is already exhausted"),
        (2, Expect::Reject, "an EARLIER epoch — the v1 allowance reset"),
        (0, Expect::Reject, "the first epoch, long past"),
    ] {
        v.push(case("epoch ratchet", R4, note, exp, move || {
            spend(|s| {
                s.prev = (3 * KAS, 0, 3, epoch_limit());
                s.claimed_daa = at(epoch);
            })
        }));
    }

    // -----------------------------------------------------------------------
    // R5 CLTV — the claimed time has actually arrived
    // -----------------------------------------------------------------------
    const R5: &str = "tx.daa >= claimedDaa";
    v.push(probed("cltv", R5, "locktime exactly the claimed DAA", Expect::Accept, "transaction locktime", "DAA", mid_epoch(0), Dir::Lower, || {
        spend(|s| s.tx_daa = Some(s.claimed_daa))
    }));
    v.push(probed("cltv", R5, "locktime one DAA below the claim", Expect::Reject, "transaction locktime", "DAA", 1_000_499, Dir::Lower, || {
        spend(|s| s.tx_daa = Some(s.claimed_daa - 1))
    }));

    // -----------------------------------------------------------------------
    // R6 notBefore / R7 expiresAt
    // -----------------------------------------------------------------------
    const R6: &str = "claimedDaa >= notBefore";
    v.push(probed("window opens", R6, "the first DAA of the window", Expect::Accept, "claimed DAA, at the window's start", "DAA", not_before(), Dir::Lower, || {
        spend(|s| s.claimed_daa = not_before())
    }));
    v.push(probed("window opens", R6, "one DAA before the window opens", Expect::Reject, "claimed DAA, at the window's start", "DAA", not_before() - 1, Dir::Lower, || {
        spend(|s| s.claimed_daa = not_before() - 1)
    }));

    const R7: &str = "claimedDaa < expiresAt";
    v.push(probed("window closes", R7, "the last DAA of the window", Expect::Accept, "claimed DAA, at the window's end", "DAA", expires_at() - 1, Dir::Upper, || {
        spend(|s| s.claimed_daa = expires_at() - 1)
    }));
    v.push(probed("window closes", R7, "the first DAA after expiry", Expect::Reject, "claimed DAA, at the window's end", "DAA", expires_at(), Dir::Upper, || {
        spend(|s| s.claimed_daa = expires_at())
    }));
    v.push(case("window closes", R7, "well past expiry", Expect::Reject, || {
        spend(|s| s.claimed_daa = expires_at() + epoch_length())
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
        ("budgetTotal", budget_total()),
        ("maxPerSpend", max_per_spend()),
        ("epochLimit", epoch_limit()),
        ("epochLength", epoch_length()),
        ("notBefore", not_before()),
        ("expiresAt", expires_at()),
        ("delegationDepth", delegation_depth()),
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
        ("maxPerSpend", |c, over| c.max_per_spend = if over { max_per_spend() + 1 } else { max_per_spend() }, "sompi", Dir::Upper, max_per_spend(), max_per_spend() + 1),
        ("epochLimit", |c, over| c.epoch_limit = if over { epoch_limit() + 1 } else { epoch_limit() }, "sompi", Dir::Upper, epoch_limit(), epoch_limit() + 1),
        ("notBefore", |c, over| c.not_before = if over { not_before() - 1 } else { not_before() }, "DAA", Dir::Lower, not_before(), not_before() - 1),
        ("expiresAt", |c, over| c.expires_at = if over { expires_at() + 1 } else { expires_at() }, "DAA", Dir::Upper, expires_at(), expires_at() + 1),
        ("delegationDepth", |c, over| c.delegation_depth = if over { delegation_depth() } else { delegation_depth() - 1 }, "levels", Dir::Upper, delegation_depth() - 1, delegation_depth()),
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
    /* A parent that has already committed three quarters of its budget has one
       quarter left. That ceiling is unreachable from genesis, which is why it
       went untested for so long.

       Written as FRACTIONS of the budget, not as 60 and 15 and 25 KAS. The
       literals were true only while the budget was 100 KAS, and the whole
       point of the shape being an environment variable is that it is not. Run
       this suite at WARDA_BUDGET=10^15 with the literals in place and it
       reports a VIOLATION here — the covenant accepting a child one sompi
       over the parent's remainder — when what actually happened is that a 25
       KAS child is nowhere near the remainder of a ten-million-KAS grant, the
       covenant accepted it correctly, and the case's expectation was computed
       from a budget this run does not have. */
    let committed_spent = budget_total() / 100 * 60;
    let committed_reserved = budget_total() / 100 * 15;
    let uncommitted = budget_total() - committed_spent - committed_reserved;
    for (b, exp, note) in [
        (uncommitted, Expect::Accept, "a child taking exactly the parent's uncommitted budget"),
        (uncommitted + 1, Expect::Reject, "one sompi more than the parent has left"),
    ] {
        v.push(probed("delegation budget", RB, note, exp, "child budgetTotal", "sompi", b, Dir::Upper, move || {
            let mut d = Delegate::valid();
            d.parent_prev = (committed_spent, committed_reserved);
            d.child.budget = b;
            d.run()
        }));
    }
    /* The subset witness — v4's one widening of what delegation may do, and
       until now the largest thing this report listed as untested. The rule is
       one line of the covenant:

         foldFromNode(child.recipientsRoot, subsetSiblings, subsetSiblingIsLeft)
             == recipientsRoot

       so the child names any node of the parent's tree and proves the path up
       to the parent's root. Inheriting is the empty-witness case of the same
       fold, which is why there is no second branch to test. */
    let tree = Tree::new(members());
    let top = tree.levels.len() - 1;
    let (half, half_sibs, half_lefts) = tree.node_witness(top - 1, 0);
    let (leaf, leaf_sibs, leaf_lefts) = tree.node_witness(0, 0);

    v.push(case("delegation allowlist", "empty witness, so the fold returns the parent's own root",
        "a child inheriting the whole allowlist", Expect::Accept, || Delegate::valid().run()));
    v.push(case("delegation allowlist", "child.recipientsRoot folds to recipientsRoot",
        "a child claiming a different allowlist with an empty witness", Expect::Reject, || {
        let mut d = Delegate::valid(); d.child.root = Some([0x77; 32]); d.run()
    }));
    {
        let (n, sb, lf) = (half, half_sibs.clone(), half_lefts.clone());
        v.push(case("delegation allowlist", "child.recipientsRoot folds to recipientsRoot",
            "a child narrowed to a subtree, with the path to prove it", Expect::Accept, move || {
            let mut d = Delegate::valid();
            d.child.root = Some(n);
            d.subset = Some((sb.clone(), lf.clone()));
            d.run()
        }));
    }
    {
        let (n, sb, lf) = (leaf, leaf_sibs.clone(), leaf_lefts.clone());
        v.push(case("delegation allowlist", "child.recipientsRoot folds to recipientsRoot",
            "a child narrowed to ONE member — the leaf hash, depth zero", Expect::Accept, move || {
            let mut d = Delegate::valid();
            d.child.root = Some(n);
            d.subset = Some((sb.clone(), lf.clone()));
            d.run()
        }));
    }
    {
        let (sb, lf) = (half_sibs.clone(), half_lefts.clone());
        v.push(case("delegation allowlist", "child.recipientsRoot folds to recipientsRoot",
            "a root that is in no tree, carrying a real node's witness", Expect::Reject, move || {
            let mut d = Delegate::valid();
            d.child.root = Some([0xee; 32]);
            d.subset = Some((sb.clone(), lf.clone()));
            d.run()
        }));
    }
    {
        let (n, sb, lf) = (half, half_sibs.clone(), half_lefts.clone());
        v.push(case("delegation allowlist", "subsetSiblingIsLeft decides which side each sibling folds on",
            "the right node, every sibling side flipped", Expect::Reject, move || {
            let mut d = Delegate::valid();
            d.child.root = Some(n);
            d.subset = Some((sb.clone(), lf.iter().map(|x| !x).collect()));
            d.run()
        }));
    }
    {
        let other = Tree::new(vec![[0xc1u8; 32], [0xc2; 32], [0xc3; 32], [0xc4; 32]]);
        let (_, sb, lf) = other.node_witness(0, 0);
        let n = half;
        v.push(case("delegation allowlist", "child.recipientsRoot folds to recipientsRoot",
            "the right node, a witness borrowed from another tree", Expect::Reject, move || {
            let mut d = Delegate::valid();
            d.child.root = Some(n);
            d.subset = Some((sb.clone(), lf.clone()));
            d.run()
        }));
    }

    /* And the question the delegation cases above cannot ask, because it needs
       two transactions: once a child IS narrowed, is it actually narrower?
       Every case here spends AS the child — born at the narrowed root — and
       reaches for a payee its parent could have paid. This is the property the
       whole feature exists for, and nothing tested it. */
    v.push(case("subset narrows", "merkleRoot(recipient, proof) == recipientsRoot, the CHILD's",
        "a child narrowed to one member paying that member", Expect::Accept, move || {
        let mut sp = Spend::valid();
        sp.recipient = [0xa1; 32]; sp.pay_to = Some([0xa1; 32]);
        sp.allowlist = Some((leaf, vec![], vec![]));
        sp.run()
    }));
    v.push(case("subset narrows", "merkleRoot(recipient, proof) == recipientsRoot, the CHILD's",
        "the same child reaching for a member only its PARENT may pay", Expect::Reject, move || {
        let mut sp = Spend::valid();
        sp.recipient = [0xa2; 32]; sp.pay_to = Some([0xa2; 32]);
        sp.allowlist = Some((leaf, vec![], vec![]));
        sp.run()
    }));
    {
        let (psibs, plefts) = tree.proof(&[0xa2; 32]);
        v.push(case("subset narrows", "merkleRoot(recipient, proof) == recipientsRoot, the CHILD's",
            "…offering that member's valid proof against the PARENT's root", Expect::Reject, move || {
            let mut sp = Spend::valid();
            sp.recipient = [0xa2; 32]; sp.pay_to = Some([0xa2; 32]);
            sp.allowlist = Some((leaf, psibs.clone(), plefts.clone()));
            sp.run()
        }));
    }
    {
        /* The payee's proof WITHIN the child's subtree: the full proof against
           the parent's root, cut at the level the child's root sits on. Written
           as an arithmetic cut rather than a literal because the first draft
           hardcoded "one sibling, the other leaf" — true of a four-member tree
           and of nothing else, so the case over-refused the moment this report
           was re-run at 256 members. A case that only passes at one grant shape
           is the thing re-parameterising was meant to expose. */
        let (fs, fl) = tree.proof(&[0xa1; 32]);
        let k = (top - 1).min(fs.len());
        let (ins, inl) = (fs[..k].to_vec(), fl[..k].to_vec());
        v.push(case("subset narrows", "merkleRoot(recipient, proof) == recipientsRoot, the CHILD's",
            "a child narrowed to a subtree paying inside it", Expect::Accept, move || {
            let mut sp = Spend::valid();
            sp.recipient = [0xa1; 32]; sp.pay_to = Some([0xa1; 32]);
            sp.allowlist = Some((half, ins.clone(), inl.clone()));
            sp.run()
        }));
    }
    {
        let (qsibs, qlefts) = tree.proof(&[0xa3; 32]);
        v.push(case("subset narrows", "merkleRoot(recipient, proof) == recipientsRoot, the CHILD's",
            "the same child reaching outside its subtree, with a parent-valid proof",
            Expect::Reject, move || {
            let mut sp = Spend::valid();
            sp.recipient = [0xa3; 32]; sp.pay_to = Some([0xa3; 32]);
            sp.allowlist = Some((half, qsibs.clone(), qlefts.clone()));
            sp.run()
        }));
    }
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
        (expires_at(), Expect::Accept, "the first DAA the term allows"),
        (expires_at() - 1, Expect::Reject, "one DAA before the term is over"),
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

    // -----------------------------------------------------------------------
    // Settlement. The parent runs `reabsorb`, the child runs `settle`, in one
    // transaction under two keys — and until now nothing in this repo had ever
    // built one. `GUARANTEES.md` said "still not built". It is the path the
    // fifth recorded vulnerability lived in, which made it the most important
    // gap in every report this tool has produced.
    // -----------------------------------------------------------------------
    fn settle(f: impl Fn(&mut Settle)) -> Result<(), TxScriptError> {
        let mut s = Settle::valid();
        f(&mut s);
        s.run()
    }
    v.push(case("settle baseline", "a parent reabsorbs a child that has spent",
        "a child settled home, its spending charged and its reserve released", Expect::Accept, || settle(|_| {})));

    const RC: &str = "childIdx is a real input, and not the active one";
    for (i, note) in [(0i64, "the parent's own index"), (7, "an input that does not exist"), (-1, "a negative index")] {
        v.push(case("settle child index", RC, format!("the child claimed at {note}"), Expect::Reject, move || settle(|s| s.child_idx = i)));
    }
    v.push(case("settle pop", "reserveRoot == blake2b(prevRoot || childId), newState.reserveRoot == prevRoot",
        "a previous reserve root the parent never carried", Expect::Reject, || settle(|s| s.wrong_prev_root = true)));
    v.push(case("settle leaves first", "child.reserved == 0",
        "a child that still has coin committed to a grandchild", Expect::Reject, || settle(|s| s.child_reserved = KAS)));
    for (succ, note) in [
        ((5 * KAS, 25 * KAS), "the reserve not released"),
        ((5 * KAS, -1), "more reserve released than was held"),
    ] {
        v.push(case("settle reserve", "newState.reserved == reserved - child.budgetTotal", note, Expect::Reject, move || settle(|s| s.successor = Some(succ))));
    }
    for (succ, note) in [
        ((0i64, 0i64), "the child's spending never charged to the parent"),
        ((5 * KAS - 1, 0), "one sompi less charged than the child spent"),
    ] {
        v.push(case("settle charge", "newState.spentTotal == spentTotal + child.spentTotal", note, Expect::Reject, move || settle(|s| s.successor = Some(succ))));
    }
    for (name, val, note) in [
        ("maxPerSpend", 100 * KAS, "the parent raising its own per-payment cap"),
        ("expiresAt", 9_999_999, "the parent extending its own expiry"),
        ("budgetTotal", 1_000_000_000_000, "the parent inflating its own budget"),
    ] {
        v.push(case("settle parent still", "everything else about the parent stands still", note, Expect::Reject,
            move || settle(|s| s.authority_override = Some((name, Expr::int(val))))));
    }
    v.push(case("settle parent signature", "checkSig(agentSig, pubkey(agentKey))",
        "the parent's half signed by the revocation key", Expect::Reject, || settle(|s| s.parent_signer = Signer::Revocation)));
    /* The one claim this report listed as NOT COVERED from its first run, and
       the reason it was is worth keeping: the parent's `reabsorb` requires
       `OpAuthOutputCount(this.activeInputIndex) == 1` and
       `OpAuthOutputIdx(this.activeInputIndex, 0) == 0`, and the child's
       `settle` requires the identical predicate about the identical input.
       The two are redundant by construction, so NO whole transaction can
       violate the child's version without violating the parent's — and the
       parent's input is verified first, so a refusal of the pair proves only
       that one of them fired. That is exactly the "refused for the wrong
       reason" this report opens by warning about, which is why it was
       reported as uncovered rather than quietly as passing.

       Both refusal cases below execute the CHILD'S SCRIPT ALONE. That is not
       a claim about what a node would do with the whole transaction; it is a
       claim about what the child's script enforces, which is what the
       guarantee says and what this report audits — and it is the same
       per-input execution every other case here is built on.

       One case per line of the claim, and each was checked against a covenant
       with its own line deleted: displacing the continuation is ACCEPTED when
       the INDEX line goes and still refused when the COUNT line goes, and the
       doubled output is the mirror. Neither refusal is the other's. */
    v.push(case("settle continuation", "OpAuthOutputCount(parentIdx) == 1 && OpAuthOutputIdx(parentIdx, 0) == 0",
        "the child's script alone, on the honest shape — the baseline the two below derive from",
        Expect::Accept,
        || Settle { only_input: Some(1), ..Settle::valid() }.run()));
    v.push(case("settle continuation", "OpAuthOutputIdx(parentIdx, 0) == 0",
        "the parent's continuation demoted to output 1, with the coin left at output 0",
        Expect::Reject,
        || Settle { outputs: Outputs::Displaced, only_input: Some(1), ..Settle::valid() }.run()));
    v.push(case("settle continuation", "OpAuthOutputCount(parentIdx) == 1",
        "a second output authorised by the same input",
        Expect::Reject,
        || Settle { outputs: Outputs::Doubled, only_input: Some(1), ..Settle::valid() }.run()));

    v.push(case("settle child signature", "checkSig(s, revocationKey)",
        "the revocation key", Expect::Accept, || settle(|_| {})));
    for (who, note) in [(Signer::Agent, "the agent's key"), (Signer::Principal, "the principal's key")] {
        v.push(case("settle child signature", "checkSig(s, revocationKey)", format!("the child's half signed by {note}"), Expect::Reject,
            move || settle(|s| s.child_signer = who)));
    }
    /* Vulnerability 5, in its own shape: the revocation key alone, plus any
       dust it already owned as a second input, spending a child under `settle`.
       The engine refuses it at the template slice rather than at a `require` —
       a one-byte script has no state region to read — so the verdict is
       InvalidIndex rather than VerifyError. Still a refusal; a different one,
       and worth saying so. */
    v.push(case("settle co-input", "the co-input is a grant of this template, and there are exactly two inputs",
        "the revocation key settling a child against its own dust", Expect::Reject, || settle(|s| s.lone_child = true)));
    for (fee, exp, note) in [
        (MAX_FEE, Expect::Accept, "a fee of exactly maxFee across both inputs"),
        (MAX_FEE + 1, Expect::Reject, "one sompi more than maxFee"),
    ] {
        v.push(probed("settle conservation", "outputs[0].value >= inputs[0].value + inputs[1].value - maxFee", note, exp,
            "settlement fee", "sompi", fee, Dir::Upper, move || settle(|s| s.extra_fee = fee - 1_000)));
    }

    v
}

fn subject() -> Subject {
    Subject {
        /* The shape goes in the subject line, because a suite that does not
           say which parameterisation it ran produces numbers nobody can
           compare — including to its own, from last week. It used to be one
           shape and the line could afford to leave it out. */
        line: format!(
            "warda_grant.sil · v4 · fingerprint b3e5eeefacf2021f\n{}",
            warda_harness::shape_line()
        ),
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
            format!(
                "<b>One grant shape per RUN</b> — but no longer one shape per suite. This run \
                 used: {}. Every axis of it is an environment variable now \
                 (<code>WARDA_BUDGET</code>, <code>WARDA_MAX_PER_SPEND</code>, \
                 <code>WARDA_EPOCH_LIMIT</code>, <code>WARDA_EPOCH_LENGTH</code>, \
                 <code>WARDA_NOT_BEFORE</code>, <code>WARDA_EXPIRES_AT</code>, \
                 <code>WARDA_DELEGATION_DEPTH</code>, <code>WARDA_TREE_LEAVES</code>, \
                 <code>WARDA_PROOF_DEPTH</code>), so another shape is a re-run rather than an \
                 argument. What this report cannot tell you is what the OTHER shapes did: read \
                 the matrix in <code>covenant/SHAPES.md</code> for that, and treat a claim about \
                 a shape nobody ran as exactly what it is.",
                warda_harness::shape_line(),
            ),
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
             The fifth is now covered — but only because it has already been found: the claim it \
             violates was written as part of its fix, and a suite whose oracle is the documentation \
             learns about a hole the day somebody else closes it. Every one of the five was found \
             the same way, and it was not this way: a person asked what an adversary supplies at \
             each input, built it, and watched the engine accept it.".into(),
            "The section above it is the answer to that, and the only one this tool has: an oracle \
             that consults no document, and a covenant with a known hole in it to prove the oracle \
             can fire.".into(),
        ],
    }
}

fn main() {
    std::process::exit(warda_harness::audit::run(&subject(), cases(), CLAIMS));
}
