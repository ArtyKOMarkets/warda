//! The oracle that reads no specification, pointed at the EXITS.
//!
//! `fuzz`, `fuzz-delegate` and `fuzz-settle` all ask one question: did the
//! holder end up able to do more than before? That question does not work
//! here, and saying so is the point of this file being different.
//!
//! An exit ends the grant. Every axis goes to zero, so "authority never grows"
//! is satisfied by construction and would report a clean sweep against a
//! covenant with no rules in it at all. The danger on this path is the
//! opposite one — not that somebody keeps authority, but that somebody
//! DESTROYS value on the way out — and the covenant's own comment on `revoke`
//! is the best statement of it anywhere in this repo:
//!
//! ```text
//! a revoke paying 1 sompi to the principal and burning the rest to fees was
//! accepted by the engine. So the revocation key was a DESTROY capability,
//! not a STOP capability.
//! ```
//!
//! That is the shape to test, and it is testable without reading a single
//! rule, because it is DIFFERENTIAL. Ask it of the accepted exits as a set
//! rather than one at a time:
//!
//! ```text
//! Whoever may end a grant must not thereby choose what the grant is worth.
//! ```
//!
//! If the same grant can be exited twice, by the same key, with the principal
//! receiving the whole balance one time and a single sompi the other, then the
//! signer picked the outcome — and no rule needs to have been written down for
//! that to be a capability nobody meant to grant. Four properties, each with a
//! hole put back to prove it can fire:
//!
//!   - **where** the coin goes: never anywhere but the principal's own key
//!   - **how much** arrives: the spread across accepted exits stays small
//!   - **who** may end it: never the party the grant exists to limit
//!   - **when**: a term the grant states is a term, not a suggestion
//!
//!     cargo run --release --bin fuzz-exit --manifest-path covenant/harness/Cargo.toml

use warda_harness::oracle::Pass;
use warda_harness::*;

/// One accepted exit, as observed from outside — no rule consulted.
#[derive(Clone, Copy)]
struct Observed {
    which: Which,
    signer: Signer,
    /// What reached the key the grant names as its principal. Zero when the
    /// output went somewhere else entirely.
    to_principal: i64,
    daa: i64,
}

fn signer_name(s: Signer) -> &'static str {
    match s {
        Signer::Principal => "the principal's key",
        Signer::Revocation => "the revocation key",
        Signer::Agent => "the agent's key",
    }
}

fn which_name(w: Which) -> &'static str {
    match w {
        Which::Revoke => "revoke",
        Which::Reclaim => "reclaim",
    }
}

/// How much of the balance a signer may swing before they are choosing the
/// outcome rather than paying a fee.
///
/// One percent, and the figure is arbitrary in the way a threshold has to be —
/// but not in the way that matters. A transaction fee is a rounding error
/// against a grant's balance; a path where the signer can move the result by
/// a hundredth of it is a path where the signer is deciding, not paying. The
/// covenant's own answer is `maxFee`, which is 100,000 against a balance of
/// ten billion — four orders of magnitude inside this. Reading that number
/// from the covenant is exactly what this binary is built not to do, so the
/// threshold is set loose enough that the real one passes it comfortably and
/// a destroyed balance does not.
const SPREAD_ALLOWED: i64 = IN_VALUE as i64 / 100;

fn sweep(src: &'static str, label: &'static str) -> Pass {
    let mut out = Pass::new(label);
    let mut seen: Vec<Observed> = Vec::new();

    let principal: [u8; 32] = principal_keypair().x_only_public_key().0.serialize();
    let stranger = [0xeeu8; 32];

    /* What a signer might keep back. The first is what an honest exit pays;
       the last is the one the covenant's comment describes — one sompi to the
       principal and the rest burned. */
    let fees: [(&str, i64); 5] = [
        ("no fee at all", 0),
        ("the fee the covenant allows", MAX_FEE),
        ("one sompi past it", MAX_FEE + 1),
        ("a tenth of the balance", IN_VALUE as i64 / 10),
        ("all but one sompi", IN_VALUE as i64 - 1),
    ];
    let daas: [(&str, i64); 4] = [
        ("mid-term", 1_000_500),
        ("one block before the term ends", EXPIRES_AT - 1),
        ("the first moment the term allows", EXPIRES_AT),
        ("long after", EXPIRES_AT + 500_000),
    ];

    for which in [Which::Revoke, Which::Reclaim] {
        for signer in [Signer::Principal, Signer::Revocation, Signer::Agent] {
            for (pay_name, pay_to) in [("the principal", None), ("a stranger", Some(stranger))] {
                for (fee_name, fee) in fees {
                    for (daa_name, daa) in daas {
                        out.generated += 1;
                        let e = Exit { which, signer, pay_to, fee, tx_daa: daa, src };
                        if e.run().is_err() {
                            continue;
                        }
                        out.accepted += 1;

                        let to_principal = if pay_to.is_none() || pay_to == Some(principal) {
                            IN_VALUE as i64 - fee
                        } else {
                            0
                        };
                        seen.push(Observed { which, signer, to_principal, daa });

                        // WHERE. An exit that pays anyone but the principal
                        // has moved the grant's coin somewhere the grant never
                        // named, and no document is needed to call that wrong.
                        if to_principal == 0 {
                            out.findings.push((
                                format!("{} by {}, paying {pay_name}, {fee_name}, {daa_name}",
                                    which_name(which), signer_name(signer)),
                                vec!["the balance left the grant to a key the grant does not name".into()],
                            ));
                        }

                    }
                }
            }
        }
    }

    /* HOW MUCH, and WHEN. Both are properties of the accepted SET rather than
       of any one transaction, which is why they are evaluated here: a single
       exit paying one sompi to the principal is indistinguishable from an
       honest exit of a nearly empty grant. It is the SPREAD that shows the
       signer was choosing. */
    for which in [Which::Revoke, Which::Reclaim] {
        let group: Vec<&Observed> = seen.iter().filter(|o| o.which == which && o.to_principal > 0).collect();
        if group.len() < 2 {
            continue;
        }
        let most = group.iter().map(|o| o.to_principal).max().unwrap();
        let least = group.iter().map(|o| o.to_principal).min().unwrap();
        if most - least > SPREAD_ALLOWED {
            out.findings.push((
                format!("{} — {} accepted exits of the same grant", which_name(which), group.len()),
                vec![format!(
                    "the principal received between {least} and {most}: the signer chose the outcome \
                     by {} sompi, which is not a fee, it is a decision",
                    most - least
                )],
            ));
        }

        // WHEN. A term the grant states means the exit that depends on it
        // cannot be had before it. Observed, not read: if the earliest
        // accepted exit of this kind sits under the term, the term bounded
        // nothing.
        let earliest = group.iter().map(|o| o.daa).min().unwrap();
        if which == Which::Reclaim && earliest < EXPIRES_AT {
            out.findings.push((
                format!("reclaim — accepted at DAA {earliest}"),
                vec!["the grant's own term was reclaimable before it had run".into()],
            ));
        }

        // WHO. Also a property of the set: the question is not whether one
        // transaction was signed by the agent, it is whether the agent turns
        // out to be IN the set of keys that can end this grant. The agent is
        // the party the whole covenant exists to bound, and a grant it can
        // end at will is a grant it can empty at will the moment either of
        // the two properties above stops holding.
        let signers: Vec<Signer> = group.iter().map(|o| o.signer).collect();
        if signers.contains(&Signer::Agent) {
            out.findings.push((
                format!("{} — accepted from {}", which_name(which), signer_name(Signer::Agent)),
                vec!["the party the grant exists to limit is in the set of keys that can end it".into()],
            ));
        }
    }
    out
}

/// A source whose honest exits are refused says nothing about its dishonest
/// ones. Both are checked: `revoke` and `reclaim` are separate entries with
/// separate keys, and a mutant that broke only one would otherwise look
/// half-clean.
fn baseline(src: &'static str, label: &str) -> bool {
    for (name, e) in [
        ("revoke", Exit { src, ..Exit::revoke() }),
        ("reclaim", Exit { src, ..Exit::reclaim() }),
    ] {
        if let Err(err) = e.run() {
            println!("\n{label}: an HONEST {name} is refused — {err}");
            println!("  Not run. Nothing this source reports would mean anything.");
            return false;
        }
    }
    true
}

fn main() {
    println!("The oracle that reads no specification — THE EXITS\n");
    println!("  An exit ends the grant, so \"authority never grows\" is satisfied by");
    println!("  construction and proves nothing. The question that works here is the");
    println!("  opposite one, and it is differential:");
    println!("\n    Whoever may end a grant must not thereby choose what it is worth.\n");

    if !baseline(SOURCE, "warda_grant.sil") {
        std::process::exit(2);
    }
    let real = sweep(SOURCE, "warda_grant.sil v4, as written");
    real.show();

    /* One hole per property. The first is not hypothetical — it is
       vulnerability 3 of the six, and the covenant carries its post-mortem
       in a comment above the line this deletes. */
    let mutants: [(&str, &str); 4] = [
        (
            "MUTANT — value conservation removed (revoke may burn the balance)",
            "require(tx.outputs[0].value >= tx.inputs[this.activeInputIndex].value - maxFee);",
        ),
        (
            "MUTANT — the destination is unchecked (an exit may pay anyone)",
            "require(tx.outputs[0].scriptPubKey == byte[](toPrincipal));",
        ),
        (
            "MUTANT — reclaim's term is unchecked (the principal need not wait)",
            "require(tx.daa >= expiresAt);",
        ),
        /* Without this the WHO property has never fired, and a property that
           has never fired is indistinguishable from one that cannot. The
           first run of this binary reported three mutants caught and said
           nothing about the fourth check, because nothing had ever made it
           true. The line appears twice in the covenant — `settle` has the
           same clause — and removing both is fine here: no exit involves a
           settlement. */
        (
            "MUTANT — revoke's signature is unchecked (anyone may end the grant)",
            "require(checkSig(s, revocationKey));",
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
        std::process::exit(2);
    }
    println!("The oracle fires on all {fired} covenants with a hole deliberately put back:");
    println!("where the coin goes, how much of it arrives, and when the term allows it.");

    if real.findings.is_empty() {
        println!("Against the covenant as written, none of {} accepted exits let their", real.accepted);
        println!("signer choose the destination, the amount, or the moment.");
        std::process::exit(0);
    }
    println!("\nAgainst the covenant as written, {} did.", real.findings.len());
    std::process::exit(1);
}
