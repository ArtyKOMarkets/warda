//! The oracle that reads no specification, pointed at ATOMIC DELEGATION.
//!
//! `fuzz-delegate` asks it of one child. This asks it of two, against
//! `covenant/warda_grant_v5.sil` — the entrypoint that is on chain, is
//! labelled *draft, unaudited* in `GUARANTEES.md`, and is the newest code in
//! this repo by a month.
//!
//! ```text
//! A delegation pays nobody, however many children it makes. Afterwards the
//! parent and ALL of them together must not be able to do anything the parent
//! could do alone.
//! ```
//!
//! Two children is not one child twice, and three of the rules only exist
//! because of the second one:
//!
//!   - The budget bound is SEQUENTIAL. B is measured against what is left
//!     after A, not against the same headroom A was measured on. Checking each
//!     against the full uncommitted amount is the mistake that lets a tree
//!     hold more authority than its budget, and it is the one a loop written
//!     carelessly makes.
//!   - The two children must be distinct authorities. Both outputs under one
//!     agent key is ONE authority issued twice — same child id, pushed twice
//!     onto the reserve chain, and the parent owes a child that does not
//!     separately exist.
//!   - The chain is pushed in OUTPUT ORDER, and settlement pops it from the
//!     end. An order that does not match is a tree whose second child can
//!     never come home.
//!
//! The oracle sees the first of those directly, because a tree that holds more
//! than its parent's budget is a tree whose capacity grew. It does NOT see the
//! other two — a duplicate child and a reversed chain both conserve every
//! figure below — and that is stated here rather than implied away. `c1`'s
//! flip suite covers them; this covers what a flip suite cannot, which is the
//! rule nobody wrote down.
//!
//!     cargo run --release --bin fuzz-delegate2 --manifest-path covenant/harness/Cargo.toml

use warda_harness::oracle::{grew, Capacity, Pass};
use warda_harness::v5::*;
use warda_harness::*;

/// What a parent and its two children can do together. Higher is always more.
///
/// Clamped at zero for the same reason `fuzz-delegate` is: a parent whose
/// spent-plus-reserved exceeds its budget can cause nothing more to be paid,
/// and without the clamp the two sides cancel exactly — an over-committed
/// tree subtracts from the parent precisely what it adds to the children and
/// reads as conserved. That clamp is what makes the sequential bound visible
/// at all, which is the single most valuable thing this binary asks.
fn tree_cap(spent: i64, reserved: i64, kids: &[&Child]) -> Capacity {
    let parent_left = (budget_total() - spent - reserved).max(0);
    let kids_left: i64 = kids.iter().map(|c| (c.budget - c.accounting.0).max(0)).sum();

    let biggest = |f: fn(&Child) -> i64, floor: i64| kids.iter().map(|c| f(c)).fold(floor, i64::max);
    let earliest = kids.iter().map(|c| c.not_before).fold(not_before(), i64::min);

    Capacity {
        spendable: parent_left + kids_left,
        figures: vec![
            ("the largest single payment the tree can make", biggest(|c| c.max_per_spend, max_per_spend())),
            ("what the tree may pay in one epoch", biggest(|c| c.epoch_limit, epoch_limit())),
            ("generations it may still delegate", biggest(|c| c.delegation_depth, delegation_depth())),
            ("the last moment it may pay", biggest(|c| c.expires_at, expires_at())),
            ("how early it may start paying", -earliest),
        ],
    }
}

struct Shape {
    name: &'static str,
    build: fn(&mut Child),
}

fn shapes() -> Vec<Shape> {
    vec![
        Shape { name: "narrower on every axis", build: |_c| {} },
        Shape { name: "narrowed to almost nothing", build: |c| {
            c.budget = KAS;
            c.max_per_spend = KAS / 100;
            c.epoch_limit = KAS / 10;
            c.delegation_depth = 0;
        } },
        Shape { name: "a bigger budget", build: |c| c.budget = 40 * KAS },
        Shape { name: "cap equal to the parent's", build: |c| c.max_per_spend = max_per_spend() },
        Shape { name: "cap above the parent's", build: |c| c.max_per_spend = max_per_spend() + 1 },
        Shape { name: "epoch limit above the parent's", build: |c| c.epoch_limit = epoch_limit() + 1 },
        Shape { name: "depth equal to the parent's", build: |c| c.delegation_depth = delegation_depth() },
        Shape { name: "outliving the parent", build: |c| c.expires_at = expires_at() + 1 },
        Shape { name: "opening before the parent", build: |c| c.not_before = not_before() - 1 },
        Shape { name: "born having spent MINUS one sompi", build: |c| c.accounting = (-1, 0, 0, 0) },
    ]
}

/// Parents worth delegating twice from. The committed ones are the point: with
/// an empty parent, two children that do not fit together do not fit into the
/// input value either, so the engine refuses for the coin and the sequential
/// bound is never reached.
fn prevs() -> [(i64, i64); 4] {
    [
    (0, 0),
    (0, 60 * KAS),
    (20 * KAS, 40 * KAS),
    (budget_total() - 30 * KAS, 0),
]
}

fn attempt(out: &mut Pass, src: &'static str, prev: (i64, i64), a: &Child, b: &Child, what: String) {
    let (prev_spent, prev_reserved) = prev;
    out.generated += 1;
    let f = Flip { prev_spent, prev_reserved, src, ..Flip::default() };
    if delegate2_run(a, b, &f).is_err() {
        return;
    }
    out.accepted += 1;

    let reserved_after = f.reserved.unwrap_or(prev_reserved + a.budget + b.budget);
    let before = tree_cap(prev_spent, prev_reserved, &[]);
    let after = tree_cap(prev_spent, reserved_after, &[a, b]);

    let broke = grew(&before, &after, 0);
    if !broke.is_empty() {
        out.findings.push((format!("parent spent {prev_spent} reserved {prev_reserved} · {what}"), broke));
    }
}

fn sweep(src: &'static str, label: &'static str) -> Pass {
    let mut out = Pass::new(label);
    let shapes = shapes();

    for prev in prevs() {
        // One shape at a time, on B, with A honest — every attenuation axis,
        // asked of the child a careless loop would check second or not at all.
        for shape in &shapes {
            let a = Child::narrower();
            let mut b = Child::narrower();
            (shape.build)(&mut b);
            attempt(&mut out, src, prev, &a, &b, format!("A honest, B {}", shape.name));

            // And on A, with B honest. The mirror matters: a rule applied to
            // `newStates[1]` and forgotten for `newStates[2]` passes every
            // case that only ever moves the second one.
            let mut a2 = Child::narrower();
            (shape.build)(&mut a2);
            let b2 = Child::narrower();
            attempt(&mut out, src, prev, &a2, &b2, format!("A {}, B honest", shape.name));
        }

        // The SEQUENTIAL bound, approached from both sides: two children that
        // each fit in what is left and together do not, and the same pair one
        // sompi smaller so they do.
        let left = budget_total() - prev.0 - prev.1;
        for (name, each) in [
            ("each exactly half of what is left", left / 2),
            ("each half plus one sompi", left / 2 + 1),
            ("each the whole of what is left", left),
        ] {
            let mut a = Child::narrower();
            let mut b = Child::narrower();
            a.budget = each;
            b.budget = each;
            attempt(&mut out, src, prev, &a, &b, format!("both children {name}"));
        }
    }
    out
}

fn baseline(src: &'static str, label: &str) -> bool {
    let a = Child::narrower();
    let b = Child::narrower();
    match delegate2_run(&a, &b, &Flip { src, ..Flip::default() }) {
        Ok(()) => true,
        Err(e) => {
            println!("\n{label}: an HONEST atomic delegation is refused — {e}");
            println!("  Not run. A mutant is a different source, so it is a different size, so");
            println!("  its template hash and state-region offsets differ from the ones its");
            println!("  constructor was told about — and the covenant splices its own bytecode");
            println!("  at those offsets. Nothing this source reports would mean anything.");
            false
        }
    }
}

fn main() {
    println!("The oracle that reads no specification — ATOMIC DELEGATION (v5)\n");
    println!("  A delegation pays nobody, however many children it makes. Afterwards the");
    println!("  parent and all of them together must not be able to do anything the parent");
    println!("  could do alone.");

    if !baseline(SOURCE_V5, "warda_grant_v5.sil") {
        std::process::exit(2);
    }
    let real = sweep(SOURCE_V5, "warda_grant_v5.sil, as written");
    real.show();

    /* Three holes. The first is the one this entrypoint exists to get right
       and the one a careless loop gets wrong: measure B against the same
       headroom A was measured on, and two children that each fit will both be
       accepted together. */
    let mutants: [(&str, &str); 3] = [
        (
            "MUTANT — the second child measured against the same headroom as the first",
            "require(childB.budgetTotal <= headroom - childA.budgetTotal);",
        ),
        (
            "MUTANT — the second child may raise its own per-spend cap",
            "require(childB.maxPerSpend     <= maxPerSpend);",
        ),
        (
            "MUTANT — the FIRST child may raise its own per-spend cap",
            "require(childA.maxPerSpend     <= maxPerSpend);",
        ),
    ];

    /* The mutants are the instrument proving itself, and each is a different
       source — a full recompile of every constructor, which costs three
       quarters of this binary's running time. At a SECOND grant shape the
       question being asked is about the covenant, not about whether the oracle
       can fire, and firing is not a property of the shape. So the shape matrix
       runs with --no-mutants and CI does not. */
    if std::env::args().any(|a| a == "--no-mutants") {
        println!("\n───────────────────────────────────────────────");
        println!("Mutants skipped (--no-mutants). This run says what the covenant did at");
        println!("{}", shape_line());
        println!("and NOT that the oracle is capable of finding a hole — for that, run it");
        println!("without the flag, as CI does.");
        std::process::exit(if real.findings.is_empty() { 0 } else { 1 });
    }

    let mut blind: Vec<&str> = Vec::new();
    let mut fired = 0usize;
    for (label, line) in mutants {
        let src = source_without_in(SOURCE_V5, line);
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
        std::process::exit(2);
    }
    println!("The oracle fires on all {fired} covenants with a hole deliberately put back,");
    println!("including the sequential budget bound, which only exists because of the");
    println!("second child and which a loop written carelessly would not have.");

    if real.findings.is_empty() {
        println!("Against v5 as written, none of {} accepted atomic delegations left", real.accepted);
        println!("the tree able to do more than the parent could alone.");
        std::process::exit(0);
    }
    println!("\nAgainst v5 as written, {} did. That is a bug whatever the guarantees", real.findings.len());
    println!("say, because nothing was asked of them.");
    std::process::exit(1);
}
