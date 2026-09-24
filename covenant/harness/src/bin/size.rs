//! How much a deeper allowlist costs, measured rather than quoted.
//!
//! `README.md` said "+568 bytes per doubling", which is true only of the
//! doubling it was measured at. The cost is linear in `maxProofDepth` -- 142
//! bytes a level -- so 4 -> 8 is +568 and 8 -> 16 is +1,136, and reasoning
//! "one more doubling" understates depth 16 by half. That matters exactly
//! where the question gets asked: how much does room for more payees cost?
//!
//!   cargo run --release --bin size
//!
//! These are this contract's compiled bytes at the harness's own constructor
//! values. They are not the deployed script's size -- `maxFee` and the
//! template geometry move that -- so use the deltas, not the absolutes.
fn main() {
    println!("{:>5}  {:>7}  {:>7}  {:>12}", "depth", "bytes", "delta", "payees");
    let mut prev: Option<usize> = None;
    for d in [4i64, 5, 6, 8, 12, 16, 24, 32] {
        let n = warda_harness::compile(d).bytecode.len();
        let delta = prev.map(|p| n as i64 - p as i64).unwrap_or(0);
        println!("{:>5}  {:>7}  {:>7}  {:>12}", d, n, delta, 1u64 << d);
        prev = Some(n);
    }
}
