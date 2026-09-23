//! `scan` — what can be said about a covenant nobody has written a builder for.
//!
//! The claims suite and the oracle both need per-covenant code: a function
//! that constructs a valid transaction for this covenant's entrypoints. That
//! is not a gap waiting to be closed, it is what a covenant's design IS
//! (see PORTING.md). So neither of them can be pointed at a stranger's `.sil`.
//!
//! This can. It parses the contract, synthesises a constructor from the
//! declared parameter types, compiles it, and reports what is true of the
//! compiled artefact: its size against the consensus ceiling, its ABI, its
//! state layout, and every condition it refuses on, grouped by the entrypoint
//! that enforces it.
//!
//! What it does NOT do is say whether those conditions are the right ones or
//! whether they are where their author thinks they are. That needs a
//! transaction, and a transaction needs a builder.
//!
//!     cargo run --bin scan -- path/to/covenant.sil

use silverscript_lang::ast::{ArrayDim, ContractAst, Expr, Statement, TypeBase, TypeRef, parse_contract_ast};
use silverscript_lang::compiler::{compile_contract, CompileOptions};

/// rusty-kaspa's own constants, not estimates.
const MAX_SCRIPT_BYTES: usize = 1_000_000;

/// The placeholder every integer argument gets. Small on purpose: the first
/// version used 1,000 and reported this covenant at 148,634 bytes, because
/// `maxProofDepth` is a loop bound and a thousand-deep Merkle fold unrolls
/// into a script nobody would deploy. The figure was not wrong, it was the
/// size of a covenant nobody asked about — which is worse than wrong, because
/// it looks like an answer.
const BASE_INT: i64 = 4;

/// A value of the declared type, chosen to compile rather than to mean
/// anything. Lengths matter and magnitudes do not: Script encodes integers at
/// minimal width, so a large number changes the bytecode size and a small one
/// does not, and the point of this pass is the size.
fn placeholder(t: &TypeRef) -> Option<Expr<'static>> {
    if let Some(d) = t.array_dims.first() {
        return match (d, &t.base) {
            // byte[32] and friends: a fixed run of bytes.
            (ArrayDim::Fixed(n), TypeBase::Byte) => Some(Expr::bytes(vec![0x11; *n])),
            _ => None,
        };
    }
    match t.base {
        TypeBase::Int | TypeBase::Temporal => Some(Expr::int(BASE_INT)),
        TypeBase::Bool => Some(Expr::bool(false)),
        // An x-only key is 32 bytes, and the compiler takes it as such.
        TypeBase::Pubkey => Some(Expr::bytes(vec![0x11; 32])),
        _ => None,
    }
}

/// Every `require` in a function body, including the ones inside `if` and
/// `for`. Counted from the AST rather than grepped: a `require` inside a
/// branch is still a condition the covenant enforces, and a comment that
/// mentions one is not.
fn requires(body: &[Statement<'_>], out: &mut Vec<String>) {
    for st in body {
        match st {
            Statement::Require { span, .. } => out.push(span.as_str().trim().to_string()),
            Statement::RequireTxDaa { span, .. } => out.push(span.as_str().trim().to_string()),
            Statement::RequireAgeDaa { span, .. } => out.push(span.as_str().trim().to_string()),
            Statement::RequireTxTime { span, .. } => out.push(span.as_str().trim().to_string()),
            Statement::If { then_branch, else_branch, .. } => {
                requires(then_branch, out);
                if let Some(e) = else_branch { requires(e, out); }
            }
            Statement::For { body, .. } => requires(body, out),
            Statement::Block { body, .. } => requires(body, out),
            _ => {}
        }
    }
}

fn ty(t: &TypeRef) -> String {
    let base = match &t.base {
        TypeBase::Int => "int".into(),
        TypeBase::Temporal => "temporal".into(),
        TypeBase::Bool => "bool".into(),
        TypeBase::String => "string".into(),
        TypeBase::Pubkey => "pubkey".into(),
        TypeBase::Sig => "sig".into(),
        TypeBase::Datasig => "datasig".into(),
        TypeBase::Byte => "byte".into(),
        TypeBase::Tuple(_) => "tuple".into(),
        TypeBase::Custom(c) => c.clone(),
    };
    let dims: String = t.array_dims.iter().map(|d| match d {
        ArrayDim::Fixed(n) => format!("[{n}]"),
        ArrayDim::Dynamic => "[]".into(),
        ArrayDim::Inferred => "[_]".into(),
        ArrayDim::Constant(c) => format!("[{c}]"),
    }).collect();
    format!("{base}{dims}")
}

fn main() {
    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: scan <covenant.sil>");
            eprintln!("\nReports what is true of a covenant nobody has written a builder for.");
            std::process::exit(64);
        }
    };
    let source: &'static str = Box::leak(
        std::fs::read_to_string(&path).unwrap_or_else(|e| { eprintln!("{path}: {e}"); std::process::exit(66) }).into_boxed_str(),
    );

    let ast: ContractAst<'static> = match parse_contract_ast(source) {
        Ok(a) => a,
        Err(e) => { eprintln!("{path}: does not parse — {e:?}"); std::process::exit(65) }
    };

    println!("{}  ·  {}", ast.name, path);
    println!("{}", "─".repeat(60));

    // ---- the constructor, and whether this pass can stand one up ----------
    println!("\nCONSTRUCTOR  {} argument{}", ast.params.len(), if ast.params.len() == 1 { "" } else { "s" });
    let mut args: Vec<Expr<'static>> = Vec::new();
    let mut unsupported: Vec<String> = Vec::new();
    for p in &ast.params {
        let t = ty(&p.type_ref);
        match placeholder(&p.type_ref) {
            Some(v) => args.push(v),
            None => unsupported.push(format!("{} {}", t, p.name)),
        }
        println!("  {:<24} {}", p.name, t);
    }

    /* ---- what it exposes -------------------------------------------------
       `entrypoint` on the AST is true only for `entry` functions. A function
       carrying a `#[covenant...]` attribute is ALSO callable — it appears in
       the ABI as `__covenant_entrypoint_<name>` and is invoked through the
       covenant-declaration sigscript builder rather than the plain one.

       The first version of this pass counted only the first kind and told a
       reader this covenant had three ways in. It has six, and the three it
       omitted are the ones that move money. A tool that under-reports the
       attack surface by half is worse than no tool, because the number looks
       like it was checked. */
    let callable: Vec<_> = ast.functions.iter()
        .filter(|f| f.entrypoint || f.attributes.iter().any(|a| a.path.first().map(|p| p == "covenant").unwrap_or(false)))
        .collect();
    println!("\nENTRYPOINTS  {}", callable.len());
    for f in &callable {
        let ps: Vec<String> = f.params.iter().map(|p| format!("{} {}", ty(&p.type_ref), p.name)).collect();
        let attrs: Vec<String> = f.attributes.iter().map(|a| format!("#[{}]", a.path.join("."))).collect();
        let kind = if f.entrypoint { "entry" } else { "covenant" };
        println!("  {:<10} {}({})", kind, f.name, ps.join(", "));
        if !attrs.is_empty() {
            println!("             {}", attrs.join(" "));
        }
    }

    // ---- the refusal surface ----------------------------------------------
    println!("\nWHAT IT REFUSES ON");
    let mut total = 0usize;
    for f in &ast.functions {
        let mut rs = Vec::new();
        requires(&f.body, &mut rs);
        if rs.is_empty() { continue; }
        total += rs.len();
        println!("\n  {} — {} condition{}", f.name, rs.len(), if rs.len() == 1 { "" } else { "s" });
        for r in &rs {
            let one = r.split_whitespace().collect::<Vec<_>>().join(" ");
            println!("    {}", if one.len() > 96 { format!("{}…", &one[..93]) } else { one });
        }
    }
    println!("\n  {total} conditions in total.");

    // ---- the compiled artefact --------------------------------------------
    println!("\nCOMPILED");
    if !unsupported.is_empty() {
        println!("  not attempted — no placeholder for: {}", unsupported.join(", "));
        println!("  A constructor taking a struct or a dynamic array needs a real value, which is");
        println!("  the same thing as needing a builder. Everything above still holds.");
        return;
    }
    match compile_contract(source, &args, CompileOptions::default()) {
        Ok(c) => {
            let n = c.bytecode.len();
            println!("  bytecode           {n} bytes, with every integer argument at {BASE_INT}");
            println!("  script-size limit  {MAX_SCRIPT_BYTES} — {:.3}% of it at these arguments",
                (n as f64 / MAX_SCRIPT_BYTES as f64) * 100.0);
            /* A covenant function is `spend` in the source and
               `__covenant_entrypoint_auth_spend` in the ABI. Printing the ABI
               alone leaves a reader matching names by eye. */
            println!("  abi                {} function{}", c.abi.len(), if c.abi.len() == 1 { "" } else { "s" });
            for e in &c.abi {
                println!("                     {}", e.name);
            }
            println!("  state region       {} bytes at offset {}", c.state_layout.len, c.state_layout.start);

            /* Which arguments the SIZE depends on.
               A size figure for a covenant is meaningless without the
               constructor that produced it: an integer used as a loop bound
               unrolls, and doubling it can double the script. Rather than
               assert that in prose, double each integer in turn and report
               what moved. */
            println!("\n  SIZE DEPENDS ON");
            let mut movers = 0;
            for (i, p) in ast.params.iter().enumerate() {
                if !matches!(p.type_ref.base, TypeBase::Int | TypeBase::Temporal) || !p.type_ref.array_dims.is_empty() {
                    continue;
                }
                let mut probe = args.clone();
                probe[i] = Expr::int(BASE_INT * 2);
                if let Ok(c2) = compile_contract(source, &probe, CompileOptions::default()) {
                    let d = c2.bytecode.len() as i64 - n as i64;
                    if d != 0 {
                        movers += 1;
                        println!("    {:<24} {} → {}: {:+} bytes", p.name, BASE_INT, BASE_INT * 2, d);
                    }
                }
            }
            if movers == 0 {
                println!("    nothing — the script is the same size at every integer this pass tried.");
            } else {
                println!("    A size or headroom figure quoted without its constructor is not a");
                println!("    figure about this covenant. Ask what {} set to.",
                    if movers == 1 { "that argument was" } else { "those arguments were" });
            }
        }
        Err(e) => {
            println!("  refused a synthesised constructor — {e:?}");
            println!("  That is not a finding. Placeholder integers are 1000 and placeholder keys");
            println!("  are 0x11s; a covenant that checks its own arguments will reject them.");
        }
    }

    println!("\n{}", "─".repeat(60));
    println!("{total} conditions is the size of this covenant's refusal surface. If the");
    println!("documentation somebody hands you with it names fewer, the difference is what");
    println!("nobody has written down — not necessarily a defect, and not necessarily not.");
    println!();
    println!("What this pass CANNOT tell you: whether those {total} conditions are the right");
    println!("ones, and whether each is where its author thinks it is. Both need a");
    println!("transaction the engine will accept, and that needs a builder for this");
    println!("covenant's entrypoints — see PORTING.md. Compute budget and peak stack are");
    println!("in the same position: they are measured from an execution, not from source.");
}
