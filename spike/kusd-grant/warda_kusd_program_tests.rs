//! Spike: can a Warda grant hold a KCC20 dollar (KUSD stand-in) instead of KAS,
//! with every limit enforced in dollars by the Kaspa script engine?
//!
//! Every transaction below is run through the same `TxScriptEngine` a Kaspa
//! node validates with, input by input. A transaction is accepted only if
//! EVERY input accepts.
//!
//! Units: token amounts are cents. 5000 = $50.00.

use kaspa_consensus_core::Hash;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::hashing::sighash::calc_schnorr_signature_hash;
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::tx::{
    MutableTransaction, Transaction, TransactionId, TransactionInput, TransactionOutpoint, UtxoEntry,
};
use kaspa_txscript::pay_to_script_hash_script;
use rand::{RngCore, thread_rng};
use secp256k1::{Keypair, Secp256k1, SecretKey};
use silverscript_abi::{ArtifactValue, SilAbiArtifact};
use silverscript_lang::compiler::{CompileOptions, compile_to_sil_abi_artifact_with_options};
use std::collections::BTreeMap;
use std::fs;

mod common;
use common::{COV_A, bytecode, compiled_template_parts_and_hash, covenant_decl_sigscript, execute_input_with_covenants};
use kaspa_consensus_core::tx::{CovenantBinding, TransactionOutput};

const COIN: u64 = 1_500; // KAS (sompi) every covenant coin carries in these tests

fn covenant_output(a: &SilAbiArtifact, auth: u16, cov: Hash) -> TransactionOutput {
    out_valued(a, auth, cov, COIN)
}
fn out_valued(a: &SilAbiArtifact, auth: u16, cov: Hash, value: u64) -> TransactionOutput {
    TransactionOutput { value, script_public_key: pay_to_script_hash_script(&bytecode(a)), covenant: Some(CovenantBinding { authorizing_input: auth, covenant_id: cov }) }
}

const ID_PUBKEY: u8 = 0x00;
const ID_COVENANT: u8 = 0x02;
const TOKEN: Hash = COV_A; // the KUSD stand-in's covenant id
const GRANT: Hash = Hash::from_bytes(*b"WARDAGRANTWARDAGRANTWARDAGRANTWA");

const CAP: i64 = 500; // $5.00 per payment
const BUDGET: i64 = 1_200; // $12.00 over the grant's life
const FUNDED: i64 = 5_000; // $50.00 held

fn src(name: &str) -> String {
    fs::read_to_string(format!("{}/tests/examples/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn key() -> Keypair {
    let secp = Secp256k1::new();
    let mut b = [0u8; 32];
    loop {
        thread_rng().fill_bytes(&mut b);
        if let Ok(sk) = SecretKey::from_slice(&b) {
            return Keypair::from_secret_key(&secp, &sk);
        }
    }
}
fn pk(k: &Keypair) -> Vec<u8> {
    k.x_only_public_key().0.serialize().to_vec()
}

fn sign(tx: &Transaction, entries: &[UtxoEntry], idx: usize, k: &Keypair) -> Vec<u8> {
    let tx = MutableTransaction::with_entries(tx.clone(), entries.to_vec());
    let rv = SigHashReusedValuesUnsync::new();
    let h = calc_schnorr_signature_hash(&tx.as_verifiable(), idx, SIG_HASH_ALL, &rv);
    let msg = secp256k1::Message::from_digest_slice(h.as_bytes().as_slice()).unwrap();
    let mut s = k.sign_schnorr(msg).as_ref().to_vec();
    s.push(SIG_HASH_ALL.to_u8());
    s
}

fn input(n: u8, sigscript: Vec<u8>) -> TransactionInput {
    TransactionInput::new_with_compute_budget(TransactionOutpoint { transaction_id: TransactionId::from_bytes([n; 32]), index: 0 }, sigscript, 0, 0)
}

#[derive(Clone)]
struct Tok {
    owner: Vec<u8>,
    kind: u8,
    amount: i64,
}
fn tok(owner: &[u8], kind: u8, amount: i64) -> Tok {
    Tok { owner: owner.to_vec(), kind, amount }
}
fn tok_arg(t: &Tok) -> ArtifactValue {
    BTreeMap::from([
        ("ownerIdentifier".to_string(), t.owner.clone().into()),
        ("identifierType".to_string(), t.kind.into()),
        ("amount".to_string(), t.amount.into()),
        ("isMinter".to_string(), false.into()),
    ])
    .into()
}
fn toks_arg(ts: &[Tok]) -> ArtifactValue {
    ArtifactValue::Array(ts.iter().map(tok_arg).collect())
}

struct World {
    kcc20: String,
    grant: String,
    agent: Keypair,
    revoker: Keypair,
    principal: Keypair,
    payee: Keypair,
    attacker: Keypair,
    tpl: (Vec<u8>, Vec<u8>, Vec<u8>),
}

impl World {
    fn new() -> Self {
        let kcc20 = src("kusd-kcc20.sil");
        let probe = compile_to_sil_abi_artifact_with_options(
            &kcc20,
            &[
                ArtifactValue::Bytes(vec![0; 32]),
                ArtifactValue::Int(0),
                ArtifactValue::Byte(ID_COVENANT),
                ArtifactValue::Bool(false),
                ArtifactValue::Int(8),
                ArtifactValue::Int(8),
            ],
            CompileOptions::default(),
        )
        .unwrap();
        World {
            tpl: compiled_template_parts_and_hash(&probe),
            kcc20,
            grant: src("warda-dollar-grant.sil"),
            agent: key(),
            revoker: key(),
            principal: key(),
            payee: key(),
            attacker: key(),
        }
    }

    fn token(&self, t: &Tok) -> SilAbiArtifact {
        compile_to_sil_abi_artifact_with_options(
            &self.kcc20,
            &[
                ArtifactValue::Bytes(t.owner.clone()),
                ArtifactValue::Int(t.amount),
                ArtifactValue::Byte(t.kind),
                ArtifactValue::Bool(false),
                ArtifactValue::Int(8),
                ArtifactValue::Int(8),
            ],
            CompileOptions::default(),
        )
        .expect("kcc20 compiles")
    }

    fn grant(&self, spent: i64) -> SilAbiArtifact {
        compile_to_sil_abi_artifact_with_options(
            &self.grant,
            &[
                ArtifactValue::Bytes(pk(&self.agent)),
                ArtifactValue::Bytes(pk(&self.revoker)),
                ArtifactValue::Bytes(pk(&self.principal)),
                ArtifactValue::Bytes(pk(&self.payee)),
                ArtifactValue::Int(CAP),
                ArtifactValue::Int(BUDGET),
                ArtifactValue::Bytes(TOKEN.as_bytes().to_vec()),
                ArtifactValue::Int(spent),
                ArtifactValue::Int(self.tpl.0.len() as i64),
                ArtifactValue::Int(self.tpl.1.len() as i64),
                ArtifactValue::Bytes(self.tpl.2.clone()),
            ],
            CompileOptions::default(),
        )
        .expect("grant compiles")
    }

    fn grant_state(&self, spent: i64) -> ArtifactValue {
        BTreeMap::from([
            ("tokenCovid".to_string(), TOKEN.as_bytes().to_vec().into()),
            ("spent".to_string(), spent.into()),
        ])
        .into()
    }
}

/// Outcome per input, plus the whole-transaction verdict.
struct Verdict {
    inputs: Vec<(&'static str, Result<(), String>)>,
}
impl Verdict {
    fn accepted(&self) -> bool {
        self.inputs.iter().all(|(_, r)| r.is_ok())
    }
    fn why(&self) -> String {
        self.inputs
            .iter()
            .map(|(n, r)| format!("{n}: {}", match r {
                Ok(()) => "ok".to_string(),
                Err(e) => e.clone(),
            }))
            .collect::<Vec<_>>()
            .join(" | ")
    }
}

fn run(tx: &Transaction, entries: &[UtxoEntry], names: &[&'static str]) -> Verdict {
    Verdict {
        inputs: (0..tx.inputs.len())
            .map(|i| (names[i], execute_input_with_covenants(tx.clone(), entries.to_vec(), i).map_err(|e| format!("{e:?}"))))
            .collect(),
    }
}

/// A payment attempt. `claimed_*` is what the grant is told; `actual_*` is what
/// the outputs really contain. Honest transactions have them equal.
struct Pay<'a> {
    spent_before: i64,
    held: i64,
    claimed_pay: Tok,
    actual_pay: Tok,
    change: Tok,
    signer: &'a Keypair,
    new_spent: i64,
    with_grant_input: bool,
    change_value: u64,
    grant_next_value: u64,
}

fn pay(w: &World, p: Pay) -> Verdict {
    let gid = GRANT.as_bytes().to_vec();
    let held = w.token(&tok(&gid, ID_COVENANT, p.held));
    let grant_prev = w.grant(p.spent_before);
    let grant_next = w.grant(p.new_spent);

    let outputs = vec![
        covenant_output(&w.token(&p.actual_pay), 0, TOKEN),
        out_valued(&w.token(&p.change), 0, TOKEN, p.change_value),
    ];
    let mut outputs_all = outputs.clone();
    let mut entries = vec![UtxoEntry::new(1_500, pay_to_script_hash_script(&bytecode(&held)), 0, false, Some(TOKEN))];
    if p.with_grant_input {
        outputs_all.push(out_valued(&grant_next, 1, GRANT, p.grant_next_value));
        entries.push(UtxoEntry::new(1_500, pay_to_script_hash_script(&bytecode(&grant_prev)), 0, false, Some(GRANT)));
    }

    let token_ss = covenant_decl_sigscript(
        &held,
        "transferPolicy",
        vec![toks_arg(&[p.actual_pay.clone(), p.change.clone()]), ArtifactValue::Bytes(vec![0; 65]), ArtifactValue::Byte(0)],
        true,
    );
    let mut inputs = vec![input(1, vec![])];
    if p.with_grant_input {
        inputs.push(input(2, vec![]));
    }
    let unsigned = Transaction::new(1, inputs.clone(), outputs_all.clone(), 0, Default::default(), 0, vec![]);

    inputs[0] = input(1, token_ss);
    let mut names = vec!["token"];
    if p.with_grant_input {
        let sig = sign(&unsigned, &entries, 1, p.signer);
        let grant_ss = covenant_decl_sigscript(
            &grant_prev,
            "pay",
            vec![w.grant_state(p.new_spent), ArtifactValue::Bytes(sig), tok_arg(&p.claimed_pay), tok_arg(&p.change)],
            true,
        );
        inputs[1] = input(2, grant_ss);
        names.push("grant");
    }
    let tx = Transaction::new(1, inputs, outputs_all, 0, Default::default(), 0, vec![]);
    run(&tx, &entries, &names)
}

fn revoke(w: &World, spent_before: i64, held_amt: i64, back_to: &[u8], signer: &Keypair) -> Verdict {
    let gid = GRANT.as_bytes().to_vec();
    let held = w.token(&tok(&gid, ID_COVENANT, held_amt));
    let back = tok(back_to, ID_PUBKEY, held_amt);
    let grant_prev = w.grant(spent_before);
    let grant_dead = w.grant(BUDGET);
    let outputs = vec![covenant_output(&w.token(&back), 0, TOKEN), covenant_output(&grant_dead, 1, GRANT)];
    let entries = vec![
        UtxoEntry::new(1_500, pay_to_script_hash_script(&bytecode(&held)), 0, false, Some(TOKEN)),
        UtxoEntry::new(1_500, pay_to_script_hash_script(&bytecode(&grant_prev)), 0, false, Some(GRANT)),
    ];
    let unsigned = Transaction::new(1, vec![input(1, vec![]), input(2, vec![])], outputs.clone(), 0, Default::default(), 0, vec![]);
    let sig = sign(&unsigned, &entries, 1, signer);
    let token_ss = covenant_decl_sigscript(
        &held,
        "transferPolicy",
        vec![toks_arg(&[back.clone()]), ArtifactValue::Bytes(vec![0; 65]), ArtifactValue::Byte(0)],
        true,
    );
    let grant_ss = covenant_decl_sigscript(
        &grant_prev,
        "revoke",
        vec![w.grant_state(BUDGET), ArtifactValue::Bytes(sig), tok_arg(&back)],
        true,
    );
    let tx = Transaction::new(1, vec![input(1, token_ss), input(2, grant_ss)], outputs, 0, Default::default(), 0, vec![]);
    run(&tx, &entries, &["token", "grant"])
}

fn honest<'a>(w: &'a World, spent: i64, held: i64, amount: i64) -> Pay<'a> {
    let gid = GRANT.as_bytes().to_vec();
    let p = tok(&pk(&w.payee), ID_PUBKEY, amount);
    Pay {
        spent_before: spent,
        held,
        claimed_pay: p.clone(),
        actual_pay: p,
        change: tok(&gid, ID_COVENANT, held - amount),
        signer: &w.agent,
        new_spent: spent + amount,
        with_grant_input: true,
        change_value: COIN,
        grant_next_value: COIN,
    }
}

#[test]
fn warda_grant_holding_real_kusd_program() {
    let w = World::new();
    let gid = GRANT.as_bytes().to_vec();
    let mut rows: Vec<(String, bool, bool, String)> = vec![];
    let mut check = |label: &str, expect: bool, v: Verdict| {
        rows.push((label.to_string(), expect, v.accepted(), v.why()));
    };

    // ---- honest path: the grant's budget, caps and change are all in dollars
    check("1. pay $5.00 to the allowed payee (spent 0 -> 5)", true, pay(&w, honest(&w, 0, FUNDED, 500)));
    check("2. pay again from the SUCCESSOR coin (covenant id stable)", true, pay(&w, honest(&w, 500, FUNDED - 500, 500)));
    check("3. pay $2.00 — brings spent to $12.00 = budget", true, pay(&w, honest(&w, 1_000, FUNDED - 1_000, 200)));

    // ---- limits
    check("4. pay $5.01 — over the $5 per-payment cap", false, pay(&w, honest(&w, 0, FUNDED, 501)));
    check("5. pay $5.00 when $10 already spent — over $12 budget", false, pay(&w, honest(&w, 1_000, FUNDED - 1_000, 500)));

    // ---- payee and change
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.claimed_pay = tok(&pk(&w.attacker), ID_PUBKEY, 500);
        p.actual_pay = p.claimed_pay.clone();
        check("6. pay $5.00 to an address not on the allowlist", false, pay(&w, p));
    }
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.change = tok(&pk(&w.agent), ID_PUBKEY, FUNDED - 500);
        check("7. pay $5 correctly but take the $45 change to the agent's key", false, pay(&w, p));
    }
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.actual_pay = tok(&pk(&w.payee), ID_PUBKEY, 600);
        p.change = tok(&gid, ID_COVENANT, FUNDED - 600);
        check("8. tell the grant $5.00, put $6.00 in the real output", false, pay(&w, p));
    }
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.new_spent = 0;
        check("9. pay $5 but claim the running total did not move", false, pay(&w, p));
    }

    // ---- who may move it
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.signer = &w.attacker;
        check("10. a stranger signs the payment", false, pay(&w, p));
    }
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.with_grant_input = false;
        check("11. move the dollars WITHOUT the grant in the transaction", false, pay(&w, p));
    }
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.actual_pay = tok(&pk(&w.attacker), ID_PUBKEY, FUNDED);
        p.change = tok(&gid, ID_COVENANT, 0);
        p.with_grant_input = false;
        check("12. drain all $50 to a stranger with no grant input", false, pay(&w, p));
    }

    // ---- the KAS the coins carry
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.change_value = COIN - 500;
        check("16. pay honestly but skim KAS off the held token coin", false, pay(&w, p));
    }
    {
        let mut p = honest(&w, 0, FUNDED, 500);
        p.grant_next_value = COIN - 500;
        check("17. pay honestly but skim KAS off the grant coin", false, pay(&w, p));
    }

    // ---- revocation
    check("13. revoker ends the grant, all $45 back to principal", true, revoke(&w, 500, FUNDED - 500, &pk(&w.principal), &w.revoker));
    check("14. agent tries to 'revoke' to itself", false, revoke(&w, 500, FUNDED - 500, &pk(&w.agent), &w.agent));
    check("15. revoker signs but sends the $45 to itself", false, revoke(&w, 500, FUNDED - 500, &pk(&w.revoker), &w.revoker));

    println!("\n{:<66} {:>8} {:>8}", "scenario", "expected", "engine");
    let mut bad = 0;
    for (label, expect, got, why) in &rows {
        let e = if *expect { "accept" } else { "refuse" };
        let g = if *got { "accept" } else { "refuse" };
        let mark = if expect == got { "" } else { "   <-- MISMATCH" };
        if expect != got {
            bad += 1;
        }
        println!("{label:<66} {e:>8} {g:>8}{mark}");
        if !*got || expect != got {
            println!("      {why}");
        }
    }
    println!();
    assert_eq!(bad, 0, "{bad} scenario(s) did not match");
}
