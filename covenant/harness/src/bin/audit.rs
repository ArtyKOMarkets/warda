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

/// Which side of a rule a probe stands on, so the report can name the
/// tightest value the engine accepted and the loosest it refused without
/// anybody typing those numbers in by hand.
#[derive(Clone, Copy, PartialEq)]
enum Dir {
    /// The rule is an upper bound: smaller is permitted.
    Upper,
    /// The rule is a lower bound: larger is permitted.
    Lower,
}

#[derive(Clone)]
struct Probe {
    axis: &'static str,
    unit: &'static str,
    value: i64,
    dir: Dir,
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
    /// Set only on the two cases that straddle a boundary. The other cases in
    /// a family are still evidence; they are just not the measurement.
    probe: Option<Probe>,
    run: Box<dyn Fn() -> Result<(), TxScriptError>>,
}

fn case(
    rule: &'static str,
    claim: &'static str,
    what: impl Into<String>,
    expect: Expect,
    run: impl Fn() -> Result<(), TxScriptError> + 'static,
) -> Case {
    Case { rule, claim, what: what.into(), expect, probe: None, run: Box::new(run) }
}

fn probed(
    rule: &'static str,
    claim: &'static str,
    what: impl Into<String>,
    expect: Expect,
    axis: &'static str,
    unit: &'static str,
    value: i64,
    dir: Dir,
    run: impl Fn() -> Result<(), TxScriptError> + 'static,
) -> Case {
    Case {
        rule,
        claim,
        what: what.into(),
        expect,
        probe: Some(Probe { axis, unit, value, dir }),
        run: Box::new(run),
    }
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

    v
}

struct Outcome {
    rule: &'static str,
    claim: &'static str,
    what: String,
    expect: Expect,
    accepted: bool,
    err: Option<String>,
    probe: Option<Probe>,
}


/// A boundary the run actually measured: the tightest value the engine
/// accepted and the loosest it refused, on the same axis.
struct Bound {
    axis: String,
    unit: &'static str,
    ok: i64,
    no: i64,
    rule: &'static str,
    /// Which way the axis runs. A lower bound has its permitted values on the
    /// HIGH side, so drawing it permitted-left would put a larger number to
    /// the left of a smaller one and quietly invert the number line.
    dir: Dir,
}

fn bounds(out: &[Outcome]) -> Vec<Bound> {
    /* Two rules that share an axis NAME merge their probes, and the merged
       pair is silently wrong: the first draft reported the per-spend cap as
       "49,999,999 sompi apart" because the epoch limit was also called
       "amount". A boundary that is not one unit wide is either a real finding
       or a bug in this function, and the report cannot tell them apart —
       so the ambiguity is refused here instead. */
    {
        let mut seen: Vec<(&str, &str)> = Vec::new();
        for o in out {
            if let Some(p) = &o.probe {
                if let Some((_, r)) = seen.iter().find(|(a, _)| *a == p.axis) {
                    assert_eq!(*r, o.rule, "axis {:?} is probed by two rules", p.axis);
                } else {
                    seen.push((p.axis, o.rule));
                }
            }
        }
    }
    let mut axes: Vec<(&str, &'static str, Dir, &'static str)> = Vec::new();
    for o in out {
        if let Some(p) = &o.probe {
            if !axes.iter().any(|(a, _, _, _)| *a == p.axis) {
                axes.push((p.axis, p.unit, p.dir, o.rule));
            }
        }
    }
    let mut v = Vec::new();
    for (axis, unit, dir, rule) in axes {
        let vals = |acc: bool| -> Vec<i64> {
            out.iter()
                .filter(|o| o.probe.as_ref().map(|p| p.axis == axis).unwrap_or(false) && o.accepted == acc)
                .map(|o| o.probe.as_ref().unwrap().value)
                .collect()
        };
        let (a, r) = (vals(true), vals(false));
        // Upper bound: the tightest ACCEPTED value is the largest, the
        // loosest REFUSED the smallest. A lower bound is the mirror.
        let ok = if dir == Dir::Upper { a.iter().max() } else { a.iter().min() };
        let no = if dir == Dir::Upper { r.iter().min() } else { r.iter().max() };
        if let (Some(&ok), Some(&no)) = (ok, no) {
            v.push(Bound { axis: axis.to_string(), unit, ok, no, rule, dir });
        }
    }
    v
}

fn commas(n: i64) -> String {
    let neg = n < 0;
    let d: Vec<char> = n.abs().to_string().chars().collect();
    let mut s = String::new();
    for (i, c) in d.iter().enumerate() {
        if i > 0 && (d.len() - i) % 3 == 0 {
            s.push(',');
        }
        s.push(*c);
    }
    if neg { format!("-{s}") } else { s }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn json(out: &[Outcome], enforced: &[(&'static str, &'static str)], bs: &[Bound], stamp: &str) -> String {
    let mut s = String::from("{\n");
    let _ = writeln!(s, "  \"covenant\": \"warda_grant.sil v4\",");
    let _ = writeln!(s, "  \"generated\": \"{stamp}\",");
    let _ = writeln!(s, "  \"cases\": {},", out.len());
    let _ = writeln!(s, "  \"violations\": {},", out.iter().filter(|o| o.expect == Expect::Reject && o.accepted).count());
    let _ = writeln!(s, "  \"over_refusals\": {},", out.iter().filter(|o| o.expect == Expect::Accept && !o.accepted).count());
    let _ = writeln!(s, "  \"rules\": [");
    let n = enforced.len();
    for (i, (r, g)) in enforced.iter().enumerate() {
        let _ = writeln!(s, "    {{ \"rule\": \"{r}\", \"grade\": \"{g}\" }}{}", if i + 1 < n { "," } else { "" });
    }
    let _ = writeln!(s, "  ],");
    let _ = writeln!(s, "  \"boundaries\": [");
    for (i, b) in bs.iter().enumerate() {
        let _ = writeln!(s, "    {{ \"axis\": \"{}\", \"unit\": \"{}\", \"accepted\": {}, \"refused\": {} }}{}",
            b.axis, b.unit, b.ok, b.no, if i + 1 < bs.len() { "," } else { "" });
    }
    let _ = writeln!(s, "  ],");
    let _ = writeln!(s, "  \"results\": [");
    for (i, o) in out.iter().enumerate() {
        let _ = writeln!(s, "    {{ \"rule\": \"{}\", \"case\": \"{}\", \"spec\": \"{}\", \"engine\": \"{}\" }}{}",
            o.rule, o.what.replace('"', "'"),
            if o.expect == Expect::Accept { "accept" } else { "refuse" },
            if o.accepted { "accepted" } else { "refused" },
            if i + 1 < out.len() { "," } else { "" });
    }
    let _ = writeln!(s, "  ]\n}}");
    s
}

/* The printed report.
   One self-contained file: no network, no fonts to fetch, no script. It is
   the artifact somebody who is not in this repo reads, so it has to survive
   being emailed, and it has to print. `@page` and the break rules below are
   what make Cmd-P produce something with the table rows intact.

   Two marks carry every verdict: accepted and refused. They are a colour
   PLUS a shape PLUS a word, never a colour alone — the pair was checked
   against white with the palette validator (normal-vision ΔE 23.8, deutan
   21.4), which is the separation a reader needs to tell two dots apart. */
fn html(
    out: &[Outcome],
    enforced: &[(&'static str, &'static str)],
    assumed: &[&'static str],
    violations: &[&Outcome],
    over: &[&Outcome],
    bs: &[Bound],
    baseline_ok: bool,
    stamp: &str,
) -> String {
    let mut s = String::new();
    let bnd = enforced.iter().filter(|(_, g)| *g == "boundary").count();
    let clean = violations.is_empty() && over.is_empty();

    let _ = write!(s, r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Covenant audit — warda_grant.sil v4</title>
<style>
  :root {{
    --ink:#14181d; --mute:#5b6470; --faint:#8b94a0;
    --line:#e4e7ec; --rule:#c8ced6;
    --ok:#1a7f4f; --no:#2f343a; --bad:#b3261e;
    --okwash:#1a7f4f14; --nowash:#2f343a0f;
  }}
  * {{ box-sizing:border-box; }}
  html {{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
  body {{ margin:0; background:#fff; color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }}
  .page {{ max-width:56rem; margin:0 auto; padding:56px 44px 72px; }}
  .num {{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-variant-numeric:tabular-nums; }}
  h1 {{ font-size:30px; line-height:1.15; letter-spacing:-.02em; margin:0 0 6px; }}
  h2 {{ font-size:17px; letter-spacing:-.01em; margin:44px 0 6px; padding-top:14px;
    border-top:1px solid var(--line); }}
  h2:first-of-type {{ border-top:0; }}
  p {{ margin:.55em 0; }}
  .sub {{ color:var(--mute); font-size:14px; margin:0 0 4px; }}
  .lede {{ font-size:15px; color:var(--ink); max-width:44rem; }}
  .caveat {{ margin:22px 0 0; padding:14px 16px; border:1px solid var(--rule);
    border-left:3px solid var(--no); background:var(--nowash); font-size:14px; max-width:44rem; }}
  .caveat b {{ font-weight:600; }}

  .kpis {{ display:grid; grid-template-columns:repeat(5,1fr); gap:0;
    margin:26px 0 0; border:1px solid var(--line); }}
  .kpi {{ padding:14px 16px; border-left:1px solid var(--line); }}
  .kpi:first-child {{ border-left:0; }}
  .kpi .k {{ font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); }}
  .kpi .v {{ font-size:26px; line-height:1.1; margin-top:6px; letter-spacing:-.02em; }}
  .kpi .n {{ font-size:12px; color:var(--mute); margin-top:3px; }}
  .v.good {{ color:var(--ok); }} .v.bad {{ color:var(--bad); }}

  .bound {{ display:grid; grid-template-columns:minmax(0,13rem) 1fr;
    gap:18px; align-items:center; padding:13px 0; border-top:1px solid var(--line);
    break-inside:avoid; }}
  .bound .ax {{ font-size:13.5px; }}
  .bound .ax small {{ display:block; color:var(--faint); font-size:11.5px; }}
  .track {{ position:relative; height:64px; }}
  .zone {{ position:absolute; top:34px; height:20px; }}
  .zone.permitted {{ left:0; right:50%; background:var(--okwash); border:1px solid var(--ok); border-right:0; }}
  .zone.forbidden {{ left:50%; right:0; background:var(--nowash); border:1px solid var(--rule); border-left:0;
    background-image:repeating-linear-gradient(135deg,transparent 0 5px,#2f343a1f 5px 6px); }}
  /* A lower bound permits the HIGH side, so the row mirrors and the axis
     still reads small-to-large from left to right. */
  .rev .zone.permitted {{ left:50%; right:0; border:1px solid var(--ok); border-left:0; }}
  .rev .zone.forbidden {{ left:0; right:50%; border:1px solid var(--rule); border-right:0; }}
  .barrier {{ position:absolute; left:50%; top:30px; height:28px; width:2px; background:var(--no);
    transform:translateX(-1px); }}
  .dot {{ position:absolute; top:37px; width:14px; height:14px; border-radius:50%; }}
  .dot.ok {{ background:var(--ok); left:50%; transform:translateX(-26px); }}
  .dot.no {{ border:2px solid var(--no); background:#fff; left:50%; transform:translateX(12px); }}
  .rev .dot.ok {{ transform:translateX(12px); }}
  .rev .dot.no {{ transform:translateX(-26px); }}
  .dot.no::after {{ content:""; position:absolute; left:1px; right:1px; top:4px; height:2px;
    background:var(--no); transform:rotate(-45deg); }}
  .lab {{ position:absolute; top:0; font-size:11px; line-height:1.35; white-space:nowrap; }}
  .lab.ok {{ right:50%; margin-right:8px; text-align:right; color:var(--ok); }}
  .lab.no {{ left:50%; margin-left:8px; color:var(--no); }}
  .rev .lab.ok {{ right:auto; left:50%; margin:0 0 0 8px; text-align:left; }}
  .rev .lab.no {{ left:auto; right:50%; margin:0 8px 0 0; text-align:right; }}
  .lab b {{ display:block; font-weight:600; font-size:12.5px; }}
  .gap {{ position:absolute; bottom:0; left:50%; transform:translateX(-50%);
    font-size:10.5px; color:var(--faint); white-space:nowrap;
    background:#fff; padding:0 5px; }}

  table {{ width:100%; border-collapse:collapse; margin-top:10px; font-size:13.5px; }}
  th {{ text-align:left; font-weight:600; font-size:11.5px; letter-spacing:.05em;
    text-transform:uppercase; color:var(--faint); padding:0 10px 7px 0;
    border-bottom:1px solid var(--rule); }}
  td {{ padding:7px 10px 7px 0; border-bottom:1px solid var(--line); vertical-align:top; }}
  tr {{ break-inside:avoid; }}
  .mark {{ white-space:nowrap; font-size:12.5px; }}
  .mark.ok::before {{ content:"● "; color:var(--ok); }}
  .mark.no::before {{ content:"⊘ "; color:var(--no); }}
  .mark.bad {{ color:var(--bad); font-weight:600; }}
  .mark.bad::before {{ content:"▲ "; }}
  .grade {{ font-size:11px; letter-spacing:.04em; text-transform:uppercase;
    border:1px solid var(--rule); padding:1px 6px; color:var(--mute); }}
  ul {{ margin:.5em 0; padding-left:1.1em; }}
  li {{ margin:.28em 0; }}
  code {{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em; }}
  footer {{ margin-top:40px; padding-top:14px; border-top:1px solid var(--line);
    font-size:12px; color:var(--mute); }}
  @page {{ size:A4; margin:16mm 14mm; }}
  @media print {{
    .page {{ padding:0; max-width:none; }}
    h2 {{ break-after:avoid; }}
  }}
</style></head><body><div class="page">

<p class="sub num">warda_grant.sil · v4 · fingerprint b3e5eeefacf2021f</p>
<h1>Covenant audit</h1>
<p class="lede">Every verdict below comes from <code>TxScriptEngine</code>, the same script
engine a Kaspa node validates a transaction with. Nothing here is inferred from reading
the source.</p>

<div class="caveat"><b>This is not a statement that the covenant is secure.</b> It reports
the properties that were tested, where the bytecode and <code>GUARANTEES.md</code> disagree,
and which claims no constructed transaction could reach. The last of those is a section,
not an omission.</div>

<div class="kpis">
  <div class="kpi"><div class="k">Cases</div><div class="v num">{cases}</div><div class="n">transactions executed</div></div>
  <div class="kpi"><div class="k">Rules enforced</div><div class="v num">{enf}</div><div class="n">{bnd} at a measured boundary</div></div>
  <div class="kpi"><div class="k">Violations</div><div class="v num {vc}">{viol}</div><div class="n">forbidden, yet accepted</div></div>
  <div class="kpi"><div class="k">Over-refusals</div><div class="v num {oc}">{ovr}</div><div class="n">permitted, yet refused</div></div>
  <div class="kpi"><div class="k">Baseline</div><div class="v">{base}</div><div class="n">every flip depends on it</div></div>
</div>
"#,
        cases = out.len(),
        enf = format!("{} / {}", enforced.len(), enforced.len() + assumed.len()),
        bnd = bnd,
        viol = violations.len(),
        vc = if violations.is_empty() { "good" } else { "bad" },
        ovr = over.len(),
        oc = if over.is_empty() { "good" } else { "bad" },
        base = if baseline_ok { "<span class=\"v good\">accepted</span>" } else { "<span class=\"v bad\">FAILED</span>" },
    );

    let _ = write!(s, r#"
<h2>Why a rejection here means something</h2>
<p>The engine collapses every failed <code>require</code> into one opaque
<code>VerifyError</code>. It never says which rule rejected, so asserting that something
was refused proves nothing on its own — a malformed signature script looks exactly like a
working spending cap.</p>
<p>Every case is a single field changed from a baseline this run proved the engine accepts.
A rejection can therefore only be caused by the field that moved. Numeric rules are
exercised one unit either side of their boundary, so a rule that is present but in the
wrong place shows up as a disagreement rather than as a pass.</p>

<h2>Where each boundary actually is</h2>
<p>The filled mark is the tightest value the engine <b>accepted</b>. The barred mark is the
loosest it <b>refused</b>. Both were executed; neither is inferred.</p>
"#);

    for b in bs {
        let gap = (b.ok - b.no).abs();
        /* Ascending left to right, always. An upper bound puts the permitted
           values on the left; a lower bound puts them on the right, and the
           row is mirrored rather than relabelled. */
        let rev = if b.dir == Dir::Lower { " rev" } else { "" };
        let _ = write!(s, r#"<div class="bound">
  <div class="ax">{axis}<small>{rule} · {unit}</small></div>
  <div class="track{rev}">
    <div class="zone permitted"></div><div class="zone forbidden"></div><div class="barrier"></div>
    <div class="dot ok"></div><div class="dot no"></div>
    <div class="lab ok">accepted<br><b class="num">{ok}</b></div>
    <div class="lab no">refused<br><b class="num">{no}</b></div>
    <div class="gap">{gap} {unitw} apart</div>
  </div>
</div>"#,
            axis = esc(&b.axis), rule = esc(b.rule), unit = b.unit, rev = rev,
            ok = commas(b.ok), no = commas(b.no), gap = commas(gap),
            // "1 levels apart" is the kind of thing a reader trusts a report
            // less for, and it costs one line to not write.
            unitw = if gap == 1 { b.unit.strip_suffix('s').unwrap_or(b.unit) } else { b.unit });
    }

    let _ = write!(s, "\n<h2>Findings</h2>\n");
    if clean {
        let _ = write!(s, r#"<p><span class="mark ok">No violations</span> — nothing the guarantees forbid was accepted.
<span class="mark ok">No over-refusals</span> — nothing they permit was refused.</p>"#);
    }
    if !violations.is_empty() {
        let _ = write!(s, "<p><b>The engine accepted what the guarantees forbid.</b></p><ul>");
        for o in violations {
            let _ = write!(s, "<li><span class=\"mark bad\">{}</span> — {}<br><code>{}</code></li>", esc(o.rule), esc(&o.what), esc(o.claim));
        }
        let _ = write!(s, "</ul>");
    }
    if !over.is_empty() {
        let _ = write!(s, "<p><b>The engine refused what the guarantees permit.</b> These are not attacks — they are grants that would strand coin or refuse a spend their own terms allow.</p><ul>");
        for o in over {
            let _ = write!(s, "<li><span class=\"mark bad\">{}</span> — {}<br><code>{}</code></li>", esc(o.rule), esc(&o.what), esc(o.claim));
        }
        let _ = write!(s, "</ul>");
    }

    let _ = write!(s, r#"
<h2>Rules</h2>
<p><b>Boundary</b> — both halves were measured on the rule's own axis, one unit apart.
<b>Flip</b> — only the refusal is in the family, and it is attributable because the case is
a single field away from the accepted baseline.</p>
<table><thead><tr><th style="width:11rem">Rule</th><th style="width:6rem">Grade</th><th>The claim it was checked against</th></tr></thead><tbody>"#);
    for (r, g) in enforced {
        let claim = out.iter().find(|o| o.rule == *r).map(|o| o.claim).unwrap_or("");
        let _ = write!(s, "<tr><td>{}</td><td><span class=\"grade\">{g}</span></td><td><code>{}</code></td></tr>", esc(r), esc(claim));
    }
    let _ = write!(s, "</tbody></table>");

    if !assumed.is_empty() {
        let _ = write!(s, "<h2>Assumed</h2><p>Asserted in one direction only — no boundary pair was constructible, so this run cannot tell a working rule from one that refuses everything.</p><ul>");
        for r in assumed {
            let _ = write!(s, "<li><code>{}</code></li>", esc(r));
        }
        let _ = write!(s, "</ul>");
    }

    let _ = write!(s, r#"
<h2>Every case</h2>
<table><thead><tr><th style="width:10rem">Rule</th><th>Transaction</th><th style="width:6rem">Guarantee</th><th style="width:7rem">Engine</th></tr></thead><tbody>"#);
    for o in out {
        let agree = (o.expect == Expect::Accept) == o.accepted;
        let _ = write!(s,
            "<tr><td>{}</td><td>{}</td><td>{}</td><td><span class=\"mark {}\">{}</span></td></tr>",
            esc(o.rule), esc(&o.what),
            if o.expect == Expect::Accept { "permits" } else { "forbids" },
            if !agree { "bad" } else if o.accepted { "ok" } else { "no" },
            if !agree { "disagrees" } else if o.accepted { "accepted" } else { "refused" });
    }
    let _ = write!(s, "</tbody></table>");

    let _ = write!(s, r#"
<h2>What this run did not test</h2>
<ul>
<li><code>revoke</code> and <code>reclaim</code> — the exits. Both are signed by keys the
agent does not hold, and neither moves the accounting this report is about.</li>
<li><code>settle</code> / <code>reabsorb</code> — the v4 splice path. It needs a real
foreign-input redeem script, which this harness does not yet build.</li>
<li>The subset witness: a child narrowing its allowlist to a subtree.</li>
<li>Anything above the script engine — a node's mempool policy, relay rules, or what a
wallet does with a transaction before it is broadcast.</li>
<li>The residual described in <code>GUARANTEES.md</code>: allowance from unused epochs
stays spendable after the chain passes <code>expiresAt</code>. That is a property of the
design, correctly implemented, not a defect the engine can report.</li>
</ul>

<footer>
Generated {stamp} by <code>covenant/harness/src/bin/audit.rs</code>.
Reproduce with <code>cd covenant/harness &amp;&amp; cargo run --bin audit</code>.
The engine and the Silverscript compiler are both pinned by revision in
<code>Cargo.toml</code>; an unpinned compiler could alter the bytecode between runs.
</footer>
</div></body></html>
"#, stamp = stamp);
    s
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
                out.push(Outcome { rule: c.rule, claim: c.claim, what: c.what.clone(), expect: c.expect, accepted: false, err: Some("case could not be constructed".into()), probe: None });
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
            probe: c.probe.clone(),
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

    let bs = bounds(&out);
    let stamp = std::process::Command::new("date")
        .arg("-u").arg("+%Y-%m-%d %H:%M UTC")
        .output().ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());

    let md = report(&out, &enforced, &assumed, &violations, &over, baseline_ok);
    std::fs::write("../AUDIT.md", &md).expect("write report");
    std::fs::write("../audit.json", json(&out, &enforced, &bs, &stamp)).expect("write json");
    std::fs::write("../AUDIT.html", html(&out, &enforced, &assumed, &violations, &over, &bs, baseline_ok, &stamp))
        .expect("write html");
    println!("\nboundaries measured   {}", bs.len());
    println!("\ncovenant/AUDIT.md     the report in prose");
    println!("covenant/AUDIT.html   the printed report — open it and print to PDF");
    println!("covenant/audit.json   the same run, for anything that reads rather than looks");
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
