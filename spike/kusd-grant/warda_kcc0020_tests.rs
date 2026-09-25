//! The SAME grant, against the DRAFT KCC-0020 state layout — and the test
//! that matters, which is that a grant built for one layout REFUSES a token of
//! the other rather than misreading it.
//!
//! ## Why there are two layouts at all
//!
//! silverscript's example — which KUSD ships — and the draft KCC-0020 disagree
//! about the token's state:
//!
//!   silverscript / KUSD             draft KCC-0020
//!   ownerIdentifier byte[32]        amount              int
//!   identifierType  byte            owner               byte[32]
//!   amount          int             ownerScheme         byte
//!   isMinter        bool            borrowScheme        byte
//!                                   borrowGuard         byte[32]
//!                                   extensionCommitment byte[32]
//!
//!   0x02 = COVENANT ID              0x02 = p2pkh-ecdsa
//!                                   0x04 = COVENANT ID
//!
//! The third line is the one to be frightened of. 0x02 is valid in both and
//! means different things — "owned by a covenant" against "owned by an ECDSA
//! key hash" — so a reader holding one table cannot tell it is looking at the
//! wrong one. Nothing about the byte announces which family it came from.
//!
//! ## What makes a grant asset-agnostic, and what does not
//!
//! Not the scheme byte: it belongs to the layout, and the layout is a
//! compile-time type. Making it a constructor parameter would add a way to be
//! wrong without adding a capability — a grant compiled for the draft layout
//! and handed 0x02 would be asking about an ECDSA key hash while believing it
//! asked about a covenant.
//!
//! What makes it agnostic is that the token PROGRAM is a parameter:
//! templatePrefixLen, templateSuffixLen, expectedTemplateHash. The grant reads
//! the held coin through that template, so it holds any token of its layout
//! and refuses one of the other — which is `cross_family_token_is_refused`
//! below, with `cross_family_control` beside it so the refusal means
//! something.

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

const ID_PUBKEY: u8 = 0x00;   // p2pk-schnorr/v1
const ID_COVENANT: u8 = 0x04; // covenant-id/v1
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
        ("amount".to_string(), t.amount.into()),
        ("owner".to_string(), t.owner.clone().into()),
        ("ownerScheme".to_string(), t.kind.into()),
        ("borrowScheme".to_string(), 0u8.into()),
        ("borrowGuard".to_string(), vec![0u8; 32].into()),
        ("extensionCommitment".to_string(), vec![0u8; 32].into()),
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
        let kcc20 = src("kcc0020-token.sil");
        let probe = compile_to_sil_abi_artifact_with_options(
            &kcc20,
            &[
                ArtifactValue::Int(0),
                ArtifactValue::Bytes(vec![0; 32]),
                ArtifactValue::Byte(ID_COVENANT),
                ArtifactValue::Byte(0),
                ArtifactValue::Bytes(vec![0; 32]),
                ArtifactValue::Bytes(vec![0; 32]),
                ArtifactValue::Int(8),
                ArtifactValue::Int(8),
            ],
            CompileOptions::default(),
        )
        .unwrap();
        World {
            tpl: compiled_template_parts_and_hash(&probe),
            kcc20,
            grant: src("warda-dollar-grant-0020.sil"),
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
                ArtifactValue::Int(t.amount),
                ArtifactValue::Bytes(t.owner.clone()),
                ArtifactValue::Byte(t.kind),
                ArtifactValue::Byte(0),
                ArtifactValue::Bytes(vec![0; 32]),
                ArtifactValue::Bytes(vec![0; 32]),
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
fn warda_grant_on_the_draft_kcc0020_layout() {
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


/* ---------------------------------------------------------------------------
   The cross-family tests.

   Everything above shows the grant working against its OWN layout, which is
   the easy half. The question this spike exists to answer is what happens when
   a grant meets a token of the other family — because nothing in a coin
   announces which state layout it was compiled from, and the two families
   share the byte 0x02 with different meanings.

   The token program says YES: its own rules are satisfied — the owner covenant
   takes part and the amounts conserve. The GRANT must say no. If it did not,
   it would be reading `amount` out of the bytes where the other family keeps
   an owner key, and paying out a number nobody chose.

   The control matters as much as the test. A grant that refused everything
   would pass `cross_family_token_is_refused` and be useless, so
   `cross_family_control` builds the identical transaction with a token of the
   grant's own family and requires it ACCEPTED. One field apart, opposite
   verdicts.
   --------------------------------------------------------------------------- */

/// The other family's state, in the other family's order.
fn tok_arg_silverscript(t: &Tok) -> ArtifactValue {
    BTreeMap::from([
        ("ownerIdentifier".to_string(), t.owner.clone().into()),
        ("identifierType".to_string(), t.kind.into()),
        ("amount".to_string(), t.amount.into()),
        ("isMinter".to_string(), false.into()),
    ])
    .into()
}

/// A token compiled from the layout KUSD ships, owned by a covenant — which in
/// THAT table is 0x02.
fn silverscript_token(owner: &[u8], kind: u8, amount: i64) -> SilAbiArtifact {
    compile_to_sil_abi_artifact_with_options(
        &src("kusd-kcc20.sil"),
        &[
            ArtifactValue::Bytes(owner.to_vec()),
            ArtifactValue::Int(amount),
            ArtifactValue::Byte(kind),
            ArtifactValue::Bool(false),
            ArtifactValue::Int(8),
            ArtifactValue::Int(8),
        ],
        CompileOptions::default(),
    )
    .expect("the other family's token compiles")
}

/// Build the honest payment with the WHOLE token family from one layout or the
/// other, and the grant always on the draft layout.
///
/// The first version of this only swapped the HELD coin and left the payment
/// and change outputs on the draft layout — so the token program refused its
/// own transaction (its outputs were a different program) and the test passed
/// with the token and the grant both erroring. Green, and proving nothing: a
/// refusal by the wrong input is the same mistake as a refusal for the wrong
/// reason, which is what this whole repository keeps finding.
///
/// A fair cross-family transaction is self-consistent on the token side. Then
/// the token program has no complaint, and whatever happens is the grant's
/// answer to a coin of a layout it was not built for.
fn cross_family_pay(own_family: bool) -> Verdict {
    let w = World::new();
    let gid = GRANT.as_bytes().to_vec();
    let pay_t = tok(&pk(&w.payee), ID_PUBKEY, 500);
    let change_t = tok(&gid, ID_COVENANT, FUNDED - 500);
    // The other family's table: covenant-id is 0x02 there, 0x04 here.
    let pay_o = tok(&pk(&w.payee), 0x00, 500);
    let change_o = tok(&gid, 0x02, FUNDED - 500);

    let (held, out_pay, out_change, token_args) = if own_family {
        (
            w.token(&tok(&gid, ID_COVENANT, FUNDED)),
            w.token(&pay_t),
            w.token(&change_t),
            toks_arg(&[pay_t.clone(), change_t.clone()]),
        )
    } else {
        (
            silverscript_token(&gid, 0x02, FUNDED),
            silverscript_token(&pk(&w.payee), 0x00, 500),
            silverscript_token(&gid, 0x02, FUNDED - 500),
            ArtifactValue::Array(vec![tok_arg_silverscript(&pay_o), tok_arg_silverscript(&change_o)]),
        )
    };

    let grant_prev = w.grant(0);
    let grant_next = w.grant(500);
    let outputs = vec![
        covenant_output(&out_pay, 0, TOKEN),
        out_valued(&out_change, 0, TOKEN, 1_500),
        out_valued(&grant_next, 1, GRANT, 1_500),
    ];
    let entries = vec![
        UtxoEntry::new(1_500, pay_to_script_hash_script(&bytecode(&held)), 0, false, Some(TOKEN)),
        UtxoEntry::new(1_500, pay_to_script_hash_script(&bytecode(&grant_prev)), 0, false, Some(GRANT)),
    ];
    let unsigned = Transaction::new(1, vec![input(1, vec![]), input(2, vec![])], outputs.clone(), 0, Default::default(), 0, vec![]);
    let sig = sign(&unsigned, &entries, 1, &w.agent);

    let token_ss = covenant_decl_sigscript(
        &held,
        "transferPolicy",
        vec![token_args, ArtifactValue::Bytes(vec![0; 65]), ArtifactValue::Byte(0)],
        true,
    );
    /* The grant is told the draft-shaped state either way. That is not a
       cheat, it is the situation: the grant only knows its own layout, and
       what it is handed on chain is bytes. */
    let grant_ss = covenant_decl_sigscript(
        &grant_prev,
        "pay",
        vec![w.grant_state(500), ArtifactValue::Bytes(sig), tok_arg(&pay_t), tok_arg(&change_t)],
        true,
    );
    let tx = Transaction::new(1, vec![input(1, token_ss), input(2, grant_ss)], outputs, 0, Default::default(), 0, vec![]);
    run(&tx, &entries, &["token", "grant"])
}

#[test]
fn cross_family_control() {
    let v = cross_family_pay(true);
    assert!(v.accepted(), "the control must be accepted, or the refusal below proves nothing: {}", v.why());
}

#[test]
fn cross_family_token_is_refused() {
    let v = cross_family_pay(false);
    assert!(
        !v.accepted(),
        "a grant built for the draft layout ACCEPTED a token of the other family. \
         It is reading `amount` out of bytes the other family uses for an owner key: {}",
        v.why()
    );
    /* By the GRANT, and the token must be SATISFIED — otherwise the refusal
       came from the token complaining about its own transaction and says
       nothing about whether a grant can be fooled by another layout. */
    let token = v.inputs.iter().find(|(n, _)| *n == "token").expect("a token input");
    assert!(token.1.is_ok(), "the token program must accept its own transaction, or this proves nothing: {}", v.why());
    let grant = v.inputs.iter().find(|(n, _)| *n == "grant").expect("a grant input");
    assert!(grant.1.is_err(), "the grant input must be the one that refuses: {}", v.why());
    println!("cross-family: {}", v.why());
}


/* Which check actually refuses the other family?
 *
 * The cross-family refusal arrives as InvalidIndex, not VerifyError — an
 * out-of-range read rather than a rule saying no. That is SAFE (an invalid
 * transaction cannot be mined) and it is not the same as being DETECTED, and
 * the difference matters: a layout whose template happened to have compatible
 * lengths might get past the arithmetic and be read as a number nobody chose.
 *
 * So: does the template HASH bind at all on this path? Same transaction, same
 * family, same lengths — only the expected hash corrupted. If that refuses
 * with VerifyError then the hash is checked once the read is in range, and the
 * cross-family case simply fails earlier, on the lengths.
 */
#[test]
fn wrong_template_hash_is_refused() {
    let w = World::new();
    let gid = GRANT.as_bytes().to_vec();
    let pay_t = tok(&pk(&w.payee), ID_PUBKEY, 500);
    let change_t = tok(&gid, ID_COVENANT, FUNDED - 500);
    let held = w.token(&tok(&gid, ID_COVENANT, FUNDED));

    let mut wrong = w.tpl.2.clone();
    wrong[0] ^= 0xff; // one bit of the template hash, nothing else
    let grant_prev = compile_to_sil_abi_artifact_with_options(
        &w.grant,
        &[
            ArtifactValue::Bytes(pk(&w.agent)),
            ArtifactValue::Bytes(pk(&w.revoker)),
            ArtifactValue::Bytes(pk(&w.principal)),
            ArtifactValue::Bytes(pk(&w.payee)),
            ArtifactValue::Int(CAP),
            ArtifactValue::Int(BUDGET),
            ArtifactValue::Bytes(TOKEN.as_bytes().to_vec()),
            ArtifactValue::Int(0),
            ArtifactValue::Int(w.tpl.0.len() as i64),
            ArtifactValue::Int(w.tpl.1.len() as i64),
            ArtifactValue::Bytes(wrong),
        ],
        CompileOptions::default(),
    )
    .expect("grant compiles with a wrong hash");
    let grant_next = w.grant(500);

    let outputs = vec![
        covenant_output(&w.token(&pay_t), 0, TOKEN),
        out_valued(&w.token(&change_t), 0, TOKEN, 1_500),
        out_valued(&grant_next, 1, GRANT, 1_500),
    ];
    let entries = vec![
        UtxoEntry::new(1_500, pay_to_script_hash_script(&bytecode(&held)), 0, false, Some(TOKEN)),
        UtxoEntry::new(1_500, pay_to_script_hash_script(&bytecode(&grant_prev)), 0, false, Some(GRANT)),
    ];
    let unsigned = Transaction::new(1, vec![input(1, vec![]), input(2, vec![])], outputs.clone(), 0, Default::default(), 0, vec![]);
    let sig = sign(&unsigned, &entries, 1, &w.agent);
    let token_ss = covenant_decl_sigscript(
        &held,
        "transferPolicy",
        vec![toks_arg(&[pay_t.clone(), change_t.clone()]), ArtifactValue::Bytes(vec![0; 65]), ArtifactValue::Byte(0)],
        true,
    );
    let grant_ss = covenant_decl_sigscript(
        &grant_prev,
        "pay",
        vec![w.grant_state(500), ArtifactValue::Bytes(sig), tok_arg(&pay_t), tok_arg(&change_t)],
        true,
    );
    let tx = Transaction::new(1, vec![input(1, token_ss), input(2, grant_ss)], outputs, 0, Default::default(), 0, vec![]);
    let v = run(&tx, &entries, &["token", "grant"]);
    println!("wrong template hash: {}", v.why());
    assert!(!v.accepted(), "a corrupted template hash was accepted: {}", v.why());
    let token = v.inputs.iter().find(|(n, _)| *n == "token").expect("token");
    assert!(token.1.is_ok(), "the token must be satisfied here: {}", v.why());
}
