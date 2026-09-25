//! The evidence that claim 40 is refused by the rule it names.
//!
//! `settle` requires two things about its co-input's continuation:
//!
//! ```text
//! require(OpAuthOutputCount(parentIdx) == 1);
//! require(OpAuthOutputIdx(parentIdx, 0) == 0);
//! ```
//!
//! `AUDIT.md` reported this claim as **not covered** from its first run, and
//! the reason is worth keeping rather than deleting with the entry: the
//! parent's `reabsorb` requires the identical predicate about the identical
//! input. The two are redundant by construction, so no whole transaction can
//! violate the child's version without violating the parent's, and the
//! parent's input is verified first. A refusal of the pair proves only that
//! ONE of them fired.
//!
//! The audit now covers it with two cases that execute the child's script
//! alone. This binary is why that is allowed to count. Each case is run
//! against the covenant as written and against a covenant with ONE of the two
//! lines deleted, and the isolation has to be exact:
//!
//!   - displacing the continuation to output 1 must be ACCEPTED when the
//!     INDEX line is removed, and still refused when the COUNT line is
//!     removed
//!   - a second authorised output must be the mirror of that
//!
//! If either crosses over, the two cases in `audit.rs` are not testing the
//! lines they name and the claim goes back to uncovered. Committed and run in
//! CI rather than recorded in a comment, because "I checked this once" is the
//! thing this repo keeps finding out was not true.
//!
//!     cargo run --release --bin settle-continuation --manifest-path covenant/harness/Cargo.toml

use warda_harness::*;

const INDEX_LINE: &str = "require(OpAuthOutputIdx(parentIdx, 0) == 0);";
const COUNT_LINE: &str = "require(OpAuthOutputCount(parentIdx) == 1);";

fn accepted(outputs: Outputs, src: &'static str) -> bool {
    Settle { outputs, only_input: Some(1), src, ..Settle::valid() }.run().is_ok()
}

fn main() {
    println!("claim 40 — output 0 is the co-input grant's single authorised continuation\n");

    let cases: [(&str, Outputs, &str, &str); 2] = [
        ("continuation displaced to output 1", Outputs::Displaced, INDEX_LINE, COUNT_LINE),
        ("a second output from the same input", Outputs::Doubled, COUNT_LINE, INDEX_LINE),
    ];

    let mut bad = 0;
    // The baseline first: a refusal means nothing without one.
    let base = accepted(Outputs::Normal, SOURCE);
    println!("  {:<38} {}", "the honest shape, child input only", if base { "ACCEPTED" } else { "REFUSED" });
    if !base {
        println!("\n  The child's script refuses the honest shape, so nothing below means anything.");
        std::process::exit(2);
    }

    for (name, outputs, own, other) in cases {
        let real = accepted(outputs, SOURCE);
        let without_own = accepted(outputs, source_without(own));
        let without_other = accepted(outputs, source_without(other));
        println!("\n  {name}");
        println!("    v4 as written                  {}", if real { "ACCEPTED" } else { "refused" });
        println!("    its own line removed           {}", if without_own { "ACCEPTED" } else { "refused" });
        println!("    the OTHER line removed         {}", if without_other { "ACCEPTED" } else { "refused" });

        if real {
            println!("    ^ the covenant does not refuse this at all.");
            bad += 1;
        }
        if !without_own {
            println!("    ^ still refused with its own line gone: something ELSE is doing the refusing,");
            println!("      and the audit case that cites this line does not test it.");
            bad += 1;
        }
        if without_other {
            println!("    ^ accepted with the other line gone: the two are not separable here.");
            bad += 1;
        }
    }

    println!("\n───────────────────────────────────────────────");
    if bad > 0 {
        println!("{bad} of the isolations do not hold. Claim 40 is NOT covered by the cases that");
        println!("say they cover it, whatever AUDIT.md prints.");
        std::process::exit(1);
    }
    println!("Each case is refused by its own line and by nothing else: removing that line");
    println!("accepts it, removing the other does not. Claim 40 is covered by construction,");
    println!("not by assertion.");
}
