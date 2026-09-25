//! The oracle that needs no specification.
//!
//! `audit` checks the bytecode against what `GUARANTEES.md` claims. That is
//! worth having and it has a hard ceiling: it cannot notice a rule that
//! SHOULD exist and does not, because the document it reads its claims from
//! is the same document that would have omitted it. Of the five
//! vulnerabilities this covenant has had, none would have been caught that
//! way.
//!
//! This binary asks a different question. It generates spend attempts
//! structurally — no rule consulted, no claim read — hands each to
//! `TxScriptEngine`, throws away everything the engine refused, and asserts
//! ONE property of what is left:
//!
//!     An accepted spend must not leave the agent able to do more than it
//!     could before, minus what it just paid.
//!
//! Nobody has to have written that down for it to be true. Authority that
//! grows is a bug whatever the spec says, and it is the shape of three of
//! the five recorded vulnerabilities: the covenant checked WHAT something
//! was and not HOW MUCH of it there was.
//!
//! An oracle that has never fired is indistinguishable from one that cannot,
//! so the run ends by removing `require(currentEpoch >= prevState.epochIndex)`
//! from the covenant — reintroducing vulnerability 1, `a048b13e95125ad1` —
//! and requiring the same oracle to catch it.

use warda_harness::oracle::{self, Capacity, Pass, grew};
use warda_harness::*;

const KAS_: i64 = KAS;

#[derive(Clone, Copy, Debug, PartialEq)]
struct St {
    spent: i64,
    reserved: i64,
    epoch_index: i64,
    epoch_spent: i64,
}

/* What a Warda state lets its agent do, in the library's terms: higher is
   always more. The budget line is the one that must fall by what was paid;
   the epoch index is negated, because an epoch consumed is capacity gone and
   an index that moves backwards is allowance coming back. */
fn cap(st: St) -> Capacity {
    Capacity {
        spendable: budget_total() - st.spent - st.reserved,
        figures: vec![("epochs not yet consumed", -st.epoch_index)],
    }
}

/* The two the library cannot know, because they are this covenant's own
   accounting. Within one epoch the allowance must fall by what was paid;
   across an epoch boundary it legitimately resets, which is the design — so
   the check is conditional, and saying so is the point of keeping it here
   rather than pretending a general rule covers it. */
fn epoch_extras(prev: St, next: St, paid: i64) -> Vec<String> {
    let mut out = Vec::new();
    if next.epoch_index == prev.epoch_index && next.epoch_spent < prev.epoch_spent + paid {
        out.push("this epoch's allowance did not fall by what was paid".into());
    }
    if next.epoch_index > prev.epoch_index && next.epoch_spent < paid {
        out.push("a fresh epoch opened without charging this payment to it".into());
    }
    if next.epoch_spent > epoch_limit() {
        out.push("more was charged to an epoch than the epoch allows".into());
    }
    if next.epoch_index < prev.epoch_index && prev.epoch_spent + paid > epoch_limit() {
        out.push("an exhausted epoch's allowance came back".into());
    }
    out
}

fn sweep(src: &'static str, label: &'static str) -> Pass {
    /* The grid. Deliberately not derived from the rules — these are the
       values an adversary would reach for, and several of them are states no
       honest client would ever build. */
    let prevs = [
        St { spent: 0, reserved: 0, epoch_index: 0, epoch_spent: 0 },
        St { spent: 3 * KAS_, reserved: 0, epoch_index: 3, epoch_spent: epoch_limit() },
        St { spent: 3 * KAS_, reserved: 0, epoch_index: 3, epoch_spent: epoch_limit() - KAS_ },
        St { spent: budget_total() - 2 * KAS_, reserved: KAS_, epoch_index: 1, epoch_spent: 0 },
    ];
    let epochs: [i64; 6] = [-1, 0, 1, 2, 3, 5];
    let amounts = [1i64, KAS_ / 2, max_per_spend(), max_per_spend() + 1];

    /* Successors an attacker would declare. The honest one is in the list so
       the generator produces accepted transactions at all; the rest are the
       lies that matter. */
    let variants: [(&str, fn(St, i64, i64) -> St); 8] = [
        ("honest", |p, amt, e| if e > p.epoch_index { St { spent: p.spent + amt, epoch_index: e, epoch_spent: amt, ..p } } else { St { spent: p.spent + amt, epoch_spent: p.epoch_spent + amt, ..p } }),
        ("unchanged", |p, _a, _e| p),
        ("epoch rewound", |p, amt, _e| St { spent: p.spent + amt, epoch_index: 0, epoch_spent: amt, ..p }),
        ("epoch spend reset", |p, amt, e| St { spent: p.spent + amt, epoch_index: e.max(p.epoch_index), epoch_spent: 0, ..p }),
        ("spend unrecorded", |p, _a, e| St { epoch_index: e.max(p.epoch_index), epoch_spent: p.epoch_spent, ..p }),
        ("reserve released", |p, amt, e| St { spent: p.spent + amt, reserved: 0, epoch_index: e.max(p.epoch_index), epoch_spent: p.epoch_spent + amt }),
        ("charged one sompi", |p, _a, e| St { spent: p.spent + 1, epoch_index: e.max(p.epoch_index), epoch_spent: p.epoch_spent + 1, ..p }),
        ("banked ahead", |p, amt, e| St { spent: p.spent + amt * 2, epoch_index: e.max(p.epoch_index), epoch_spent: p.epoch_spent + amt * 2, ..p }),
    ];

    let mut out = Pass::new(label);
    for p in prevs {
        for e in epochs {
            let claimed = not_before() + e * epoch_length() + 500;
            for amt in amounts {
                for (name, f) in variants {
                    let next = f(p, amt, e);
                    out.generated += 1;
                    let mut s = Spend::valid();
                    s.src = src;
                    s.prev = (p.spent, p.reserved, p.epoch_index, p.epoch_spent);
                    s.claimed_daa = claimed;
                    s.amount = amt;
                    s.successor = Some((next.spent, next.reserved, next.epoch_index, next.epoch_spent));
                    if s.run().is_err() {
                        continue;
                    }
                    out.accepted += 1;
                    let mut broke = grew(&cap(p), &cap(next), amt);
                    broke.extend(epoch_extras(p, next, amt));
                    if !broke.is_empty() {
                        out.findings.push((format!("prev spent {} reserved {} epoch {}/{} · claimed epoch {e} · {amt} sompi · successor {name}",
                            p.spent, p.reserved, p.epoch_index, p.epoch_spent), broke));
                    }
                }
            }
        }
    }
    out
}

fn main() {
    let real = sweep(SOURCE, "warda_grant.sil v4, as written");
    real.show();

    /* The self-check, and it is not optional. An oracle that has never fired
       is indistinguishable from one that cannot, so the same sweep runs
       against the covenant with `require(currentEpoch >= prevState.epochIndex)`
       taken out — vulnerability 1, `a048b13e95125ad1`, put back. */
    let mutant = sweep(source_without("require(currentEpoch >= prevState.epochIndex);"), "MUTANT — the epoch ratchet removed");
    mutant.show();

    oracle::write("../oracle.json", &real, &mutant);
    println!("\ncovenant/oracle.json written");
    std::process::exit(oracle::verdict(&real, &mutant));
}
