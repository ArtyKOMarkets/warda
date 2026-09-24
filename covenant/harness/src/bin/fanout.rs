//! `fanout` — does the ENGINE accept a 1:N covenant spend?
//!
//!     cargo run --release --bin fanout --manifest-path covenant/harness/Cargo.toml
//!
//! `covenant/probes/run-fanout.sh` established that `#[covenant.fanout(to =
//! N)]` COMPILES above 2, and that the script grows linearly. That is a fact
//! about the compiler and says nothing about the chain: the compiler emits a
//! script, and whether rusty-kaspa's covenant machinery will authorise N
//! outputs from one input is a separate question that only an execution can
//! answer. `scan` says as much about itself — compute and peak stack are
//! measured from an execution, not from source.
//!
//! So this runs the same probe contract through `TxScriptEngine`, the engine
//! the network runs, at several values of N. It reports the verdict and the
//! script units consumed.
//!
//! It is deliberately NOT a model of delegation. The probe checks one field
//! per child and nothing else, so what it measures is the cost of the fanout
//! itself rather than the cost of Warda's conservation rules — which do not
//! exist yet at N > 1 and are C1's actual work. A number from here is a floor,
//! not an estimate of what v5 will use.
use kaspa_consensus_core::tx::{CovenantBinding, Transaction, TransactionOutput};
use kaspa_txscript::pay_to_script_hash_script;
use silverscript_lang::ast::{ArrayDim, Expr, TypeBase, TypeRef};
use silverscript_lang::compiler::struct_object;
use warda_harness::{
    agent_keypair, compiled, covenant_utxo, measure_units, sign_input, sigscript, tx_input, COV,
};

/// The same template `run-fanout.sh` materialises, so the compiler probe and
/// the engine probe cannot drift into testing two different contracts.
const TMPL: &str = include_str!("../../../probes/fanout.sil.tmpl");

/// Leaked on purpose: `compiled` caches by source pointer and wants 'static,
/// and this runs a handful of values once. A leak per N in a program that
/// exits is not a leak worth a lifetime parameter.
fn source(n: usize) -> &'static str {
    let children: String = (0..n)
        .map(|i| format!("        require(newStates[{i}].counter == counter + 1);\n"))
        .collect();
    let s = TMPL
        .replace("__CHILDREN__", children.trim_end())
        .replace("__N__", &n.to_string());
    Box::leak(s.into_boxed_str())
}

fn state(counter: i64) -> Expr<'static> {
    struct_object("State", vec![("counter", Expr::int(counter))])
}

fn main() {
    let kp = agent_keypair();
    let owner = kp.x_only_public_key().0.serialize().to_vec();

    println!("{:>4}  {:>7}  {:>8}  {}", "to", "bytes", "units", "engine");
    for n in [2usize, 3, 4, 5, 8] {
        let src = source(n);
        // The successor's state is baked into its script, so the parent and
        // the child are the same contract at different counters — which is
        // what makes this a covenant rather than a payment.
        let parent = compiled(src, &[Expr::bytes(owner.clone()), Expr::int(0)]);
        let next = compiled(src, &[Expr::bytes(owner.clone()), Expr::int(1)]);

        let new_states = Expr::array(
            TypeRef { base: TypeBase::Custom("State".to_string()), array_dims: vec![ArrayDim::Dynamic] },
            (0..n).map(|_| state(1)).collect::<Vec<_>>(),
        );

        let in_value: u64 = 10_000_000_000;
        let each = in_value / n as u64 - 1_000;
        let build = |sig: Vec<u8>| {
            Transaction::new(
                1,
                vec![tx_input(0, sigscript(parent, "split", vec![new_states.clone(), Expr::bytes(sig)]))],
                (0..n)
                    .map(|_| TransactionOutput {
                        value: each,
                        script_public_key: pay_to_script_hash_script(&next.bytecode),
                        covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: COV }),
                    })
                    .collect::<Vec<_>>(),
                0,
                Default::default(),
                0,
                vec![],
            )
        };

        let entries = vec![covenant_utxo(parent, in_value)];
        let sig = sign_input(build(vec![0u8; 65]), entries.clone(), 0, &kp);
        let (verdict, units) = measure_units(build(sig), entries, 0);
        println!(
            "{:>4}  {:>7}  {:>8}  {}",
            n,
            parent.bytecode.len(),
            units,
            match &verdict {
                Ok(()) => "ACCEPTED".to_string(),
                Err(e) => format!("refused — {e}"),
            }
        );
    }

    println!();
    println!("`to = 2` is the control: it is the shape the shipped covenant uses, so a");
    println!("refusal there means this probe is wrong rather than the engine. Units here");
    println!("exclude the signature charge (sigop_script_units: 0), the same way");
    println!("LIMITS.md's bare figures do — add ~100,000 for the real budget.");
}
