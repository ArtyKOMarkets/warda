//! The oracle that reads no specification, with the covenant taken out of it.
//!
//! A claims suite cannot notice a rule that should exist and does not — its
//! oracle is a document, and the document is what omitted the rule. This is
//! the other half: one property that is true of any covenant carrying
//! authority, whether or not anybody wrote it down.
//!
//!     An accepted transaction must not leave the holder able to do more than
//!     it could before, minus what it just paid.
//!
//! A covenant supplies a `Capacity` reading of a state — named figures where
//! HIGHER always means "can do more" — and this file does the rest. Two rules
//! cover most of it; anything a particular covenant needs beyond them is a
//! predicate it supplies itself, and the split is deliberate. A library that
//! claimed to know every covenant's accounting would be guessing.

/// What a state lets its holder do. Higher is always more.
pub struct Capacity {
    /// What it may still cause to be paid over the rest of the grant's life.
    pub spendable: i64,
    /// Everything else, named for the report.
    pub figures: Vec<(&'static str, i64)>,
}

/// Every way an accepted transaction left the holder better off.
///
/// `paid` is what actually left the covenant, not what the transaction said
/// it was spending — a transaction that declares one sompi and pays two KAS
/// is exactly the shape this exists to catch.
pub fn grew(before: &Capacity, after: &Capacity, paid: i64) -> Vec<String> {
    let mut out = Vec::new();
    if after.spendable > before.spendable - paid {
        out.push(format!(
            "what it may still pay did not fall by what was paid ({} → {}, paid {paid})",
            before.spendable, after.spendable
        ));
    }
    for (name, b) in &before.figures {
        if let Some((_, a)) = after.figures.iter().find(|(n, _)| n == name) {
            if a > b {
                out.push(format!("{name} grew ({b} → {a})"));
            }
        }
    }
    out
}

/// One sweep's result, for the report and for the self-check.
pub struct Pass {
    pub label: &'static str,
    pub generated: usize,
    pub accepted: usize,
    pub findings: Vec<(String, Vec<String>)>,
}

impl Pass {
    pub fn new(label: &'static str) -> Self {
        Pass { label, generated: 0, accepted: 0, findings: Vec::new() }
    }
    pub fn show(&self) {
        println!("\n{}", self.label);
        println!("  generated        {}", self.generated);
        println!("  engine accepted  {}", self.accepted);
        println!("  authority grew   {}", self.findings.len());
        for (what, why) in self.findings.iter().take(6) {
            println!("    {what}\n      {}", why.join("; "));
        }
        if self.findings.len() > 6 {
            println!("    … and {} more", self.findings.len() - 6);
        }
    }
}

/// Write what both passes found, for the report to pick up.
///
/// The report never claims an oracle result it does not have: an audit that
/// describes a check nobody executed is the failure this directory exists to
/// refuse.
pub fn write(path: &str, real: &Pass, mutant: &Pass) {
    let json = format!(
        "{{\n  \"oracle\": \"authority never grows\",\n  \"generated\": {},\n  \"accepted\": {},\n  \"findings\": {},\n  \"mutant\": {{ \"generated\": {}, \"accepted\": {}, \"findings\": {} }}\n}}\n",
        real.generated, real.accepted, real.findings.len(),
        mutant.generated, mutant.accepted, mutant.findings.len());
    std::fs::write(path, json).expect("write oracle json");
}

/// The verdict, and the exit code that goes with it.
///
/// An oracle that has never fired is indistinguishable from one that cannot,
/// so a mutant run that comes back clean is a HARDER failure than a finding
/// against the real covenant: it means nothing else printed can be trusted.
pub fn verdict(real: &Pass, mutant: &Pass) -> i32 {
    println!("\n───────────────────────────────────────────────");
    if mutant.findings.is_empty() {
        println!("The oracle did NOT fire on a covenant with a known hole in it.");
        println!("Nothing it reports about the real covenant can be trusted.");
        return 2;
    }
    println!("The oracle fires on a covenant that can grow its own authority: {} of the", mutant.findings.len());
    println!("{} transactions the engine accepted there left the holder better off.", mutant.accepted);
    if real.findings.is_empty() {
        println!("Against the covenant as written, none of {} did.", real.accepted);
        0
    } else {
        println!("\nAgainst the covenant as written, {} did. That is a bug whatever the", real.findings.len());
        println!("guarantees say, because nothing was asked of them.");
        1
    }
}
