//! Is the frozen covenant the frozen template?
//!
//!     cargo run --bin frozen
//!
//! ## The two questions a freeze rests on
//!
//! **1. Does prose reach the bytecode?** A grant's address is the hash of its
//! script and `covenant/versions.json`'s fingerprint is blake2b over the
//! compiled baseline. If comments do not compile, then a covenant that differs
//! from v5 only in what its header says about itself IS v5 — same fingerprint,
//! same addresses, nothing to migrate onto. That decides whether freezing
//! produces a new version at all, so it is measured rather than assumed:
//! everyone knows comments do not compile, and nobody had run it.
//!
//! **2. Is the committed template still what the source compiles to?** The
//! template is a build artifact produced by `covenant/deploy` and committed.
//! Every live address is derived from it, and nothing re-derived it from the
//! source — so "we froze the source" and "we froze the template" were two
//! claims with nothing joining them. This joins them: length, and both ends of
//! the state region, which together fix where every field slot sits.
//!
//! It is NOT a full re-derivation. The template's `baselineHex` is built with
//! the deployment's own authority and template id, which this binary does not
//! hold; three agreeing geometry figures is a tripwire, not a proof, and saying
//! so is the difference between a check and a claim.
use silverscript_lang::ast::Expr;
use silverscript_lang::compiler::{compile_contract, CompileOptions};
use warda_harness::v5::*;
use warda_harness::*;

/// One integer out of the template, without adding a JSON parser to a crate
/// that deliberately has three dependencies. The template is a generated file
/// with stable formatting and these three fields are plain numbers; a parser
/// would be more code than the thing it reads, and this fails loudly rather
/// than defaulting if the shape ever changes.
fn field(json: &str, name: &str) -> i64 {
    let key = format!("\"{name}\"");
    let at = json.find(&key).unwrap_or_else(|| panic!("template has no {name}"));
    let rest = &json[at + key.len()..];
    let rest = rest.trim_start().strip_prefix(':').expect("field is not a key").trim_start();
    let end = rest.find(|c: char| !c.is_ascii_digit() && c != '-').unwrap_or(rest.len());
    rest[..end].parse().unwrap_or_else(|_| panic!("{name} is not an integer"))
}

fn bytecode_of(src: &'static str) -> (Vec<u8>, (i64, i64)) {
    let geo = template_geometry_of(src);
    let mut ctor = ctor_full(proof_depth(), v5_authority(), [0u8; 32], geo);
    ctor[2] = Expr::int(TEMPLATE_MAX_FEE);
    let c = compile_contract(src, &ctor, CompileOptions::default()).expect("must compile");
    (c.bytecode.clone(), geo)
}

fn main() {
    let mut bad = 0;

    // ---- 1. prose against bytecode ---------------------------------------
    let (base, geo) = bytecode_of(SOURCE_V5);
    println!("warda_grant_v5.sil compiles to {} bytes · state region {:?}\n", base.len(), geo);

    let cases: [(&str, String); 3] = [
        ("a rewritten header", SOURCE_V5.replacen("v5 WORKING DRAFT", "v6 FROZEN", 1)),
        (
            "a comment added mid-file",
            SOURCE_V5.replacen(
                "    function childIdOf(State c) : byte[32] {",
                "    // frozen.\n    function childIdOf(State c) : byte[32] {",
                1,
            ),
        ),
        ("a trailing blank line", format!("{SOURCE_V5}\n\n")),
    ];
    for (what, mutated) in cases {
        let leaked: &'static str = Box::leak(mutated.into_boxed_str());
        let (b, g) = bytecode_of(leaked);
        let same = b == base && g == geo;
        println!("  {what:<28} {}", if same { "identical bytecode" } else { "DIFFERENT" });
        if !same {
            bad += 1;
        }
    }
    println!(
        "\n  So a covenant differing from v5 only in what it says about itself has v5's\n  \
         fingerprint, v5's template and v5's addresses. It is v5.\n"
    );

    // ---- 2. source against the committed template -------------------------
    let path = "../../sdk/covenant-template-v5.json";
    let tpl = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            eprintln!("  Run this from covenant/harness inside the repository — it compares the");
            eprintln!("  source against the committed template, and needs both.");
            std::process::exit(2);
        }
    };
    let len = field(&tpl, "bytecodeLen");
    let start = field(&tpl, "stateStart");
    let state_len = field(&tpl, "stateLen");
    let suffix = len - start - state_len;

    let checks = [
        ("bytecode length", base.len() as i64, len),
        ("state region starts at", geo.0, start),
        ("bytes after the state region", geo.1, suffix),
    ];
    println!("sdk/covenant-template-v5.json, against what the source compiles to now:");
    for (what, got, want) in checks {
        let ok = got == want;
        println!("  {what:<30} {got:>7}  template says {want:>7}  {}", if ok { "✓" } else { "MISMATCH" });
        if !ok {
            bad += 1;
        }
    }

    println!();
    if bad == 0 {
        println!("The frozen source and the frozen template are the same covenant.");
    } else {
        println!("{bad} check(s) failed. Do not freeze on this: either the template was built");
        println!("from a source that is no longer here, or the source has moved since.");
        std::process::exit(1);
    }
}
