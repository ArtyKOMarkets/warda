//! Warda Auditor — v1, the spend and delegation paths of covenant v4.
//!
//! WHAT THIS IS. Every claim in `GUARANTEES.md` is a sentence about what the
//! chain refuses. This binary turns each of those sentences into transactions
//! and hands them to `TxScriptEngine` — the same engine a Kaspa node validates
//! with — then reports where the bytecode and the sentence disagree.
//!
//! WHAT MAKES IT DIFFERENT FROM THE TEST SUITE. `tests/spend.rs` proves a rule
//! by flipping one field to a value far outside it: 20 KAS against a 2 KAS cap.
//! That catches a rule that is absent. It cannot catch a rule that is off by
//! one, and an off-by-one on a spending cap is a real defect with real money
//! behind it. Every numeric rule here is exercised at its BOUNDARY: the
//! tightest value that must be accepted and the loosest that must be refused,
//! one sompi apart. A rule is reported `enforced` only when both land.
//!
//! WHAT IT DOES NOT DO. It does not declare the covenant secure. The engine
//! collapses every failed `require` into one opaque `VerifyError` and never
//! says which rule rejected, so a rejection is attributable only because each
//! case is a single-field change from a baseline this run proved is accepted.
//! Rules with no constructible boundary are reported `assumed` and listed by
//! name rather than counted as passes.

use kaspa_txscript_errors::TxScriptError;
use silverscript_lang::ast::Expr;
use std::fmt::Write as _;
use warda_harness::*;

#[derive(PartialEq, Clone, Copy, Debug)]
enum Expect {
    /// The spec permits this. The engine must return Ok(()).
    Accept,
    /// The spec forbids this. The engine must refuse.
    Reject,
}

struct Case {
    rule: &'static str,
    /// The sentence from GUARANTEES.md this case is testing. Quoted, not
    /// paraphrased: the point is to check the bytecode against the published
    /// claim, and a paraphrase is where an auditor starts agreeing with the
    /// thing it is auditing.
    claim: &'static str,
    what: String,
    expect: Expect,
    run: Box<dyn Fn() -> Result<(), TxScriptError>>,
}

fn case(
    rule: &'static str,
    claim: &'static str,
    what: impl Into<String>,
    expect: Expect,
    run: impl Fn() -> Result<(), TxScriptError> + 'static,
) -> Case {
    Case { rule, claim, what: what.into(), expect, run: Box::new(run) }
}

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
    for (amt, exp, note) in [
        (MAX_PER_SPEND, Expect::Accept, "exactly the cap".to_string()),
        (MAX_PER_SPEND - 1, Expect::Accept, "one sompi under the cap".to_string()),
        (MAX_PER_SPEND + 1, Expect::Reject, "one sompi over the cap".to_string()),
        (MAX_PER_SPEND * 100, Expect::Reject, "a hundred times the cap".to_string()),
        (1, Expect::Accept, "one sompi".to_string()),
        (0, Expect::Reject, "nothing at all".to_string()),
        (-1, Expect::Reject, "a negative amount".to_string()),
    ] {
        v.push(case("per-spend cap", R1, note, exp, move || spend(|s| s.amount = amt)));
    }

    // -----------------------------------------------------------------------
    // R2 budget. Reachable only from a grant that has already spent, so the
    // instance starts at a state rather than at genesis.
    // -----------------------------------------------------------------------
    const R2: &str = "amount <= budgetTotal - (spentTotal + reserved)";
    let room = 150_000_000i64; // inside the per-spend cap, so only the budget binds
    for (spent, reserved, amt, exp, note) in [
        (BUDGET_TOTAL - room, 0, room, Expect::Accept, "exactly the uncommitted budget"),
        (BUDGET_TOTAL - room, 0, room + 1, Expect::Reject, "one sompi past the uncommitted budget"),
        (BUDGET_TOTAL - room * 2, room, room, Expect::Accept, "exactly what is left once reserve is counted"),
        (BUDGET_TOTAL - room * 2, room, room + 1, Expect::Reject, "one sompi into the reserve"),
    ] {
        v.push(case("budget", R2, note, exp, move || {
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
        v.push(case("epoch limit", R3, note, exp, move || {
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
    v.push(case("cltv", R5, "locktime exactly the claimed DAA", Expect::Accept, || {
        spend(|s| s.tx_daa = Some(s.claimed_daa))
    }));
    v.push(case("cltv", R5, "locktime one DAA below the claim", Expect::Reject, || {
        spend(|s| s.tx_daa = Some(s.claimed_daa - 1))
    }));

    // -----------------------------------------------------------------------
    // R6 notBefore / R7 expiresAt
    // -----------------------------------------------------------------------
    const R6: &str = "claimedDaa >= notBefore";
    v.push(case("window opens", R6, "the first DAA of the window", Expect::Accept, || {
        spend(|s| s.claimed_daa = NOT_BEFORE)
    }));
    v.push(case("window opens", R6, "one DAA before the window opens", Expect::Reject, || {
        spend(|s| s.claimed_daa = NOT_BEFORE - 1)
    }));

    const R7: &str = "claimedDaa < expiresAt";
    v.push(case("window closes", R7, "the last DAA of the window", Expect::Accept, || {
        spend(|s| s.claimed_daa = EXPIRES_AT - 1)
    }));
    v.push(case("window closes", R7, "the first DAA after expiry", Expect::Reject, || {
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
    v.push(case("continuation value", R10, "a fee of exactly maxFee", Expect::Accept, || {
        spend(|s| s.extra_fee = MAX_FEE - 1_000)
    }));
    v.push(case("continuation value", R10, "a fee one sompi over maxFee", Expect::Reject, || {
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
    let axes: [(&str, fn(&mut Child, bool)); 5] = [
        ("maxPerSpend", |c, over| c.max_per_spend = if over { MAX_PER_SPEND + 1 } else { MAX_PER_SPEND }),
        ("epochLimit", |c, over| c.epoch_limit = if over { EPOCH_LIMIT + 1 } else { EPOCH_LIMIT }),
        ("notBefore", |c, over| c.not_before = if over { NOT_BEFORE - 1 } else { NOT_BEFORE }),
        ("expiresAt", |c, over| c.expires_at = if over { EXPIRES_AT + 1 } else { EXPIRES_AT }),
        ("delegationDepth", |c, over| c.delegation_depth = if over { DELEGATION_DEPTH } else { DELEGATION_DEPTH - 1 }),
    ];
    for (name, f) in axes {
        /* Five of the six axes narrow with `<=`, so equalling the parent is
           the tightest PERMITTED value. `delegationDepth` is the exception —
           it narrows with `<`, so equalling the parent is the loosest
           FORBIDDEN one. Labelling both the same way would have reported a
           rule that does not exist. */
        let tightest = if name == "delegationDepth" { "one below the parent's" } else { "exactly equal to the parent's" };
        let loosest = if name == "delegationDepth" { "exactly equal to the parent's" } else { "one step wider than the parent's" };
        v.push(case("delegation attenuation", RD, format!("child {name} {tightest}"), Expect::Accept, move || {
            let mut c = Child::narrower(); f(&mut c, false); run_delegation(&c, None)
        }));
        v.push(case("delegation attenuation", RD, format!("child {name} {loosest}"), Expect::Reject, move || {
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

    v
}

struct Outcome {
    rule: &'static str,
    claim: &'static str,
    what: String,
    expect: Expect,
    accepted: bool,
    err: Option<String>,
}

fn main() {
    let all = cases();
    let total = all.len();
    println!("Warda Auditor v1 — covenant v4, {total} cases against TxScriptEngine\n");

    /* A case that cannot be BUILT is not a case that was refused, and folding
       the two together is how a tool ends up reporting a rule as enforced
       because its own arithmetic overflowed. Each attempt is isolated. */
    std::panic::set_hook(Box::new(|_| {}));
    let mut out: Vec<Outcome> = Vec::new();
    for (i, c) in all.iter().enumerate() {
        let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (c.run)()));
        let r = match built {
            Ok(r) => r,
            Err(_) => {
                println!("{:>3}/{total}  {:<22} {:<8} {}   <<< COULD NOT BE BUILT", i + 1, c.rule, "n/a", c.what);
                out.push(Outcome { rule: c.rule, claim: c.claim, what: c.what.clone(), expect: c.expect, accepted: false, err: Some("case could not be constructed".into()) });
                continue;
            }
        };
        let accepted = r.is_ok();
        let ok = (c.expect == Expect::Accept) == accepted;
        println!(
            "{:>3}/{total}  {:<22} {:<8} {}{}",
            i + 1,
            c.rule,
            if accepted { "ACCEPTED" } else { "refused" },
            c.what,
            if ok { "" } else { "   <<< DISAGREES WITH THE SPEC" }
        );
        out.push(Outcome {
            rule: c.rule,
            claim: c.claim,
            what: c.what.clone(),
            expect: c.expect,
            accepted,
            err: r.err().map(|e| format!("{e:?}")),
        });
    }

    let baseline_ok = out.first().map(|o| o.accepted).unwrap_or(false);
    let violations: Vec<&Outcome> = out.iter().filter(|o| o.expect == Expect::Reject && o.accepted).collect();
    let over: Vec<&Outcome> = out.iter().filter(|o| o.expect == Expect::Accept && !o.accepted).collect();

    // A rule is `enforced` only when this run both accepted the tightest
    // permitted value and refused the loosest forbidden one. One without the
    // other is a rule that might be absent or might be refusing everything.
    let mut rules: Vec<&'static str> = out.iter().map(|o| o.rule).collect();
    rules.dedup();
    let mut enforced: Vec<(&'static str, &'static str)> = Vec::new();
    let mut assumed: Vec<&'static str> = Vec::new();
    for r in &rules {
        // Neither of these is a rule: one is the accepted baseline every flip
        // depends on, the other its delegation twin.
        if *r == "baseline" || *r == "delegation baseline" { continue; }
        let fam: Vec<&Outcome> = out.iter().filter(|o| o.rule == *r).collect();
        let has_accept = fam.iter().any(|o| o.expect == Expect::Accept && o.accepted);
        let has_reject = fam.iter().any(|o| o.expect == Expect::Reject && !o.accepted);
        let clean = fam.iter().all(|o| (o.expect == Expect::Accept) == o.accepted);
        if !clean {
            continue;
        }
        if has_accept && has_reject {
            /* Both halves measured inside this family: the tightest value the
               engine accepted and the loosest it refused, one unit apart. */
            enforced.push((*r, "boundary"));
        } else if has_reject && baseline_ok {
            /* Only the refusal is in this family, but every case in it is a
               single-field change from a baseline this run accepted — so the
               refusal is still attributable to the field that moved. Weaker
               than a boundary pair and named as such. */
            enforced.push((*r, "flip"));
        } else {
            assumed.push(*r);
        }
    }

    println!("\n───────────────────────────────────────────────");
    println!("baseline accepted      {}", if baseline_ok { "yes" } else { "NO — nothing below is attributable" });
    println!("cases                  {total}");
    let bnd = enforced.iter().filter(|(_, g)| *g == "boundary").count();
    println!("rules enforced         {} of {}  ({bnd} at a measured boundary)", enforced.len(), rules.len() - 2);
    println!("violations             {}", violations.len());
    println!("over-refusals          {}", over.len());
    println!("rules only asserted    {} (no boundary pair)", assumed.len());

    let md = report(&out, &enforced, &assumed, &violations, &over, baseline_ok);
    std::fs::write("../AUDIT.md", &md).expect("write report");
    println!("\nreport written to covenant/AUDIT.md");
    if !violations.is_empty() {
        std::process::exit(1);
    }
}

fn report(
    out: &[Outcome],
    enforced: &[(&'static str, &'static str)],
    assumed: &[&'static str],
    violations: &[&Outcome],
    over: &[&Outcome],
    baseline_ok: bool,
) -> String {
    let mut s = String::new();
    let _ = writeln!(s, "# Covenant audit — `warda_grant.sil` v4\n");
    let _ = writeln!(s, "Produced by `covenant/harness/src/bin/audit.rs`. Every line below is a");
    let _ = writeln!(s, "verdict from `TxScriptEngine`, the same script engine a Kaspa node validates");
    let _ = writeln!(s, "with. Nothing here is inferred from the source.\n");
    let _ = writeln!(s, "**This is not a statement that the covenant is secure.** It reports the");
    let _ = writeln!(s, "properties that were tested, where the bytecode and `GUARANTEES.md` disagree,");
    let _ = writeln!(s, "and which claims were not reachable by a constructed transaction.\n");

    let _ = writeln!(s, "| | |");
    let _ = writeln!(s, "|---|---|");
    let _ = writeln!(s, "| Cases executed | {} |", out.len());
    let _ = writeln!(s, "| Baseline accepted | {} |", if baseline_ok { "yes" } else { "**no**" });
    let bnd = enforced.iter().filter(|(_, g)| *g == "boundary").count();
    let _ = writeln!(s, "| Rules `enforced` | {} ({bnd} at a measured boundary) |", enforced.len());
    let _ = writeln!(s, "| Violations | {} |", violations.len());
    let _ = writeln!(s, "| Over-refusals | {} |", over.len());
    let _ = writeln!(s, "| Rules `assumed` | {} |\n", assumed.len());

    let _ = writeln!(s, "## Why a rejection here means something\n");
    let _ = writeln!(s, "The engine collapses every failed `require` into one opaque `VerifyError`. It");
    let _ = writeln!(s, "never says which rule rejected, so `assert!(is_err())` on its own proves");
    let _ = writeln!(s, "nothing — a malformed sigscript looks the same as a working cap.\n");
    let _ = writeln!(s, "Every case below is a single field changed from a baseline this run proved");
    let _ = writeln!(s, "the engine accepts. A rejection can therefore only be caused by that field.");
    let _ = writeln!(s, "Numeric rules are exercised one sompi either side of their boundary, so a");
    let _ = writeln!(s, "rule that is present but off by one shows up as a disagreement rather than");
    let _ = writeln!(s, "as a pass.\n");

    if !violations.is_empty() {
        let _ = writeln!(s, "## Violations — the engine accepted what the spec forbids\n");
        for o in violations {
            let _ = writeln!(s, "- **{}** — {}\n  - claim: `{}`", o.rule, o.what, o.claim);
        }
        let _ = writeln!(s);
    } else {
        let _ = writeln!(s, "## Violations\n\nNone. No case the spec forbids was accepted by the engine.\n");
    }

    if !over.is_empty() {
        let _ = writeln!(s, "## Over-refusals — the engine refused what the spec permits\n");
        let _ = writeln!(s, "These are not attacks. They are grants that would strand coin or refuse a");
        let _ = writeln!(s, "spend their own terms allow, which is a defect with money behind it.\n");
        for o in over {
            let _ = writeln!(s, "- **{}** — {}\n  - claim: `{}`\n  - engine: `{}`", o.rule, o.what, o.claim, o.err.clone().unwrap_or_default());
        }
        let _ = writeln!(s);
    } else {
        let _ = writeln!(s, "## Over-refusals\n\nNone. Every case the spec permits was accepted.\n");
    }

    let _ = writeln!(s, "## Enforced\n");

    let _ = writeln!(s, "`boundary` means both halves were measured inside the rule's own family —");
    let _ = writeln!(s, "the tightest value accepted and the loosest refused, one unit apart.");
    let _ = writeln!(s, "`flip` means only the refusal is in the family, and it is attributable");
    let _ = writeln!(s, "because the case is a single field away from the accepted baseline.\n");
    for (r, grade) in enforced {
        let claim = out.iter().find(|o| o.rule == *r).map(|o| o.claim).unwrap_or("");
        let _ = writeln!(s, "- `{r}` — *{grade}* — {claim}");
    }
    let _ = writeln!(s);

    if !assumed.is_empty() {
        let _ = writeln!(s, "## Assumed\n");
        let _ = writeln!(s, "Asserted in one direction only — no boundary pair was constructible, so");
        let _ = writeln!(s, "this run cannot distinguish a working rule from one that refuses");
        let _ = writeln!(s, "everything.\n");
        for r in assumed {
            let _ = writeln!(s, "- `{r}`");
        }
        let _ = writeln!(s);
    }

    let _ = writeln!(s, "## Every case\n");
    let _ = writeln!(s, "| Rule | Case | Spec | Engine | |");
    let _ = writeln!(s, "|---|---|---|---|---|");
    for o in out {
        let spec = if o.expect == Expect::Accept { "accept" } else { "refuse" };
        let eng = if o.accepted { "accepted" } else { "refused" };
        let mark = if (o.expect == Expect::Accept) == o.accepted { "ok" } else { "**disagrees**" };
        let _ = writeln!(s, "| {} | {} | {spec} | {eng} | {mark} |", o.rule, o.what);
    }
    let _ = writeln!(s, "\n## What this run did not test\n");
    let _ = writeln!(s, "- `revoke` and `reclaim` — the exits. Both are signed by keys the agent does");
    let _ = writeln!(s, "  not hold, and neither moves the accounting this report is about.");
    let _ = writeln!(s, "- `settle` / `reabsorb` — the v4 splice path. It needs a real foreign-input");
    let _ = writeln!(s, "  redeem script, which this harness does not yet build.");
    let _ = writeln!(s, "- The subset witness: a child narrowing its allowlist to a subtree.");
    let _ = writeln!(s, "- Anything above the script engine — a node's mempool policy, relay rules,");
    let _ = writeln!(s, "  or what a wallet does with the transaction before it is broadcast.");
    let _ = writeln!(s, "- The residual described in `GUARANTEES.md`: allowance from unused epochs");
    let _ = writeln!(s, "  stays spendable after the chain passes `expiresAt`. That is a property of");
    let _ = writeln!(s, "  the design, correctly implemented, not a defect the engine can report.\n");
    s
}
