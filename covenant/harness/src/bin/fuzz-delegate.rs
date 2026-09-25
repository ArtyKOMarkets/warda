//! The oracle that reads no specification, pointed at DELEGATION.
//!
//! `fuzz` asks one question of every spend the engine accepts: did the agent
//! end up able to do more than it could before, minus what it just paid? That
//! question needs no document, which is why it is the only instrument here
//! that can notice a rule which should exist and does not. `AUDIT.md` is blunt
//! about why that matters — of the five vulnerabilities this covenant has had,
//! none would have been caught by the claims suite.
//!
//! It covers `spend`. It has never covered delegation, which is the newest and
//! least-reviewed surface in the protocol, and the one where "authority" stops
//! being a number on one grant and becomes a property of a tree.
//!
//! So the same question, asked of a tree:
//!
//! ```text
//! A delegation pays nobody. After one, the parent and its child together
//! must not be able to do anything the parent could not do alone.
//! ```
//!
//! "Anything" is the work. Money is the obvious axis and the only one the
//! conservation rule covers; it is not the only kind of authority a grant
//! holds. A child with a higher per-spend cap cannot move more money in total
//! and can move it in bigger pieces. A child that expires later can pay after
//! its parent may. A child that opens earlier can pay before. A child with
//! equal delegation depth can build a subtree its parent could not. Each of
//! those is an axis on which a tree can be worth more than the grant it came
//! from, and each gets a figure below, because an oracle that only counts
//! sompi would watch every one of them go past.
//!
//!     cargo run --release --bin fuzz-delegate --manifest-path covenant/harness/Cargo.toml

use warda_harness::oracle::{grew, Capacity, Pass};
use warda_harness::*;

/// What a parent and (optionally) its one child can do together.
///
/// ## What this reading does NOT capture
///
/// Four of the five figures are a MAXIMUM over the tree, and a maximum cannot
/// see breadth. A child born at its parent's own delegation depth does not
/// raise the deepest chain the tree can build — but it gives the tree two
/// chains of that depth where there was one, and that is authority the parent
/// did not hold. The depth mutant below demonstrates the gap rather than
/// hiding it: with the attenuation removed, this oracle catches the child that
/// goes one deeper and says nothing about the child that merely matches.
///
/// Counting instead of maximising would need the oracle to model a whole tree
/// rather than one delegation, which is a bigger instrument than this. Saying
/// so here is the alternative to implying coverage that does not exist.
///
/// Higher is always more, on every line — that is the contract `grew` relies
/// on. Two of these are negated for that reason: an epoch index that moves
/// backwards is allowance coming back, and a `notBefore` that moves earlier is
/// a window opening wider.
fn tree_cap(parent_spent: i64, parent_reserved: i64, child: Option<&Child>) -> Capacity {
    let parent_left = BUDGET_TOTAL - parent_spent - parent_reserved;
    let child_left = child.map(|c| c.budget - c.accounting.0).unwrap_or(0);

    let (max_per_spend, epoch_limit, depth, expires, opens) = match child {
        None => (MAX_PER_SPEND, EPOCH_LIMIT, DELEGATION_DEPTH, EXPIRES_AT, NOT_BEFORE),
        Some(c) => (
            MAX_PER_SPEND.max(c.max_per_spend),
            EPOCH_LIMIT.max(c.epoch_limit),
            DELEGATION_DEPTH.max(c.delegation_depth),
            EXPIRES_AT.max(c.expires_at),
            NOT_BEFORE.min(c.not_before),
        ),
    };

    Capacity {
        spendable: parent_left + child_left,
        figures: vec![
            ("the largest single payment the tree can make", max_per_spend),
            ("what the tree may pay in one epoch", epoch_limit),
            ("generations it may still delegate", depth),
            ("the last moment it may pay", expires),
            // Negated: an earlier opening is a wider window, and `grew` only
            // knows that bigger is worse.
            ("how early it may start paying", -opens),
        ],
    }
}

/// One way to build a child, and a name for the report.
struct Shape {
    name: &'static str,
    build: fn(&mut Child),
}

/// A function rather than a `const`, because the values these close over are
/// the covenant's own constants and a const array of function pointers is one
/// more thing to argue with the compiler about than this is worth.
fn shapes() -> Vec<Shape> {
    vec![
    // LEGAL shapes first, and there are several on purpose. The oracle only
    // sees transactions the engine accepted, so a grid made mostly of
    // violations sweeps almost nothing: the first version of this file
    // generated three hundred delegations and the engine accepted eleven.
    // Every legal shape here is another accepted transaction the property
    // gets asked about.
    Shape { name: "honest, narrower on every axis", build: |_c| {} },
    Shape { name: "narrowed to almost nothing", build: |c| {
        c.budget = KAS;
        c.max_per_spend = KAS / 100;
        c.epoch_limit = KAS / 10;
        c.delegation_depth = 0;
    } },
    Shape { name: "cap far below the parent's", build: |c| c.max_per_spend = 1 },
    Shape { name: "epoch limit equal to the parent's", build: |c| c.epoch_limit = EPOCH_LIMIT },
    Shape { name: "depth zero — a leaf that cannot delegate", build: |c| c.delegation_depth = 0 },
    Shape { name: "expires before the parent", build: |c| c.expires_at = EXPIRES_AT - 1_000 },
    Shape { name: "opens after the parent", build: |c| c.not_before = NOT_BEFORE + 1_000 },
    Shape { name: "budget: half the parent's", build: |c| c.budget = BUDGET_TOTAL / 2 },
    // Money. The conservation rule's own territory, approached from both
    // sides — a child that takes exactly what is left, and one that takes a
    // sompi more.
    Shape { name: "budget: one sompi", build: |c| c.budget = 1 },
    Shape { name: "budget: the parent's whole budget", build: |c| c.budget = BUDGET_TOTAL },
    Shape { name: "budget: negative", build: |c| c.budget = -KAS },
    // Rate. Cannot move more money in total; moves it in bigger pieces, which
    // is a different authority and one a total-only oracle never sees.
    Shape { name: "cap: equal to the parent's", build: |c| c.max_per_spend = MAX_PER_SPEND },
    Shape { name: "cap: one sompi above the parent's", build: |c| c.max_per_spend = MAX_PER_SPEND + 1 },
    Shape { name: "cap: ten times the parent's", build: |c| c.max_per_spend = MAX_PER_SPEND * 10 },
    Shape { name: "epoch limit: above the parent's", build: |c| c.epoch_limit = EPOCH_LIMIT + 1 },
    // Depth. A child at its parent's depth can build a subtree the parent
    // could not, which is authority the parent never held.
    Shape { name: "depth: equal to the parent's", build: |c| c.delegation_depth = DELEGATION_DEPTH },
    Shape { name: "depth: above the parent's", build: |c| c.delegation_depth = DELEGATION_DEPTH + 1 },
    // Time. Neither of these moves a sompi and both widen the tree's reach.
    Shape { name: "expires after the parent", build: |c| c.expires_at = EXPIRES_AT + 1 },
    Shape { name: "opens before the parent", build: |c| c.not_before = NOT_BEFORE - 1 },
    // Born dirty. A negative opening balance is capacity conjured out of the
    // accounting rather than out of the budget.
    Shape { name: "born having spent one sompi", build: |c| c.accounting = (1, 0, 0, 0) },
    Shape { name: "born having spent MINUS one sompi", build: |c| c.accounting = (-1, 0, 0, 0) },
    Shape { name: "born with an epoch already open", build: |c| c.accounting = (0, 0, 3, 0) },
    ]
}

/// What the parent CLAIMS its reserve became. The honest answer is derived;
/// the rest are the lies a parent would tell to keep spending money it has
/// just promised to somebody else.
fn reserve_claims(prev_reserved: i64, budget: i64) -> [(&'static str, Option<i64>); 5] {
    [
        ("honest", None),
        ("reserve not advanced at all", Some(prev_reserved)),
        ("reserve short by one sompi", Some(prev_reserved + budget - 1)),
        ("reserve long by one sompi", Some(prev_reserved + budget + 1)),
        ("reserve zeroed", Some(0)),
    ]
}

/// One attempt: build it, run it, and if the engine took it, ask the question.
fn attempt(
    out: &mut Pass,
    src: &'static str,
    prev: (i64, i64),
    child: &Child,
    claim: (&str, Option<i64>),
    shape_name: &str,
) {
    let (prev_spent, prev_reserved) = prev;
    let (claim_name, override_) = claim;
    out.generated += 1;

    let d = Delegate {
        child: child.clone(),
        parent_reserved_override: override_,
        parent_prev: prev,
        src,
        ..Delegate::valid()
    };
    if d.run().is_err() {
        return;
    }
    out.accepted += 1;

    /* What the parent's reserve actually became - which is what its successor
       was compiled at, not what we meant by it. */
    let reserved_after = override_.unwrap_or(prev_reserved + child.budget);
    let before = tree_cap(prev_spent, prev_reserved, None);
    let after = tree_cap(prev_spent, reserved_after, Some(child));

    // A delegation pays nobody: nothing was spent that could justify the tree
    // being worth more afterwards.
    let broke = grew(&before, &after, 0);
    if !broke.is_empty() {
        out.findings.push((
            format!("parent spent {prev_spent} reserved {prev_reserved} · child {shape_name} · {claim_name}"),
            broke,
        ));
    }
}

/* Parents an adversary would delegate from. The last two matter most:
   conservation is only interesting once something is already committed, and a
   parent at genesis has nothing to double-promise. */
const PREVS: [(i64, i64); 4] = [
    (0, 0),
    (3 * KAS, 0),
    (0, 40 * KAS),
    (BUDGET_TOTAL - 2 * KAS, KAS),
];

/// TWO passes, not one grid.
///
/// The first version of this crossed every child shape with every reserve
/// claim: 440 delegations and thirteen minutes, because a mutant is a
/// different source, so nothing in the compile cache survives it and every
/// constructor is built again from scratch.
///
/// Most of that work asked nothing. Whether a child with an illegally wide
/// per-spend cap is ALSO accompanied by a lying reserve is not one question,
/// it is two questions multiplied - and the engine refuses it for whichever
/// it reaches first, so the second is never really asked. Sweeping the money
/// axis and the attenuation axes separately covers each of them the same and
/// costs a quarter of the compiles.
fn sweep(src: &'static str, label: &'static str) -> Pass {
    let mut out = Pass::new(label);

    // Conservation: does the parent's reserve account for what it lent? Only
    // the budget varies here, because that is the figure the reserve follows.
    let budgets: [(&str, i64); 4] = [
        ("honest, narrower on every axis", 25 * KAS),
        ("budget: one sompi", 1),
        ("budget: half the parent's", BUDGET_TOTAL / 2),
        ("budget: negative", -KAS),
    ];
    for prev in PREVS {
        for (name, budget) in budgets {
            let mut child = Child::narrower();
            child.budget = budget;
            for claim in reserve_claims(prev.1, budget) {
                attempt(&mut out, src, prev, &child, claim, name);
            }
        }
    }

    // Attenuation: is the child narrower than its parent on every axis it
    // has? The reserve claim stays honest throughout - a lie there would only
    // give the engine a second reason to refuse, and a refusal for the wrong
    // reason tests nothing. That is the same discipline the flip tests use.
    for prev in [PREVS[0], PREVS[1]] {
        for shape in &shapes() {
            let mut child = Child::narrower();
            (shape.build)(&mut child);
            attempt(&mut out, src, prev, &child, ("honest", None), shape.name);
        }
    }
    out
}


/// Before believing anything a sweep says about a source, check that the
/// source can produce an accepted delegation at all.
///
/// A mutant is a different source, so it compiles to a different size, so its
/// template hash and state-region offsets differ — and the covenant splices
/// its own bytecode at those offsets to derive the successor address it
/// demands. Get that wrong and the engine refuses everything, the sweep finds
/// nothing, and "nothing found" reads as a clean covenant when it means the
/// harness never ran. That is the only failure this whole approach cannot
/// survive, so it is checked rather than assumed.
fn baseline(src: &'static str, label: &str) -> bool {
    let d = Delegate { src, ..Delegate::valid() };
    match d.run() {
        Ok(()) => true,
        Err(e) => {
            println!("\n{label}: an HONEST delegation is refused — {e}");
            println!("  Nothing this source reports means anything. The sweep is not run.");
            println!("  This is a harness fault, not a covenant one: the source compiles to a");
            println!("  different size than the constructor was told about, so the successor");
            println!("  address the covenant derives is not the one the transaction pays.");
            false
        }
    }
}

fn main() {
    println!("The oracle that reads no specification — DELEGATION\n");
    println!("  A delegation pays nobody, so after one the parent and its child together");
    println!("  must not be able to do anything the parent could not do alone. Money is");
    println!("  one axis of that. Rate, reach, lifetime and depth are four more.");

    if !baseline(SOURCE, "warda_grant.sil") {
        std::process::exit(2);
    }
    let real = sweep(SOURCE, "warda_grant.sil v4, as written");
    real.show();

    /* Three holes, each on a different axis, because one mutant only proves
       the oracle can see one thing. The conservation mutant is the money axis
       — the rule everyone would think to write. The other two are the ones a
       suite built from the guarantees would never ask about, and they are the
       reason this binary reports five figures rather than one number. */
    let mutants: [(&str, &str); 3] = [
        (
            "MUTANT — conservation removed (the parent need not reserve what it lent)",
            "require(parentNext.reserved        == reserved + child.budgetTotal);",
        ),
        (
            "MUTANT — rate attenuation removed (a child may raise its own per-spend cap)",
            "require(child.maxPerSpend     <= maxPerSpend);",
        ),
        (
            "MUTANT — depth attenuation removed (a child may delegate as deep as its parent)",
            "require(child.delegationDepth <  delegationDepth);",
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
    println!("The oracle fires on all {fired} covenants with a hole deliberately put back,");
    println!("each on a different axis — money, rate, and depth.");

    if real.findings.is_empty() {
        println!("Against the covenant as written, none of {} accepted delegations", real.accepted);
        println!("left the tree able to do more than the parent could alone.");
        std::process::exit(0);
    }
    println!("\nAgainst the covenant as written, {} did. That is a bug whatever the", real.findings.len());
    println!("guarantees say, because nothing was asked of them.");
    std::process::exit(1);
}
