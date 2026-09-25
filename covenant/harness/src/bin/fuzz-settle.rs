//! The oracle that reads no specification, pointed at SETTLEMENT.
//!
//! `fuzz` asks it of a spend and `fuzz-delegate` of a delegation. This is the
//! third of the four things a grant can do, and the one where a grant
//! DISAPPEARS: the parent runs `reabsorb`, the child runs `settle`, and
//! afterwards there is one grant where there were two.
//!
//! ```text
//! A settlement pays nobody either. After one, the parent alone must not be
//! able to do anything the parent and its child could do together.
//! ```
//!
//! The money axis of that is arithmetic the covenant already states: the
//! parent is charged what the child spent and released what it lent. Stated
//! as a property instead, it needs no such statement — a tree that is worth
//! more after a settlement than before has created authority, and it does not
//! matter which `require` was supposed to stop it.
//!
//! The other axis is the one worth writing this for. Settlement is the only
//! entrypoint where the parent rewrites its own state while ANOTHER grant is
//! being consumed beside it, and a covenant that forgot to pin the parent's
//! own limits would let every settlement be a chance to raise them. The
//! guarantees say twelve fields must stand still. This asks the question
//! without reading them: did the parent come out of it able to pay more, pay
//! faster, pay later, start earlier, or delegate deeper?
//!
//! `AUDIT.md` lists one claim about `settle` as **not covered** — that output
//! 0 is the co-input grant's single authorised continuation — because the
//! baseline builds exactly that shape and no transaction in that run has it
//! as the only thing wrong. This binary does not close that hole either. It
//! is a different instrument pointed at the same entrypoint, and it says so.
//!
//!     cargo run --release --bin fuzz-settle --manifest-path covenant/harness/Cargo.toml

use silverscript_lang::ast::Expr;
use warda_harness::oracle::{grew, Capacity, Pass};
use warda_harness::*;

/// The parent's own limits, as its declared successor states them.
///
/// Every one of these is a field the parent must carry across a settlement
/// unchanged. They are read here as CAPACITY rather than as equalities: what
/// matters is not that a number moved, it is that it moved the way that gives
/// the holder more.
#[derive(Clone, Copy)]
struct Limits {
    max_per_spend: i64,
    epoch_limit: i64,
    depth: i64,
    expires: i64,
    opens: i64,
}

impl Limits {
    fn genesis() -> Self {
        Limits {
            max_per_spend: MAX_PER_SPEND,
            epoch_limit: EPOCH_LIMIT,
            depth: DELEGATION_DEPTH,
            expires: EXPIRES_AT,
            opens: NOT_BEFORE,
        }
    }
}

/// What a parent — with or without a live child beside it — can do.
///
/// The child contributes only money. Its own limits are bounded by the
/// parent's (that is what `delegate` enforced when it was born), so a tree's
/// rate, reach and depth are the parent's, and after a settlement they must
/// still be.
fn cap(parent_spent: i64, parent_reserved: i64, limits: Limits, child_left: i64) -> Capacity {
    Capacity {
        spendable: BUDGET_TOTAL - parent_spent - parent_reserved + child_left,
        figures: vec![
            ("the largest single payment it can make", limits.max_per_spend),
            ("what it may pay in one epoch", limits.epoch_limit),
            ("generations it may still delegate", limits.depth),
            ("the last moment it may pay", limits.expires),
            // Negated: opening earlier is a wider window, and `grew` only
            // knows that bigger is worse.
            ("how early it may start paying", -limits.opens),
        ],
    }
}

/// One settlement to attempt: how it is built, and what the parent's declared
/// successor claims about the parent's own limits.
///
/// The two are separate on purpose. `Settle::authority_override` takes an
/// `Expr`, which the engine understands and this file cannot read back — so
/// the numeric claim is carried alongside, and the capacity reading is built
/// from the number rather than from the expression. A case whose two halves
/// disagreed would report a lie the transaction never told.
struct Case {
    name: &'static str,
    build: fn(&mut Settle),
    claims: Option<(&'static str, i64)>,
}

fn cases() -> Vec<Case> {
    vec![
        // ---- honest, in several shapes -------------------------------
        //
        // More than one, because the oracle only ever sees transactions the
        // engine accepted: a grid made mostly of violations sweeps nothing.
        Case { name: "honest — child spent five KAS of twenty-five", build: |_s| {}, claims: None },
        Case { name: "honest — child spent nothing", build: |s| s.child_spent = 0, claims: None },
        Case { name: "honest — child spent its whole budget", build: |s| s.child_spent = s.child_budget, claims: None },
        Case { name: "honest — child spent one sompi", build: |s| s.child_spent = 1, claims: None },
        Case {
            name: "honest — a bigger child, mostly unspent",
            build: |s| { s.child_budget = 40 * KAS; s.parent_reserved = 40 * KAS; s.child_spent = KAS; },
            claims: None,
        },
        // ---- the money axis ------------------------------------------
        Case {
            name: "reserve released, the child's spending never charged",
            build: |s| s.successor = Some((s.parent_spent, s.parent_reserved - s.child_budget)),
            claims: None,
        },
        Case {
            name: "charged one sompi less than the child spent",
            build: |s| s.successor = Some((s.parent_spent + s.child_spent - 1, s.parent_reserved - s.child_budget)),
            claims: None,
        },
        Case {
            name: "released one sompi more than the child was lent",
            build: |s| s.successor = Some((s.parent_spent + s.child_spent, s.parent_reserved - s.child_budget - 1)),
            claims: None,
        },
        Case {
            name: "released nothing — the reserve stays behind",
            build: |s| s.successor = Some((s.parent_spent + s.child_spent, s.parent_reserved)),
            claims: None,
        },
        Case {
            name: "the child claims to have spent a negative amount",
            build: |s| s.child_spent = -KAS,
            claims: None,
        },
        // ---- the parent's own limits ---------------------------------
        //
        // None of these moves a sompi. Every one of them leaves the parent
        // able to do something it could not do before, which is the whole
        // reason this binary reads five figures instead of one number.
        Case {
            name: "the parent comes out with a higher per-spend cap",
            build: |s| s.authority_override = Some(("maxPerSpend", Expr::int(MAX_PER_SPEND * 2))),
            claims: Some(("maxPerSpend", MAX_PER_SPEND * 2)),
        },
        Case {
            name: "the parent comes out with a bigger epoch allowance",
            build: |s| s.authority_override = Some(("epochLimit", Expr::int(EPOCH_LIMIT * 2))),
            claims: Some(("epochLimit", EPOCH_LIMIT * 2)),
        },
        Case {
            name: "the parent comes out able to delegate one deeper",
            build: |s| s.authority_override = Some(("delegationDepth", Expr::int(DELEGATION_DEPTH + 1))),
            claims: Some(("delegationDepth", DELEGATION_DEPTH + 1)),
        },
        Case {
            name: "the parent comes out living longer",
            build: |s| s.authority_override = Some(("expiresAt", Expr::int(EXPIRES_AT + 100_000))),
            claims: Some(("expiresAt", EXPIRES_AT + 100_000)),
        },
        Case {
            name: "the parent comes out able to have started earlier",
            build: |s| s.authority_override = Some(("notBefore", Expr::int(NOT_BEFORE - 100_000))),
            claims: Some(("notBefore", NOT_BEFORE - 100_000)),
        },
        // ---- shapes, not values --------------------------------------
        Case { name: "the child names itself as the co-input", build: |s| s.child_idx = 0, claims: None },
        Case { name: "the child still has a child of its own", build: |s| s.child_reserved = KAS, claims: None },
        Case { name: "the child's half signed by the agent", build: |s| s.child_signer = Signer::Agent, claims: None },
        Case { name: "the parent's half signed by the revocation key", build: |s| s.parent_signer = Signer::Revocation, claims: None },
        Case { name: "a reserve root the parent does not carry", build: |s| s.wrong_prev_root = true, claims: None },
        Case { name: "the child alone, with no parent beside it", build: |s| s.lone_child = true, claims: None },
    ]
}

/// The parent states an adversary would settle from.
const PARENTS: [(i64, i64); 3] = [
    (0, 25 * KAS),
    (10 * KAS, 25 * KAS),
    (BUDGET_TOTAL - 30 * KAS, 25 * KAS),
];

fn sweep(src: &'static str, label: &'static str) -> Pass {
    let mut out = Pass::new(label);
    for (parent_spent, parent_reserved) in PARENTS {
        for case in &cases() {
            let mut s = Settle {
                parent_spent,
                parent_reserved,
                src,
                ..Settle::valid()
            };
            (case.build)(&mut s);
            out.generated += 1;
            if s.run().is_err() {
                continue;
            }
            out.accepted += 1;

            /* What the transaction actually declared — not what it meant. The
               successor the covenant compared against is this one, so this is
               what the capacity reading has to be built from. */
            let (ns, nr) = s.successor.unwrap_or((
                s.parent_spent + s.child_spent,
                s.parent_reserved - s.child_budget,
            ));
            let mut after_limits = Limits::genesis();
            if let Some((field, value)) = case.claims {
                match field {
                    "maxPerSpend" => after_limits.max_per_spend = value,
                    "epochLimit" => after_limits.epoch_limit = value,
                    "delegationDepth" => after_limits.depth = value,
                    "expiresAt" => after_limits.expires = value,
                    "notBefore" => after_limits.opens = value,
                    other => panic!("no capacity axis for a claim about {other}"),
                }
            }

            let before = cap(
                s.parent_spent,
                s.parent_reserved,
                Limits::genesis(),
                s.child_budget - s.child_spent,
            );
            let after = cap(ns, nr, after_limits, 0);

            // A settlement pays nobody: the coin does not leave the covenant,
            // it moves from two grants into one.
            let broke = grew(&before, &after, 0);
            if !broke.is_empty() {
                out.findings.push((
                    format!("parent spent {parent_spent} reserved {parent_reserved} · {}", case.name),
                    broke,
                ));
            }
        }
    }
    out
}

/// A source whose honest settlement is refused tells you nothing about its
/// dishonest ones. See `fuzz-delegate` for why this matters more than it
/// looks: a mutant that cannot produce an accepted transaction comes back
/// clean, and clean is exactly what a working covenant looks like.
fn baseline(src: &'static str, label: &str) -> bool {
    let s = Settle { src, ..Settle::valid() };
    match s.run() {
        Ok(()) => true,
        Err(e) => {
            println!("\n{label}: an HONEST settlement is refused — {e}");
            println!("  Not run. This is a harness fault: `settle` reads its co-input through");
            println!("  the template hash, so a source compiled at another source's geometry");
            println!("  fails in the splice, a long way from any rule under test.");
            false
        }
    }
}

fn main() {
    println!("The oracle that reads no specification — SETTLEMENT\n");
    println!("  A settlement pays nobody. After one, the parent alone must not be able to");
    println!("  do anything the parent and its child could do together — and that includes");
    println!("  the four things the parent could have quietly granted itself on the way.");

    if !baseline(SOURCE, "warda_grant.sil") {
        std::process::exit(2);
    }
    let real = sweep(SOURCE, "warda_grant.sil v4, as written");
    real.show();

    /* Four holes. Two on the money axis — the charge and the release, which
       are the two halves of the arithmetic and fail in opposite directions —
       and two on the parent's own limits, which no conservation rule covers
       and which a suite written from the guarantees would only ask about if
       somebody had thought to write the guarantee down. */
    let mutants: [(&str, &str); 4] = [
        (
            "MUTANT — the child's spending is never charged home",
            "require(newState.spentTotal == spentTotal + child.spentTotal);",
        ),
        (
            "MUTANT — the reserve release is unchecked",
            "require(newState.reserved   == reserved - child.budgetTotal);",
        ),
        (
            "MUTANT — the parent may rewrite its own per-spend cap",
            "require(newState.maxPerSpend     == maxPerSpend);",
        ),
        (
            "MUTANT — the parent may rewrite its own delegation depth",
            "require(newState.delegationDepth == delegationDepth);",
        ),
    ];

    let mut blind: Vec<&str> = Vec::new();
    let mut fired = 0usize;
    for (label, line) in mutants {
        let src = source_without(line);
        let label: &'static str = Box::leak(label.to_string().into_boxed_str());
        if !baseline(src, label) {
            blind.push(label);
            continue;
        }
        let pass = sweep(src, label);
        pass.show();
        if pass.findings.is_empty() {
            blind.push(label);
        } else {
            fired += 1;
        }
    }

    println!("\n───────────────────────────────────────────────");
    if !blind.is_empty() {
        println!("The oracle did NOT fire on {} covenant(s) with a known hole:", blind.len());
        for b in &blind {
            println!("  {b}");
        }
        println!("\nAn oracle that has never fired is indistinguishable from one that cannot.");
        println!("Nothing above about the real covenant can be trusted until this is fixed.");
        std::process::exit(2);
    }
    println!("The oracle fires on all {fired} covenants with a hole deliberately put back:");
    println!("two on the money, two on limits the parent is supposed to carry unchanged.");

    if real.findings.is_empty() {
        println!("Against the covenant as written, none of {} accepted settlements", real.accepted);
        println!("left the parent able to do more than it and its child could together.");
        std::process::exit(0);
    }
    println!("\nAgainst the covenant as written, {} did. That is a bug whatever the", real.findings.len());
    println!("guarantees say, because nothing was asked of them.");
    std::process::exit(1);
}
