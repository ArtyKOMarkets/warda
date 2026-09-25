//! kusd-grant-onchain — put the Warda dollar grant spike on testnet-10.
//!
//! A KCC20 token compiled from KUSD's own `kcc20.sil` (so the program is
//! byte-for-byte KUSD's, only the asset is ours), a Warda dollar grant that
//! OWNS a coin of it by covenant ID, and the full lifecycle:
//!
//!   1 token-genesis   mint $50 of our test dollar to the funder
//!   2 grant-genesis   create the grant (cap $5, budget $12)
//!   3 fund            move the $50 under the grant; give the agent KAS for fees
//!   4 pay             $5 to the payee
//!   5 pay             $5 again, from the successor coins
//!   6 attacks         three refusals, SUBMITTED to the node so its own
//!                     rejection is on record: over cap, over budget, and
//!                     moving the dollars without the grant
//!   7 pay             $2 — spends exactly the $12 budget
//!   8 revoke          the revoker sends the remaining $38 to the principal
//!
//! Every transaction is run through the script engine BEFORE it is submitted,
//! with real signature costs, and its compute budget is set from what the
//! engine measured. Masses and fees are recorded per step in onchain-log.json.
//!
//! Usage (from this directory, with the node on localhost):
//!   cargo run --release -- keys      create keys.json, print the funding address
//!   cargo run --release -- simulate  the whole lifecycle through the engine, no node
//!   cargo run --release -- run       do (or resume) every step on testnet-10
//!   cargo run --release -- status    show state.json
//! Env: KASPA_WRPC (default ws://127.0.0.1:17210 — borsh wRPC, testnet-10)
//!
//! TESTNET ONLY. keys.json holds four fresh throwaway keys.

use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::config::params::TESTNET_PARAMS;
use kaspa_consensus_core::hashing::covenant_id::covenant_id;
use kaspa_consensus_core::hashing::sighash::{SigHashReusedValuesUnsync, calc_schnorr_signature_hash};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::mass::MassCalculator;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{
    CovenantBinding, MutableTransaction, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput,
    TransactionOutpoint, TransactionOutput, UtxoEntry,
};
use kaspa_consensus_core::Hash;
use kaspa_consensus_core::tx::VerifiableTransaction;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::script_builder::ScriptBuilder;
use kaspa_txscript::{EngineCtx, EngineFlags, TxScriptEngine, pay_to_address_script, pay_to_script_hash_script};
use kaspa_wrpc_client::{KaspaRpcClient, WrpcEncoding};
use secp256k1::{Keypair, Secp256k1, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use silverscript_abi::{ArtifactValue, SilAbiArtifact, encode_contract_covenant_decl_sig_script};
use silverscript_lang::compiler::{CompileOptions, compile_to_sil_abi_artifact_with_options};
use std::collections::BTreeMap;
use std::error::Error;
use std::time::Duration;

type R<T> = Result<T, Box<dyn Error>>;

const KCC20_SRC: &str = include_str!("../../kusd-kcc20.sil");
const GRANT_SRC: &str = include_str!("../../warda-dollar-grant.sil");

const USD: i64 = 100_000_000; // 8-decimal atoms, as KUSD
const FUNDED: i64 = 50 * USD;
const CAP: i64 = 5 * USD;
const BUDGET: i64 = 12 * USD;
const MAX_COV: i64 = 8; // KUSD's own maxCovIns / maxCovOuts

const KAS: u64 = 100_000_000;
/// KAS every covenant coin carries. A covenant UTXO occupies two 100-byte
/// storage units (P2SH script + covenant id), so KIP-9 storage mass charges it
/// 4·10^12 / value: 1 KAS costs 40,000 grams of storage mass, 3 KAS ~13,333.
const COIN: u64 = 3 * KAS;
const AGENT_FEES: u64 = 15 * KAS; // the agent's own KAS, for fees + payment coins
const P2PK_BUDGET: u16 = 12; // one checksig
const ID_PUBKEY: u8 = 0x00;
const ID_COVENANT: u8 = 0x02;

// ---------------------------------------------------------------- keys / state

#[derive(Serialize, Deserialize)]
struct Keys {
    funder: String, // also the principal
    agent: String,
    revoker: String,
    payee: String,
}

fn kp(hex: &str) -> R<Keypair> {
    let b = unhex(hex)?;
    Ok(Keypair::from_secret_key(&Secp256k1::new(), &SecretKey::from_slice(&b)?))
}
fn xpk(k: &Keypair) -> Vec<u8> {
    k.x_only_public_key().0.serialize().to_vec()
}
fn addr(k: &Keypair) -> Address {
    Address::new(Prefix::Testnet, Version::PubKey, &k.x_only_public_key().0.serialize())
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex(s: &str) -> R<Vec<u8>> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|e| e.into())).collect()
}

/// A live coin this tool created, with enough to rebuild its UtxoEntry.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Coin {
    txid: String,
    index: u32,
    value: u64,
}
impl Coin {
    fn outpoint(&self) -> R<TransactionOutpoint> {
        Ok(TransactionOutpoint::new(TransactionId::from_slice(&unhex(&self.txid)?), self.index))
    }
}

#[derive(Serialize, Deserialize, Default)]
struct State {
    step: u32,
    token_cov: Option<String>,
    grant_cov: Option<String>,
    /// The funder's spendable KAS change (P2PK).
    funder: Option<Coin>,
    /// The token coin currently holding the dollars, and who owns it.
    token: Option<Coin>,
    token_owner_is_grant: bool,
    token_amount: i64,
    grant: Option<Coin>,
    spent: i64,
    agent_fees: Option<Coin>,
    /// A transaction built, saved, and submitted but not yet seen accepted.
    pending: Option<String>,
}

fn load<T: for<'a> Deserialize<'a> + Default>(path: &str) -> R<T> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(_) => Ok(T::default()),
    }
}
fn save<T: Serialize>(path: &str, v: &T) -> R<()> {
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(v)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}
fn log(entry: serde_json::Value) -> R<()> {
    let mut all: Vec<serde_json::Value> =
        std::fs::read_to_string("onchain-log.json").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    all.push(entry);
    save("onchain-log.json", &all)
}

// ---------------------------------------------------------------- contracts

fn compile(src: &str, args: &[ArtifactValue]) -> R<SilAbiArtifact> {
    Ok(compile_to_sil_abi_artifact_with_options(src, args, CompileOptions::default())?)
}
fn bytecode(a: &SilAbiArtifact) -> Vec<u8> {
    a.contracts.values().next().unwrap().compiled.bytecode.clone()
}
fn spk(a: &SilAbiArtifact) -> ScriptPublicKey {
    pay_to_script_hash_script(&bytecode(a))
}

struct Tpl {
    prefix_len: i64,
    suffix_len: i64,
    hash: Vec<u8>,
}
fn token(owner: &[u8], kind: u8, amount: i64) -> R<SilAbiArtifact> {
    compile(
        KCC20_SRC,
        &[
            ArtifactValue::Bytes(owner.to_vec()),
            ArtifactValue::Int(amount),
            ArtifactValue::Byte(kind),
            ArtifactValue::Bool(false),
            ArtifactValue::Int(MAX_COV),
            ArtifactValue::Int(MAX_COV),
        ],
    )
}
fn template() -> R<Tpl> {
    let a = token(&[0; 32], ID_COVENANT, 0)?;
    let c = &a.contracts.values().next().unwrap().compiled;
    let (off, len) = (c.state_span.offset, c.state_span.len);
    Ok(Tpl { prefix_len: off as i64, suffix_len: (c.bytecode.len() - off - len) as i64, hash: c.template_hash.to_vec() })
}
fn grant(k: &Ks, token_cov: &Hash, spent: i64) -> R<SilAbiArtifact> {
    let t = template()?;
    compile(
        GRANT_SRC,
        &[
            ArtifactValue::Bytes(xpk(&k.agent)),
            ArtifactValue::Bytes(xpk(&k.revoker)),
            ArtifactValue::Bytes(xpk(&k.funder)),
            ArtifactValue::Bytes(xpk(&k.payee)),
            ArtifactValue::Int(CAP),
            ArtifactValue::Int(BUDGET),
            ArtifactValue::Bytes(token_cov.as_bytes().to_vec()),
            ArtifactValue::Int(spent),
            ArtifactValue::Int(t.prefix_len),
            ArtifactValue::Int(t.suffix_len),
            ArtifactValue::Bytes(t.hash),
        ],
    )
}
fn tok_arg(owner: &[u8], kind: u8, amount: i64) -> ArtifactValue {
    BTreeMap::from([
        ("ownerIdentifier".to_string(), owner.to_vec().into()),
        ("identifierType".to_string(), kind.into()),
        ("amount".to_string(), amount.into()),
        ("isMinter".to_string(), false.into()),
    ])
    .into()
}
fn grant_state(token_cov: &Hash, spent: i64) -> ArtifactValue {
    BTreeMap::from([
        ("tokenCovid".to_string(), token_cov.as_bytes().to_vec().into()),
        ("spent".to_string(), spent.into()),
    ])
    .into()
}
fn call(a: &SilAbiArtifact, func: &str, args: Vec<ArtifactValue>) -> R<Vec<u8>> {
    let name = a.contracts.keys().next().unwrap().clone();
    let mut s = encode_contract_covenant_decl_sig_script(a, &name, func, true, &args).map_err(|e| e.to_string())?;
    s.extend(ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() }).add_data(&bytecode(a))?.drain());
    Ok(s)
}

struct Ks {
    funder: Keypair,
    agent: Keypair,
    revoker: Keypair,
    payee: Keypair,
}

// ---------------------------------------------------------------- tx building

/// One input: its UTXO, and how to produce its signature script once the
/// transaction (with final compute budgets) is known.
struct In {
    coin: Coin,
    entry: UtxoEntry,
    sign: Box<dyn Fn(&Transaction, &[UtxoEntry], usize) -> R<Vec<u8>>>,
}

fn sighash_sig(tx: &Transaction, entries: &[UtxoEntry], idx: usize, k: &Keypair) -> R<Vec<u8>> {
    let m = MutableTransaction::with_entries(tx.clone(), entries.to_vec());
    let h = calc_schnorr_signature_hash(&m.as_verifiable(), idx, SIG_HASH_ALL, &SigHashReusedValuesUnsync::new());
    let mut s = k.sign_schnorr(secp256k1::Message::from_digest_slice(h.as_bytes().as_slice())?).as_ref().to_vec();
    s.push(SIG_HASH_ALL.to_u8());
    Ok(s)
}
fn p2pk_in(coin: Coin, k: Keypair) -> In {
    let entry = UtxoEntry::new(coin.value, pay_to_address_script(&addr(&k)), 0, false, None);
    In { coin, entry, sign: Box::new(move |tx, es, i| Ok(ScriptBuilder::new().add_data(&sighash_sig(tx, es, i, &k)?)?.drain())) }
}

fn assemble(ins: &[In], outs: &[TransactionOutput], budgets: &[u16], sigs: Option<&[Vec<u8>]>) -> R<Transaction> {
    let inputs = ins
        .iter()
        .enumerate()
        .map(|(i, x)| {
            Ok(TransactionInput::new_with_compute_budget(
                x.coin.outpoint()?,
                sigs.map(|s| s[i].clone()).unwrap_or_default(),
                0,
                budgets[i],
            ))
        })
        .collect::<R<Vec<_>>>()?;
    Ok(Transaction::new(1, inputs, outs.to_vec(), 0, SUBNETWORK_ID_NATIVE, 0, vec![]))
}

fn sign_all(ins: &[In], outs: &[TransactionOutput], budgets: &[u16]) -> R<Transaction> {
    let unsigned = assemble(ins, outs, budgets, None)?;
    let entries: Vec<UtxoEntry> = ins.iter().map(|x| x.entry.clone()).collect();
    let sigs = ins.iter().enumerate().map(|(i, x)| (x.sign)(&unsigned, &entries, i)).collect::<R<Vec<_>>>()?;
    assemble(ins, outs, budgets, Some(&sigs))
}

/// Run every input through the engine with REAL signature costs.
/// Returns script units used per input, or the first failure.
fn engine(tx: &Transaction, entries: &[UtxoEntry]) -> Vec<Result<u64, String>> {
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let cache = Cache::new(10_000);
    let ctx = match CovenantsContext::from_tx(&populated) {
        Ok(c) => c,
        Err(e) => return vec![Err(format!("covenant context: {e:?}"))],
    };
    (0..tx.inputs.len())
        .map(|i| {
            let reused = SigHashReusedValuesUnsync::new();
            let mut vm = TxScriptEngine::from_transaction_input(
                &populated,
                &tx.inputs[i],
                i,
                populated.utxo(i).unwrap(),
                EngineCtx::new(&cache).with_reused(&reused).with_covenants_ctx(&ctx),
                EngineFlags { covenants_enabled: true, ..Default::default() },
            );
            vm.execute().map(|_| vm.used_script_units().0).map_err(|e| format!("{e:?}"))
        })
        .collect()
}

struct Built {
    tx: Transaction,
    budgets: Vec<u16>,
    units: Vec<u64>,
    compute_mass: u64,
    transient_mass: u64,
    storage_mass: u64,
    fee: u64,
}

/// Build, measure, size budgets and fee from the measurement, re-sign, and
/// re-verify. `fee_out` is the index of the output that absorbs the fee
/// (its value is reduced by the fee). `expect_ok=false` builds a transaction
/// the engine is EXPECTED to refuse and returns it anyway, with the refusal.
fn build(ins: Vec<In>, mut outs: Vec<TransactionOutput>, fee_out: usize, expect_ok: bool) -> R<(Built, Vec<String>)> {
    let entries: Vec<UtxoEntry> = ins.iter().map(|x| x.entry.clone()).collect();
    let mc = MassCalculator::new_with_consensus_params(&TESTNET_PARAMS);

    // pass 1: generous budgets, zero fee — measure
    let generous: Vec<u16> = ins.iter().map(|_| 400).collect();
    let tx = sign_all(&ins, &outs, &generous)?;
    let measured = engine(&tx, &entries);
    let refusals: Vec<String> =
        measured.iter().enumerate().filter_map(|(i, r)| r.as_ref().err().map(|e| format!("input {i}: {e}"))).collect();
    if expect_ok && !refusals.is_empty() {
        return Err(format!("engine refused a transaction that should be valid: {refusals:?}").into());
    }
    let budgets: Vec<u16> = measured
        .iter()
        .map(|r| match r {
            Ok(u) => ((u + 9_999) / 10_000 + 1).max(P2PK_BUDGET as u64) as u16,
            Err(_) => 400,
        })
        .collect();

    // pass 2: real budgets, fee from mass (twice the floor rate, testnet)
    let mut fee = 0u64;
    let mut last = None;
    for _ in 0..3 {
        let tx = sign_all(&ins, &outs, &budgets)?;
        let nc = mc.calc_non_contextual_masses(&tx);
        let storage = mc
            .calc_contextual_masses(&PopulatedTransaction::new(&tx, entries.clone()))
            .map(|c| c.storage_mass)
            .unwrap_or(u64::MAX);
        // The node's relay floor is 100 sompi per gram of fee mass — the
        // first run was refused at 2,283 compute mass needing 228,300 — the
        // same 100/gram state-of-warda.md measured six times. Storage mass
        // needs no extra fee. Pay the floor on the larger dimension + 10%.
        let need = nc.compute_mass.max(nc.transient_mass) * 110 + 10_000;
        let _ = storage;
        if need <= fee {
            last = Some((tx, nc, storage));
            break;
        }
        outs[fee_out].value = outs[fee_out].value + fee - need;
        fee = need;
    }
    let (tx, nc, storage) = match last {
        Some(x) => x,
        None => {
            let tx = sign_all(&ins, &outs, &budgets)?;
            let nc = mc.calc_non_contextual_masses(&tx);
            let st = mc.calc_contextual_masses(&PopulatedTransaction::new(&tx, entries.clone())).map(|c| c.storage_mass).unwrap_or(0);
            (tx, nc, st)
        }
    };
    let final_check = engine(&tx, &entries);
    let refusals2: Vec<String> =
        final_check.iter().enumerate().filter_map(|(i, r)| r.as_ref().err().map(|e| format!("input {i}: {e}"))).collect();
    if expect_ok && !refusals2.is_empty() {
        return Err(format!("engine refused the final transaction: {refusals2:?}").into());
    }
    let units = final_check.iter().map(|r| *r.as_ref().unwrap_or(&0)).collect();
    Ok((
        Built {
            tx,
            budgets,
            units,
            compute_mass: nc.compute_mass,
            transient_mass: nc.transient_mass,
            storage_mass: storage,
            fee,
        },
        if expect_ok { vec![] } else { refusals2 },
    ))
}

fn cov_out(value: u64, a: &SilAbiArtifact, auth: u16, cov: Hash) -> TransactionOutput {
    TransactionOutput { value, script_public_key: spk(a), covenant: Some(CovenantBinding { authorizing_input: auth, covenant_id: cov }) }
}
fn p2pk_out(value: u64, k: &Keypair) -> TransactionOutput {
    TransactionOutput { value, script_public_key: pay_to_address_script(&addr(k)), covenant: None }
}
fn coin_of(tx: &Transaction, index: u32) -> Coin {
    Coin { txid: tx.id().to_string(), index, value: tx.outputs[index as usize].value }
}
fn h(s: &Option<String>) -> R<Hash> {
    Ok(Hash::from_slice(&unhex(s.as_ref().ok_or("missing covenant id")?)?))
}

// ---------------------------------------------------------------- node

static DRY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn dry() -> bool {
    DRY.load(std::sync::atomic::Ordering::Relaxed)
}

async fn connect() -> R<KaspaRpcClient> {
    // Borsh (17210) by default; your run-node.sh opens JSON on 18210, so a
    // URL ending in :18210 (or KASPA_WRPC_JSON=1) switches to JSON.
    let url = std::env::var("KASPA_WRPC").unwrap_or_else(|_| "ws://127.0.0.1:17210".into());
    let json = url.ends_with(":18210") || std::env::var("KASPA_WRPC_JSON").is_ok();
    let enc = if json { WrpcEncoding::SerdeJson } else { WrpcEncoding::Borsh };
    println!("connecting to {url} ({})", if json { "JSON" } else { "Borsh" });
    let c = KaspaRpcClient::new(enc, Some(&url), None, None, None)?;
    // The client's default strategy retries forever and prints nothing, so a
    // closed port looks like a hang. Give up after 10s and say why.
    match tokio::time::timeout(Duration::from_secs(10), async {
        c.connect(None).await?;
        c.get_info().await.map_err(|e| Box::new(e) as Box<dyn Error>)
    })
    .await
    {
        Err(_) => {
            return Err(format!(
                "no answer from {url} in 10s. Nothing is listening there, or the node is down. \
                 Your node's JSON wRPC is on 18210: KASPA_WRPC=ws://127.0.0.1:18210 cargo run --release -- run"
            )
            .into())
        }
        Ok(Err(e)) => return Err(e),
        Ok(Ok(info)) => {
            println!("node {} | synced {} | utxoindex {}", info.server_version, info.is_synced, info.is_utxo_indexed);
        }
    }
    let info = c.get_info().await?;
    if !info.is_synced {
        return Err("node is not synced".into());
    }
    if !info.is_utxo_indexed {
        return Err("node has no UTXO index (--utxoindex)".into());
    }
    Ok(c)
}

/// Wait until output 0 of `txid` is in the UTXO set. Covenant outputs are
/// P2SH, so we look at that output's own address.
async fn wait_accepted(c: &KaspaRpcClient, tx: &Transaction) -> R<()> {
    let a = kaspa_txscript::extract_script_pub_key_address(&tx.outputs[0].script_public_key, Prefix::Testnet)?;
    let id = tx.id();
    for _ in 0..90 {
        let utxos = c.get_utxos_by_addresses(vec![a.clone()]).await?;
        if let Some(u) = utxos.iter().find(|u| u.outpoint.transaction_id == id && u.outpoint.index == 0) {
            // A transport that drops the covenant binding (an older JSON model
            // did exactly that) would still get the tx accepted — as a plain
            // P2SH coin with no covenant. Check the chain kept the binding.
            let want = tx.outputs[0].covenant.map(|b| b.covenant_id);
            if u.utxo_entry.covenant_id != want {
                return Err(format!(
                    "{id} accepted, but output 0's covenant id on chain is {:?}, expected {want:?}. \
                     The binding was lost in transit — stop and report this.",
                    u.utxo_entry.covenant_id
                )
                .into());
            }
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Err(format!("{id} not seen in the UTXO set after 90s — check before re-running (state.json keeps it pending)").into())
}

async fn submit(c: &Option<KaspaRpcClient>, st: &mut State, step: &str, b: &Built) -> R<()> {
    let id = b.tx.id().to_string();
    println!(
        "  {step}: tx {id}\n    mass compute {} transient {} storage {} | fee {} sompi | budgets {:?} | units {:?}",
        b.compute_mass, b.transient_mass, b.storage_mass, b.fee, b.budgets, b.units
    );
    // Persist BEFORE broadcasting: once it is on the network the coins have moved.
    st.pending = Some(id.clone());
    save("state.json", st)?;
    match c {
        Some(c) => {
            if let Err(e) = c.submit_transaction((&b.tx).into(), false).await {
                // Refused at submission: nothing reached the network, so the
                // coins have NOT moved. Clear pending, or the next run would
                // refuse to start over a transaction that never existed.
                st.pending = None;
                save("state.json", st)?;
                return Err(format!("node refused {step}: {e}").into());
            }
            wait_accepted(c, &b.tx).await?;
            println!("    accepted");
        }
        None => println!("    (dry run: engine-valid, not submitted)"),
    }
    log(json!({"step": step, "txid": id, "accepted": true, "compute_mass": b.compute_mass,
        "transient_mass": b.transient_mass, "storage_mass": b.storage_mass, "fee_sompi": b.fee,
        "compute_budgets": b.budgets, "script_units": b.units, "size_bytes":
        kaspa_consensus_core::mass::transaction_estimated_serialized_size(&b.tx)}))?;
    st.pending = None;
    Ok(())
}

/// Submit a transaction the engine refused, so the NODE's refusal is on record.
async fn submit_attack(c: &Option<KaspaRpcClient>, step: &str, b: &Built, engine_refusals: &[String]) -> R<()> {
    println!("  {step}\n    engine: {}", engine_refusals.join("; "));
    if engine_refusals.is_empty() {
        return Err(format!("{step}: the engine ACCEPTED an attack — stopping").into());
    }
    let Some(c) = c else {
        println!("    (dry run: not submitted)");
        return Ok(());
    };
    match c.submit_transaction((&b.tx).into(), false).await {
        Ok(id) => Err(format!("{step}: the NODE accepted an attack, txid {id} — stopping").into()),
        Err(e) => {
            println!("    node:   refused — {e}");
            log(json!({"step": step, "txid": b.tx.id().to_string(), "accepted": false,
                "engine": engine_refusals, "node": e.to_string()}))
        }
    }
}

// ---------------------------------------------------------------- steps

async fn run(k: &Ks) -> R<()> {
    let mut st: State = load("state.json")?;
    if let Some(p) = &st.pending {
        return Err(format!(
            "transaction {p} was submitted but not confirmed accepted. Look it up (explorer or node) \
             before doing anything; if accepted, advance state.json by hand; if not, clear `pending`."
        )
        .into());
    }
    let c = if dry() { None } else { Some(connect().await?) };

    if st.step < 1 {
        println!("step 1: token genesis — $50 of test dollars to the funder");
        let coin = match &c {
            None => Coin { txid: hex(&[0x11; 32]), index: 0, value: 50 * KAS },
            Some(c) => {
                let utxos = c.get_utxos_by_addresses(vec![addr(&k.funder)]).await?;
                let u = utxos
                    .iter()
                    .filter(|u| u.utxo_entry.covenant_id.is_none())
                    .max_by_key(|u| u.utxo_entry.amount)
                    .ok_or("the funder address holds nothing — fund it (cargo run -- keys prints it)")?;
                if u.utxo_entry.amount < 30 * KAS {
                    return Err(format!("funder's largest coin is {} sompi; send at least 30 TN10 KAS", u.utxo_entry.amount).into());
                }
                Coin { txid: u.outpoint.transaction_id.to_string(), index: u.outpoint.index, value: u.utxo_entry.amount }
            }
        };
        let genesis = token(&xpk(&k.funder), ID_PUBKEY, FUNDED)?;
        let unbound = TransactionOutput { value: COIN, script_public_key: spk(&genesis), covenant: None };
        let tcov = covenant_id(coin.outpoint()?, std::iter::once((0u32, &unbound)));
        let outs = vec![cov_out(COIN, &genesis, 0, tcov), p2pk_out(coin.value - COIN, &k.funder)];
        let (b, _) = build(vec![p2pk_in(coin, k.funder)], outs, 1, true)?;
        st.token_cov = Some(tcov.to_string());
        submit(&c, &mut st, "1 token-genesis", &b).await?;
        st.token = Some(coin_of(&b.tx, 0));
        st.token_amount = FUNDED;
        st.funder = Some(coin_of(&b.tx, 1));
        st.step = 1;
        save("state.json", &st)?;
        println!("    token covenant id {tcov}");
    }
    let tcov = h(&st.token_cov)?;

    if st.step < 2 {
        println!("step 2: grant genesis — cap $5, budget $12, payee fixed");
        let f = st.funder.clone().unwrap();
        let g0 = grant(k, &tcov, 0)?;
        let unbound = TransactionOutput { value: COIN, script_public_key: spk(&g0), covenant: None };
        let gcov = covenant_id(f.outpoint()?, std::iter::once((0u32, &unbound)));
        let outs = vec![cov_out(COIN, &g0, 0, gcov), p2pk_out(f.value - COIN, &k.funder)];
        let (b, _) = build(vec![p2pk_in(f, k.funder)], outs, 1, true)?;
        st.grant_cov = Some(gcov.to_string());
        submit(&c, &mut st, "2 grant-genesis", &b).await?;
        st.grant = Some(coin_of(&b.tx, 0));
        st.funder = Some(coin_of(&b.tx, 1));
        st.step = 2;
        save("state.json", &st)?;
        println!("    grant covenant id {gcov}");
    }
    let gcov = h(&st.grant_cov)?;
    let gid = gcov.as_bytes().to_vec();

    if st.step < 3 {
        println!("step 3: fund — the $50 moves under the grant's covenant id; agent gets fee KAS");
        let t = st.token.clone().unwrap();
        let f = st.funder.clone().unwrap();
        let held = token(&xpk(&k.funder), ID_PUBKEY, FUNDED)?;
        let under_grant = token(&gid, ID_COVENANT, FUNDED)?;
        let (funder_k, held_c, gid_c) = (k.funder, held.clone(), gid.clone());
        let tok_in = In {
            entry: UtxoEntry::new(t.value, spk(&held), 0, false, Some(tcov)),
            coin: t,
            sign: Box::new(move |tx, es, i| {
                call(
                    &held_c,
                    "transferPolicy",
                    vec![
                        ArtifactValue::Array(vec![tok_arg(&gid_c, ID_COVENANT, FUNDED)]),
                        ArtifactValue::Bytes(sighash_sig(tx, es, i, &funder_k)?),
                        ArtifactValue::Byte(0),
                    ],
                )
            }),
        };
        let outs = vec![
            cov_out(COIN, &under_grant, 0, tcov),
            p2pk_out(AGENT_FEES, &k.agent),
            p2pk_out(f.value - AGENT_FEES, &k.funder),
        ];
        let (b, _) = build(vec![tok_in, p2pk_in(f, k.funder)], outs, 2, true)?;
        submit(&c, &mut st, "3 fund", &b).await?;
        st.token = Some(coin_of(&b.tx, 0));
        st.token_owner_is_grant = true;
        st.agent_fees = Some(coin_of(&b.tx, 1));
        st.funder = Some(coin_of(&b.tx, 2));
        st.step = 3;
        save("state.json", &st)?;
    }

    for (step, amount) in [(4u32, 5 * USD), (5, 5 * USD)] {
        if st.step < step {
            println!("step {step}: pay ${} to the payee", amount / USD);
            let b = pay_tx(k, &st, tcov, gcov, amount, PayShape::Honest, true)?.0;
            submit(&c, &mut st, &format!("{step} pay ${}", amount / USD), &b).await?;
            advance_after_pay(&mut st, &b.tx, amount);
            st.step = step;
            save("state.json", &st)?;
        }
    }

    if st.step < 6 {
        println!("step 6: attacks — built, refused by the engine, then submitted anyway");
        for (label, amount, shape) in [
            ("6a over the $5 cap: pay $6", 6 * USD, PayShape::Honest),
            ("6b over the $12 budget: pay $3 with $10 spent", 3 * USD, PayShape::Honest),
            ("6c move $38 to the agent WITHOUT the grant in the tx", 38 * USD, PayShape::NoGrant),
        ] {
            let (b, refusals) = pay_tx(k, &st, tcov, gcov, amount, shape, false)?;
            submit_attack(&c, label, &b, &refusals).await?;
        }
        st.step = 6;
        save("state.json", &st)?;
    }

    if st.step < 7 {
        println!("step 7: pay $2 — spent reaches the $12 budget exactly");
        let b = pay_tx(k, &st, tcov, gcov, 2 * USD, PayShape::Honest, true)?.0;
        submit(&c, &mut st, "7 pay $2", &b).await?;
        advance_after_pay(&mut st, &b.tx, 2 * USD);
        st.step = 7;
        save("state.json", &st)?;
    }

    if st.step < 8 {
        println!("step 8: revoke — remaining dollars back to the principal");
        let t = st.token.clone().unwrap();
        let held_value = t.value;
        let g = st.grant.clone().unwrap();
        let f = st.funder.clone().unwrap();
        let rest = st.token_amount;
        let held = token(&gid, ID_COVENANT, rest)?;
        let g_prev = grant(k, &tcov, st.spent)?;
        let g_dead = grant(k, &tcov, BUDGET)?;
        let back = token(&xpk(&k.funder), ID_PUBKEY, rest)?;
        let (held_c, principal) = (held.clone(), xpk(&k.funder));
        let tok_in = In {
            entry: UtxoEntry::new(t.value, spk(&held), 0, false, Some(tcov)),
            coin: t,
            sign: Box::new(move |_, _, _| {
                call(
                    &held_c,
                    "transferPolicy",
                    vec![
                        ArtifactValue::Array(vec![tok_arg(&principal, ID_PUBKEY, rest)]),
                        ArtifactValue::Bytes(vec![0; 65]),
                        ArtifactValue::Byte(0),
                    ],
                )
            }),
        };
        let (gp, revoker, principal2) = (g_prev.clone(), k.revoker, xpk(&k.funder));
        let grant_in = In {
            entry: UtxoEntry::new(g.value, spk(&g_prev), 0, false, Some(gcov)),
            coin: g.clone(),
            sign: Box::new(move |tx, es, i| {
                call(
                    &gp,
                    "revoke",
                    vec![
                        grant_state(&tcov, BUDGET),
                        ArtifactValue::Bytes(sighash_sig(tx, es, i, &revoker)?),
                        tok_arg(&principal2, ID_PUBKEY, rest),
                    ],
                )
            }),
        };
        let outs = vec![cov_out(held_value, &back, 0, tcov), cov_out(g.value, &g_dead, 1, gcov), p2pk_out(f.value, &k.funder)];
        let (b, _) = build(vec![tok_in, grant_in, p2pk_in(f, k.funder)], outs, 2, true)?;
        submit(&c, &mut st, "8 revoke", &b).await?;
        st.token = Some(coin_of(&b.tx, 0));
        st.token_owner_is_grant = false;
        st.grant = Some(coin_of(&b.tx, 1));
        st.funder = Some(coin_of(&b.tx, 2));
        st.spent = BUDGET;
        st.step = 8;
        save("state.json", &st)?;
    }
    println!("\ndone. every step is in onchain-log.json");
    Ok(())
}

#[derive(Clone, Copy, PartialEq)]
enum PayShape {
    Honest,
    NoGrant,
}

fn pay_tx(k: &Ks, st: &State, tcov: Hash, gcov: Hash, amount: i64, shape: PayShape, expect_ok: bool) -> R<(Built, Vec<String>)> {
    let gid = gcov.as_bytes().to_vec();
    let t = st.token.clone().unwrap();
    let g = st.grant.clone().unwrap();
    let a = st.agent_fees.clone().unwrap();
    let held_amt = st.token_amount;
    let held = token(&gid, ID_COVENANT, held_amt)?;
    let (pay_owner, pay_kind) = match shape {
        PayShape::Honest => (xpk(&k.payee), ID_PUBKEY),
        PayShape::NoGrant => (xpk(&k.agent), ID_PUBKEY),
    };
    let payment = token(&pay_owner, pay_kind, amount)?;
    let change = token(&gid, ID_COVENANT, held_amt - amount)?;

    let (held_c, po, ch_owner) = (held.clone(), pay_owner.clone(), gid.clone());
    let tok_in = In {
        entry: UtxoEntry::new(t.value, spk(&held), 0, false, Some(tcov)),
        coin: t.clone(),
        sign: Box::new(move |_, _, _| {
            call(
                &held_c,
                "transferPolicy",
                vec![
                    ArtifactValue::Array(vec![tok_arg(&po, pay_kind, amount), tok_arg(&ch_owner, ID_COVENANT, held_amt - amount)]),
                    ArtifactValue::Bytes(vec![0; 65]),
                    ArtifactValue::Byte(0),
                ],
            )
        }),
    };

    let mut ins = vec![tok_in];
    let mut outs = vec![cov_out(COIN, &payment, 0, tcov), cov_out(t.value, &change, 0, tcov)];
    if shape == PayShape::Honest {
        let g_prev = grant(k, &tcov, st.spent)?;
        let g_next = grant(k, &tcov, st.spent + amount)?;
        let (gp, agent, payee, spent) = (g_prev.clone(), k.agent, xpk(&k.payee), st.spent);
        let gid2 = gid.clone();
        ins.push(In {
            entry: UtxoEntry::new(g.value, spk(&g_prev), 0, false, Some(gcov)),
            coin: g.clone(),
            sign: Box::new(move |tx, es, i| {
                call(
                    &gp,
                    "pay",
                    vec![
                        grant_state(&tcov, spent + amount),
                        ArtifactValue::Bytes(sighash_sig(tx, es, i, &agent)?),
                        tok_arg(&payee, ID_PUBKEY, amount),
                        tok_arg(&gid2, ID_COVENANT, held_amt - amount),
                    ],
                )
            }),
        });
        outs.push(cov_out(g.value, &g_next, 1, gcov));
    }
    ins.push(p2pk_in(a.clone(), k.agent));
    // the payment coin's KAS and the fee come from the agent's own KAS
    outs.push(p2pk_out(a.value - COIN, &k.agent));
    let fee_out = outs.len() - 1;
    build(ins, outs, fee_out, expect_ok)
}

fn advance_after_pay(st: &mut State, tx: &Transaction, amount: i64) {
    st.token = Some(coin_of(tx, 1));
    st.token_amount -= amount;
    st.grant = Some(coin_of(tx, 2));
    st.spent += amount;
    st.agent_fees = Some(coin_of(tx, 3));
}

// ---------------------------------------------------------------- main

#[tokio::main]
async fn main() -> R<()> {
    let cmd = std::env::args().nth(1).unwrap_or_default();
    match cmd.as_str() {
        "keys" => {
            if std::path::Path::new("keys.json").exists() {
                println!("keys.json exists — not overwriting");
            } else {
                let g = || hex(&SecretKey::new(&mut secp256k1::rand::thread_rng()).secret_bytes());
                save("keys.json", &Keys { funder: g(), agent: g(), revoker: g(), payee: g() })?;
                println!("wrote keys.json (testnet-10 throwaway keys)");
            }
            let k = keys()?;
            println!("\nfund this address with at least 30 TN10 KAS (one transaction):\n  {}", addr(&k.funder));
            println!("\n(agent {}, payee {})", addr(&k.agent), addr(&k.payee));
        }
        "run" => run(&keys()?).await?,
        "simulate" => {
            // The whole lifecycle through the engine, no node, no real coins,
            // in a scratch directory so no state leaks into the real run.
            let k = keys()?;
            let dir = std::env::temp_dir().join(format!("kusd-grant-sim-{}", std::process::id()));
            std::fs::create_dir_all(&dir)?;
            std::env::set_current_dir(&dir)?;
            DRY.store(true, std::sync::atomic::Ordering::Relaxed);
            run(&k).await?;
            println!("simulation log: {}", dir.join("onchain-log.json").display());
        }
        "status" => println!("{}", std::fs::read_to_string("state.json").unwrap_or_else(|_| "no state yet".into())),
        _ => println!("usage: keys | simulate | run | status"),
    }
    Ok(())
}

fn keys() -> R<Ks> {
    let k: Keys = serde_json::from_str(&std::fs::read_to_string("keys.json").map_err(|_| "no keys.json — run `keys` first")?)?;
    Ok(Ks { funder: kp(&k.funder)?, agent: kp(&k.agent)?, revoker: kp(&k.revoker)?, payee: kp(&k.payee)? })
}

impl Default for Keys {
    fn default() -> Self {
        Keys { funder: String::new(), agent: String::new(), revoker: String::new(), payee: String::new() }
    }
}
