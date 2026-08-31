//! warda-deploy — put the Warda covenant on testnet-10.
//!
//! Commands:
//!   status    node readiness
//!   address   the funding address for WARDA_SK (fund this from the faucet)
//!   genesis   create the grant covenant UTXO
//!   verify    run a transaction built elsewhere (the JS SDK) through the
//!             script engine; `submit` does the same and broadcasts it;
//!             `advance` moves grant.json on for one already submitted
//!   golden    write golden-spend.json, the reference transaction the JS SDK
//!             must reproduce (no node, no key, fully deterministic inputs)
//!
//! Key comes from WARDA_SK as 32 hex bytes. Testnet only — do not point this
//! at a mainnet key.

use kaspa_addresses::{Address, Prefix, Version};
use kaspa_consensus_core::hashing::covenant_id::covenant_id;
use kaspa_consensus_core::hashing::sighash::{calc_schnorr_signature_hash, SigHashReusedValuesUnsync};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{
    CovenantBinding, MutableTransaction, Transaction, TransactionInput, TransactionOutpoint,
    TransactionOutput, UtxoEntry,
};
use kaspa_txscript::script_builder::ScriptBuilder;
use kaspa_txscript::{extract_script_pub_key_address, pay_to_address_script, pay_to_script_hash_script};
use kaspa_consensus_core::tx::ScriptPublicKey;
use kaspa_wrpc_client::prelude::*;
use kaspa_wrpc_client::{KaspaRpcClient, WrpcEncoding};
use secp256k1::{Keypair, Secp256k1};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{EngineCtx, EngineFlags, TxScriptEngine};
use kaspa_txscript_errors::TxScriptError;
use kaspa_consensus_core::tx::{PopulatedTransaction, VerifiableTransaction};
use silverscript_lang::ast::{ArrayDim, Expr, TypeBase, TypeRef};
use silverscript_lang::compiler::{
    compile_contract, struct_object, CompileOptions, CompiledContract, CovenantDeclCallOptions,
};
use std::error::Error;

const DEFAULT_URL: &str = "ws://127.0.0.1:17210";
const SOURCE: &str = include_str!("../warda_grant.sil");
const KAS: i64 = 100_000_000;
/// Fees are charged per unit of transaction MASS, at 100 sompi per unit.
/// A spend carries the ~3KB redeem script in its signature script, so its mass
/// is dominated by size; genesis is a plain P2PK spend and is far smaller.
const GENESIS_FEE: u64 = 1_000_000;
const SPEND_FEE: u64 = 1_000_000;

/// COMPUTE BUDGET: charged as mass, so over-provisioning costs real money —
/// but under-provisioning is rejected outright. Both directions bite.
///
/// The dominant cost is not the covenant logic. **One signature verification
/// costs 100,000 script units** (GRAMS_PER_SIGOP_COUNT_UNIT 1000 ×
/// SCRIPT_UNITS_PER_GRAM 100). The covenant's own arithmetic and Merkle fold
/// add only ~24,000 on top of that.
///
/// So: 1 checksig = 100,000, less the 9,999 free per-input allowance, over
/// 10,000 units per budget = 10 budget units minimum for ANY signed input.
///   genesis (plain P2PK, one checksig)     ~100,000 units -> 10, use 12
///   spend   (checksig + covenant logic)    ~124,000 units -> 12, use 16
///
/// Note this is why the harness's measurement read low: it runs with
/// `sigop_script_units: 0`, which zeroes the signature charge.
const GENESIS_COMPUTE_BUDGET: u16 = 12;
const SPEND_COMPUTE_BUDGET: u16 = 16;

/// Grant parameters for the demo. Deliberately small: this is a public
/// testnet artefact, and the numbers should be legible in a screenshot.
const BUDGET: i64 = 10 * KAS;
const MAX_PER_SPEND: i64 = 2 * KAS;
const EPOCH_LIMIT: i64 = 5 * KAS;
const EPOCH_LENGTH: i64 = 1_000;
const MAX_PROOF_DEPTH: i64 = 4;
/// Must exceed the real fee a spend pays, or the covenant's value-conservation
/// check refuses the transaction the SDK just built.
const MAX_FEE: i64 = 5_000_000;
const DELEGATION_DEPTH: i64 = 2;

/// How far behind the tip to claim. The claimed DAA compiles to a CLTV lock,
/// and a lock equal to the tip is not yet final. ~10s at 10 blocks per second.
const DAA_BACKOFF: i64 = 100;

// ---- recipient allowlist -------------------------------------------------

const LEAF: u8 = 0x01;
const NODE: u8 = 0x02;

fn b2b(parts: &[&[u8]]) -> [u8; 32] {
    let mut st = blake2b_simd::Params::new().hash_length(32).to_state();
    for p in parts {
        st.update(p);
    }
    let mut o = [0u8; 32];
    o.copy_from_slice(st.finalize().as_bytes());
    o
}

fn merkle_root(members: &[[u8; 32]]) -> [u8; 32] {
    let mut sorted = members.to_vec();
    sorted.sort();
    let mut level: Vec<[u8; 32]> = sorted.iter().map(|r| b2b(&[&[LEAF], r])).collect();
    while level.len() > 1 {
        let mut next = Vec::new();
        let mut i = 0;
        while i < level.len() {
            if i + 1 < level.len() {
                next.push(b2b(&[&[NODE], &level[i], &level[i + 1]]));
            } else {
                next.push(level[i]);
            }
            i += 2;
        }
        level = next;
    }
    level[0]
}

/// The allowlist. Slot 0 is a REAL derived key so the demo pays somewhere
/// spendable; the rest are filler to give the tree depth.
fn demo_recipients() -> Vec<[u8; 32]> {
    vec![
        demo_api_key().x_only_public_key().0.serialize(),
        [0xa2; 32],
        [0xa3; 32],
        [0xa4; 32],
    ]
}

/// Not in the allowlist. No proof exists that places this in the tree.
fn attacker() -> [u8; 32] {
    [0xee; 32]
}

// ---- covenant ------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn grant_ctor(
    agent_xonly: [u8; 32],
    principal_xonly: [u8; 32],
    root: [u8; 32],
    not_before: i64,
    expires_at: i64,
    spent: i64,
    reserved: i64,
    epoch_index: i64,
    epoch_spent: i64,
) -> Vec<Expr<'static>> {
    vec![
        Expr::bytes(principal_xonly.to_vec()), //  0 principalKey
        Expr::bytes(principal_xonly.to_vec()), //  1 revocationKey
        Expr::int(MAX_FEE),                    //  2 maxFee
        Expr::bytes(agent_xonly.to_vec()),     //  3 genesisAgentKey
        Expr::int(BUDGET),                     //  4 genesisBudgetTotal
        Expr::int(MAX_PER_SPEND),              //  5 genesisMaxPerSpend
        Expr::int(EPOCH_LIMIT),                //  6 genesisEpochLimit
        Expr::int(EPOCH_LENGTH),               //  7 genesisEpochLength
        Expr::bytes(root.to_vec()),            //  8 genesisRecipientsRoot
        Expr::int(not_before),                 //  9 genesisNotBefore
        Expr::int(expires_at),                 // 10 genesisExpiresAt
        Expr::int(DELEGATION_DEPTH),           // 11 genesisDelegationDepth
        Expr::int(MAX_PROOF_DEPTH),            // 12 maxProofDepth
        Expr::int(spent),                      // 13 initSpentTotal
        Expr::int(reserved),                   // 14 initReserved
        Expr::int(epoch_index),                // 15 initEpochIndex
        Expr::int(epoch_spent),                // 16 initEpochSpent
    ]
}

fn compile(ctor: Vec<Expr<'static>>) -> Result<CompiledContract<'static>, Box<dyn Error>> {
    compile_contract(SOURCE, &ctor, CompileOptions::default()).map_err(|e| format!("compile: {e:?}").into())
}

// ---- keys ----------------------------------------------------------------

fn keypair() -> Result<Keypair, Box<dyn Error>> {
    let hex = std::env::var("WARDA_SK")
        .map_err(|_| "set WARDA_SK to 32 hex bytes (testnet key only)")?;
    let bytes = (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16))
        .collect::<Result<Vec<u8>, _>>()?;
    if bytes.len() != 32 {
        return Err("WARDA_SK must be exactly 32 bytes of hex".into());
    }
    Ok(Keypair::from_seckey_slice(&Secp256k1::new(), &bytes)?)
}

fn address_of(kp: &Keypair) -> Address {
    Address::new(Prefix::Testnet, Version::PubKey, &kp.x_only_public_key().0.serialize())
}

/// Signs a standard P2PK input. Not a covenant spend — this is the ordinary
/// wallet UTXO that funds the grant.
fn sign_p2pk(tx: Transaction, entries: Vec<UtxoEntry>, idx: usize, kp: &Keypair) -> Result<Vec<u8>, Box<dyn Error>> {
    let mtx = MutableTransaction::with_entries(tx, entries);
    let reused = SigHashReusedValuesUnsync::new();
    let sig_hash = calc_schnorr_signature_hash(&mtx.as_verifiable(), idx, SIG_HASH_ALL, &reused);
    let msg = secp256k1::Message::from_digest_slice(sig_hash.as_bytes().as_slice())?;
    let mut sig = kp.sign_schnorr(msg).as_ref().to_vec();
    sig.push(SIG_HASH_ALL.to_u8()); // 65 bytes, never 64
    Ok(ScriptBuilder::new().add_data(&sig)?.drain())
}

async fn connect(url: &str) -> Result<KaspaRpcClient, Box<dyn Error>> {
    let client = KaspaRpcClient::new(WrpcEncoding::Borsh, Some(url), None, None, None)?;
    client.connect(None).await?;
    Ok(client)
}

async fn require_ready(client: &KaspaRpcClient) -> Result<u64, Box<dyn Error>> {
    let info = client.get_info().await?;
    if !info.is_utxo_indexed {
        return Err("node has no UTXO index — restart with --utxoindex".into());
    }
    if !info.is_synced {
        return Err("node is still syncing; wait for IBD before submitting".into());
    }
    Ok(client.get_block_dag_info().await?.virtual_daa_score)
}


// ---- shared spend construction ------------------------------------------
//
// `spend`, `inject` and `dry-run` ALL go through this. If the dry run built
// transactions its own way it would validate its own code rather than the
// code that actually submits — the same trap the harness's flip tests exist
// to avoid.

struct SpendPlan {
    agent: [u8; 32],
    root: [u8; 32],
    not_before: i64,
    expires_at: i64,
    cov: kaspa_consensus_core::Hash,
    outpoint: TransactionOutpoint,
    in_value: u64,
    block_daa: u64,
    is_coinbase: bool,
    claimed_daa: i64,
    amount: i64,
    injecting: bool,
    prev_spent: i64,
    prev_reserved: i64,
    prev_epoch_index: i64,
    prev_epoch_spent: i64,
}

/// Everything a build produced, not only the transaction. `golden` needs the
/// intermediates — the unsigned form, the digest that was actually signed, the
/// compiled contract — to write a vector another implementation can be checked
/// against. Every other command keeps using the two-value wrapper below, so
/// there is still exactly ONE construction path.
struct BuiltSpend {
    tx: Transaction,
    entry: UtxoEntry,
    /// The transaction as it stood when the digest was taken: identical to
    /// `tx` except the signature is 65 zero bytes. This is the form a second
    /// implementation can reproduce byte-for-byte without needing to match a
    /// randomised nonce.
    unsigned: Transaction,
    sighash: [u8; 32],
    signature: Vec<u8>,
    contract: CompiledContract<'static>,
    successor: CompiledContract<'static>,
    grant_spk: ScriptPublicKey,
    successor_spk: ScriptPublicKey,
    recipient: [u8; 32],
    sibs: Vec<[u8; 32]>,
    lefts: Vec<bool>,
    epoch_index: i64,
    epoch_spent: i64,
}

fn build_spend(plan: &SpendPlan, kp: &Keypair) -> Result<(Transaction, UtxoEntry), Box<dyn Error>> {
    let b = build_spend_full(plan, kp)?;
    Ok((b.tx, b.entry))
}

fn build_spend_full(plan: &SpendPlan, kp: &Keypair) -> Result<BuiltSpend, Box<dyn Error>> {
    let members = demo_recipients();
    let allowed = members[0];
    let recipient = if plan.injecting { attacker() } else { allowed };
    let epoch_index = (plan.claimed_daa - plan.not_before) / EPOCH_LENGTH;
    // A new epoch resets the epoch allowance; the same epoch accumulates.
    let epoch_spent_now =
        if epoch_index == plan.prev_epoch_index { plan.prev_epoch_spent } else { 0 };

    let contract = compile(grant_ctor(
        plan.agent, plan.agent, plan.root, plan.not_before, plan.expires_at,
        plan.prev_spent, plan.prev_reserved, plan.prev_epoch_index, plan.prev_epoch_spent,
    ))?;
    let grant_spk = pay_to_script_hash_script(&contract.bytecode);

    // The successor lives at a DIFFERENT address, one encoding the new state.
    let successor = compile(grant_ctor(
        plan.agent, plan.agent, plan.root, plan.not_before, plan.expires_at,
        plan.prev_spent + plan.amount, plan.prev_reserved,
        epoch_index, epoch_spent_now + plan.amount,
    ))?;
    let successor_spk = pay_to_script_hash_script(&successor.bytecode);

    // An unlisted payee has no proof; borrowing a valid one is the best an
    // attacker can do, and is exactly what a rogue agent would try.
    let (sibs, lefts) = merkle_proof(&members, &allowed);

    let mut p2pk = vec![0x20u8];
    p2pk.extend_from_slice(&recipient);
    p2pk.push(0xac);

    let entry = UtxoEntry::new(plan.in_value, grant_spk.clone(), plan.block_daa, plan.is_coinbase, Some(plan.cov));

    let make = |sig: Vec<u8>| -> Result<Transaction, Box<dyn Error>> {
        let args = vec![
            grant_state(
                plan.agent, plan.root, plan.not_before, plan.expires_at,
                plan.prev_spent + plan.amount, plan.prev_reserved,
                epoch_index, epoch_spent_now + plan.amount,
            ),
            Expr::int(plan.amount),
            Expr::bytes(recipient.to_vec()),
            byte32_array(sibs.clone()),
            bool_array(lefts.clone()),
            Expr::int(plan.claimed_daa),
            Expr::bytes(sig),
        ];
        let sigscript = covenant_sigscript(&contract, "spend", args)?;
        Ok(Transaction::new(
            1,
            vec![TransactionInput::new_with_compute_budget(plan.outpoint, sigscript, 0, SPEND_COMPUTE_BUDGET)],
            vec![
                TransactionOutput {
                    value: plan.in_value - plan.amount as u64 - SPEND_FEE,
                    script_public_key: successor_spk.clone(),
                    covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: plan.cov }),
                },
                TransactionOutput {
                    value: plan.amount as u64,
                    script_public_key: ScriptPublicKey::new(0, p2pk.clone().into()),
                    covenant: None,
                },
            ],
            plan.claimed_daa as u64,
            SUBNETWORK_ID_NATIVE,
            0,
            vec![],
        ))
    };

    let unsigned = make(vec![0u8; 65])?;
    let sighash = sighash_of(&unsigned, vec![entry.clone()], 0);
    let signature = sign_covenant(unsigned.clone(), vec![entry.clone()], 0, kp)?;
    let tx = make(signature.clone())?;
    Ok(BuiltSpend {
        tx,
        entry,
        unsigned,
        sighash,
        signature,
        contract,
        successor,
        grant_spk,
        successor_spk,
        recipient,
        sibs,
        lefts,
        epoch_index,
        epoch_spent: epoch_spent_now + plan.amount,
    })
}

// ---- shared genesis construction ----------------------------------------
//
// `genesis` and `golden` both go through this, for the same reason `spend`,
// `inject` and `dry-run` share build_spend: a golden vector produced by its
// own code path would validate that code path, not the one that submits.

struct GenesisPlan {
    agent: [u8; 32],
    principal: [u8; 32],
    root: [u8; 32],
    not_before: i64,
    expires_at: i64,
    funding_outpoint: TransactionOutpoint,
    funding_value: u64,
    funding_block_daa: u64,
    funding_is_coinbase: bool,
    grant_value: u64,
}

struct BuiltGenesis {
    tx: Transaction,
    entry: UtxoEntry,
    unsigned: Transaction,
    sighash: [u8; 32],
    signature_script: Vec<u8>,
    covenant_id: kaspa_consensus_core::Hash,
    contract: CompiledContract<'static>,
    grant_spk: ScriptPublicKey,
    change_spk: ScriptPublicKey,
    change_value: u64,
}

fn build_genesis(plan: &GenesisPlan, kp: &Keypair) -> Result<BuiltGenesis, Box<dyn Error>> {
    if plan.funding_value < plan.grant_value + GENESIS_FEE {
        return Err(format!(
            "funding {} is less than grant {} + fee {GENESIS_FEE}",
            plan.funding_value, plan.grant_value
        )
        .into());
    }

    let contract = compile(grant_ctor(
        plan.agent, plan.principal, plan.root, plan.not_before, plan.expires_at, 0, 0, 0, 0,
    ))?;
    let grant_spk = pay_to_script_hash_script(&contract.bytecode);
    let funding_addr = address_of(kp);
    let change_spk = pay_to_address_script(&funding_addr);
    let change_value = plan.funding_value - plan.grant_value - GENESIS_FEE;

    // Build the grant output UNBOUND first: covenant_id is derived from the
    // funding outpoint plus this output, so it cannot contain its own binding.
    // Then rebuild it carrying that id.
    let unbound =
        TransactionOutput { value: plan.grant_value, script_public_key: grant_spk.clone(), covenant: None };
    let covenant_id = covenant_id(plan.funding_outpoint, std::iter::once((0u32, &unbound)));

    let grant_out = TransactionOutput {
        value: plan.grant_value,
        script_public_key: grant_spk.clone(),
        covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id }),
    };
    let change_out =
        TransactionOutput { value: change_value, script_public_key: change_spk.clone(), covenant: None };

    let entry = UtxoEntry::new(
        plan.funding_value,
        change_spk.clone(),
        plan.funding_block_daa,
        plan.funding_is_coinbase,
        None,
    );

    // VERSION 1 — covenant bindings only enter the sighash at v1.
    let make = |sigscript: Vec<u8>| {
        Transaction::new(
            1,
            vec![TransactionInput::new_with_compute_budget(
                plan.funding_outpoint,
                sigscript,
                0,
                GENESIS_COMPUTE_BUDGET,
            )],
            vec![grant_out.clone(), change_out.clone()],
            0,
            SUBNETWORK_ID_NATIVE,
            0,
            vec![],
        )
    };

    let unsigned = make(vec![]);
    let sighash = sighash_of(&unsigned, vec![entry.clone()], 0);
    let signature_script = sign_p2pk(unsigned.clone(), vec![entry.clone()], 0, kp)?;
    let tx = make(signature_script.clone());

    Ok(BuiltGenesis {
        tx,
        entry,
        unsigned,
        sighash,
        signature_script,
        covenant_id,
        contract,
        grant_spk,
        change_spk,
        change_value,
    })
}

// ---- shared delegation construction -------------------------------------
//
// A 1:2 fanout: the parent continues at auth output 0, the child grant is
// created at auth output 1. Authority is subdivided, never created — the
// parent RESERVES exactly what the child receives, and real coins move with
// it. A child holding authority but no coins could pay nobody; a child holding
// coins but no reserve against its parent would double the tree's total.
//
// The child inherits the parent's COVENANT ID. Both outputs carry the same
// binding, which is what makes the lineage a single covenant rather than two
// unrelated ones that happen to look alike.

/// How a child narrows its parent. Every field here may only ever shrink.
struct ChildTerms {
    agent: [u8; 32],
    budget: i64,
    max_per_spend: i64,
    epoch_limit: i64,
    delegation_depth: i64,
}

struct DelegationPlan {
    agent: [u8; 32],
    principal: [u8; 32],
    root: [u8; 32],
    not_before: i64,
    expires_at: i64,
    cov: kaspa_consensus_core::Hash,
    outpoint: TransactionOutpoint,
    in_value: u64,
    block_daa: u64,
    is_coinbase: bool,
    prev_spent: i64,
    prev_reserved: i64,
    prev_epoch_index: i64,
    prev_epoch_spent: i64,
    child: ChildTerms,
}

struct BuiltDelegation {
    tx: Transaction,
    entry: UtxoEntry,
    unsigned: Transaction,
    sighash: [u8; 32],
    signature: Vec<u8>,
    contract: CompiledContract<'static>,
    parent_next: CompiledContract<'static>,
    child: CompiledContract<'static>,
    parent_spk: ScriptPublicKey,
    parent_next_spk: ScriptPublicKey,
    child_spk: ScriptPublicKey,
    parent_change: u64,
}

/// The child's constructor: the parent's, with the narrowed terms written over
/// it. Every field NOT overwritten is inherited, which is the safe default —
/// a field forgotten here is one the child shares with its parent rather than
/// one it invents for itself.
fn child_ctor(plan: &DelegationPlan) -> Vec<Expr<'static>> {
    let mut c = grant_ctor(
        plan.child.agent, plan.principal, plan.root, plan.not_before, plan.expires_at, 0, 0, 0, 0,
    );
    c[4] = Expr::int(plan.child.budget);
    c[5] = Expr::int(plan.child.max_per_spend);
    c[6] = Expr::int(plan.child.epoch_limit);
    c[11] = Expr::int(plan.child.delegation_depth);
    c
}

fn child_state(plan: &DelegationPlan) -> Expr<'static> {
    struct_object(
        "State",
        vec![
            ("agentKey", Expr::bytes(plan.child.agent.to_vec())),
            ("budgetTotal", Expr::int(plan.child.budget)),
            ("maxPerSpend", Expr::int(plan.child.max_per_spend)),
            ("epochLimit", Expr::int(plan.child.epoch_limit)),
            ("epochLength", Expr::int(EPOCH_LENGTH)),
            ("recipientsRoot", Expr::bytes(plan.root.to_vec())),
            ("notBefore", Expr::int(plan.not_before)),
            ("expiresAt", Expr::int(plan.expires_at)),
            ("delegationDepth", Expr::int(plan.child.delegation_depth)),
            // A child starts spent-out-of-nothing. Without this it could be
            // born mid-epoch with an allowance already used.
            ("spentTotal", Expr::int(0)),
            ("reserved", Expr::int(0)),
            ("epochIndex", Expr::int(0)),
            ("epochSpent", Expr::int(0)),
        ],
    )
}

fn build_delegation(plan: &DelegationPlan, kp: &Keypair) -> Result<BuiltDelegation, Box<dyn Error>> {
    let contract = compile(grant_ctor(
        plan.agent, plan.principal, plan.root, plan.not_before, plan.expires_at,
        plan.prev_spent, plan.prev_reserved, plan.prev_epoch_index, plan.prev_epoch_spent,
    ))?;
    let parent_spk = pay_to_script_hash_script(&contract.bytecode);

    // The parent only RESERVES. Nothing else about it may move, and the
    // covenant checks every other field for equality.
    let reserved_after = plan.prev_reserved + plan.child.budget;
    let parent_next = compile(grant_ctor(
        plan.agent, plan.principal, plan.root, plan.not_before, plan.expires_at,
        plan.prev_spent, reserved_after, plan.prev_epoch_index, plan.prev_epoch_spent,
    ))?;
    let parent_next_spk = pay_to_script_hash_script(&parent_next.bytecode);

    let child = compile(child_ctor(plan))?;
    let child_spk = pay_to_script_hash_script(&child.bytecode);

    let parent_change = plan
        .in_value
        .saturating_sub(plan.child.budget.max(0) as u64)
        .saturating_sub(SPEND_FEE);

    let entry =
        UtxoEntry::new(plan.in_value, parent_spk.clone(), plan.block_daa, plan.is_coinbase, Some(plan.cov));

    let parent_next_state = grant_state(
        plan.agent, plan.root, plan.not_before, plan.expires_at,
        plan.prev_spent, reserved_after, plan.prev_epoch_index, plan.prev_epoch_spent,
    );

    // `State[]` needs an explicit TypeRef: a custom struct element type cannot
    // be inferred from struct literals.
    let new_states = Expr::array(
        TypeRef { base: TypeBase::Custom("State".to_string()), array_dims: vec![ArrayDim::Dynamic] },
        vec![parent_next_state, child_state(plan)],
    );

    let make = |sig: Vec<u8>| -> Result<Transaction, Box<dyn Error>> {
        let args = vec![new_states.clone(), Expr::bytes(sig)];
        let sigscript = covenant_sigscript(&contract, "delegate", args)?;
        Ok(Transaction::new(
            1,
            vec![TransactionInput::new_with_compute_budget(plan.outpoint, sigscript, 0, SPEND_COMPUTE_BUDGET)],
            vec![
                TransactionOutput {
                    value: parent_change,
                    script_public_key: parent_next_spk.clone(),
                    covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: plan.cov }),
                },
                TransactionOutput {
                    value: plan.child.budget.max(0) as u64,
                    script_public_key: child_spk.clone(),
                    // The SAME covenant id. The child is a branch of this
                    // covenant's lineage, not a new covenant that resembles it.
                    covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id: plan.cov }),
                },
            ],
            0,
            SUBNETWORK_ID_NATIVE,
            0,
            vec![],
        ))
    };

    let unsigned = make(vec![0u8; 65])?;
    let sighash = sighash_of(&unsigned, vec![entry.clone()], 0);
    let signature = sign_covenant(unsigned.clone(), vec![entry.clone()], 0, kp)?;
    let tx = make(signature.clone())?;

    Ok(BuiltDelegation {
        tx,
        entry,
        unsigned,
        sighash,
        signature,
        contract,
        parent_next,
        child,
        parent_spk,
        parent_next_spk,
        child_spk,
        parent_change,
    })
}

/// The digest a signer must reproduce. At v1 this commits to the covenant
/// binding as well as the usual fields — SIGNING.md — which is the single
/// thing a second implementation is most likely to get wrong, and the reason
/// it is recorded in the golden vector on its own.
fn sighash_of(tx: &Transaction, entries: Vec<UtxoEntry>, idx: usize) -> [u8; 32] {
    let mtx = MutableTransaction::with_entries(tx.clone(), entries);
    let reused = SigHashReusedValuesUnsync::new();
    let verifiable = mtx.as_verifiable();
    calc_schnorr_signature_hash(&verifiable, idx, SIG_HASH_ALL, &reused).as_bytes()
}

/// Fixed, public, and never to be funded. A vector anyone can regenerate is
/// worth more than one only this machine can produce, so the golden spend is
/// signed with a key derived from a printed string rather than WARDA_SK.
fn golden_key() -> Keypair {
    let seed = b2b(&[b"warda-golden-vector-v1"]);
    Keypair::from_seckey_slice(&Secp256k1::new(), &seed).expect("valid golden key")
}

/// Runs a built transaction through the node's own script engine locally.
/// Same engine, same verdict, no network.
fn validate_locally(tx: &Transaction, entry: UtxoEntry) -> Result<(), TxScriptError> {
    let reused = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[0].clone();
    let populated = PopulatedTransaction::new(tx, vec![entry]);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    let utxo = populated.utxo(0).expect("utxo");
    let mut vm = TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        0,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused).with_covenants_ctx(&cov_ctx),
        EngineFlags { covenants_enabled: true, sigop_script_units: 0.into() },
    );
    vm.execute()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "status".into());
    let url = std::env::var("WARDA_RPC").unwrap_or_else(|_| DEFAULT_URL.to_string());

    match cmd.as_str() {
        "status" => {
            let client = connect(&url).await?;
            let info = client.get_info().await?;
            let dag = client.get_block_dag_info().await?;
            println!("server version : {}", info.server_version);
            println!("network        : {}", dag.network);
            println!("synced         : {}", info.is_synced);
            println!("utxo indexed   : {}", info.is_utxo_indexed);
            println!("virtual daa    : {}", dag.virtual_daa_score);
            if !info.is_synced {
                println!("\nstill syncing.");
            } else {
                println!("\nnode is ready.");
            }
        }

        "address" => {
            let kp = keypair()?;
            let addr = address_of(&kp);
            println!("{addr}");
            println!("\nfund this at https://faucet-tn10.kaspanet.io/");
        }

        "genesis" => {
            let kp = keypair()?;
            let client = connect(&url).await?;
            let daa = require_ready(&client).await?;

            let addr = address_of(&kp);
            let utxos = client.get_utxos_by_addresses(vec![addr.clone()]).await?;
            let funding = utxos
                .iter()
                .max_by_key(|u| u.utxo_entry.amount)
                .ok_or("no UTXOs at the funding address — use the faucet first")?;
            println!("funding utxo   : {} sompi", funding.utxo_entry.amount);

            let agent = kp.x_only_public_key().0.serialize();
            let root = merkle_root(&demo_recipients());
            // Window opens now and runs for ~1 day of DAA at 10 bps.
            let not_before = daa as i64;

            let plan = GenesisPlan {
                agent,
                principal: agent,
                root,
                not_before,
                expires_at: not_before + 864_000,
                funding_outpoint: TransactionOutpoint {
                    transaction_id: funding.outpoint.transaction_id,
                    index: funding.outpoint.index,
                },
                funding_value: funding.utxo_entry.amount,
                funding_block_daa: funding.utxo_entry.block_daa_score,
                funding_is_coinbase: funding.utxo_entry.is_coinbase,
                grant_value: BUDGET as u64,
            };

            let b = build_genesis(&plan, &kp)?;
            let grant_addr = extract_script_pub_key_address(&b.grant_spk, Prefix::Testnet)?;
            println!("covenant bytes : {}", b.contract.bytecode.len());
            println!("recipients root: {}", hex(&root));
            println!("not_before     : {not_before}");
            println!("expires_at     : {}", plan.expires_at);
            println!("grant address  : {grant_addr}");

            // The grant's ADDRESS is derived from its parameters, so losing
            // them strands the UTXO. Persist before submitting, not after —
            // a submit that succeeds while the write fails is unrecoverable.
            let cov = b.covenant_id;
            let manifest = format!(
                "{{\n  \"covenant_id\": \"{cov}\",\n  \"agent\": \"{}\",\n  \"recipients_root\": \"{}\",\n  \"not_before\": {not_before},\n  \"expires_at\": {},\n  \"budget\": {BUDGET},\n  \"max_per_spend\": {MAX_PER_SPEND},\n  \"epoch_limit\": {EPOCH_LIMIT},\n  \"epoch_length\": {EPOCH_LENGTH},\n  \"grant_value\": {},\n  \"spent_total\": 0,\n  \"reserved\": 0,\n  \"epoch_index\": 0,\n  \"epoch_spent\": 0\n}}\n",
                hex(&agent), hex(&root), plan.expires_at, plan.grant_value
            );
            std::fs::write("grant.json", &manifest)?;
            println!("wrote grant.json");
            println!("covenant id    : {cov}");
            let txid = client.submit_transaction((&b.tx).into(), false).await?;
            println!("\nsubmitted. txid: {}", txid);
        }

        cmd @ ("spend" | "inject") => {
            let injecting = cmd == "inject";
            let kp = keypair()?;
            let m = read_manifest()?;
            let client = connect(&url).await?;
            let daa = require_ready(&client).await?;

            let contract = compile(grant_ctor(
                m.agent, m.agent, m.root, m.not_before, m.expires_at,
                m.spent, m.reserved, m.epoch_index, m.epoch_spent,
            ))?;
            let grant_addr = extract_script_pub_key_address(
                &pay_to_script_hash_script(&contract.bytecode), Prefix::Testnet)?;
            println!("grant state    : spent {} / reserved {} / epoch {}",
                formatted(m.spent), formatted(m.reserved), m.epoch_index);
            println!("grant address  : {grant_addr}");

            let utxos = client.get_utxos_by_addresses(vec![grant_addr]).await?;
            let grant = utxos.first().ok_or("no UTXO at the grant address — has genesis confirmed?")?;
            println!("grant utxo     : {} sompi", grant.utxo_entry.amount);

            // Set claimedDaa slightly IN THE PAST.
            //
            // The covenant enforces `tx.daa >= claimedDaa`, which compiles to a
            // CLTV lock — so lock_time equal to the current DAA makes the
            // transaction not yet final and the mempool refuses it. Backing off
            // puts the lock behind the chain, and the transaction is spendable
            // immediately.
            //
            // Safe by construction: PHASE0 established that understating
            // claimedDaa only costs the agent epoch headroom, while
            // OVERstating is impossible because CLTV would hold the
            // transaction until the chain caught up. The direction that is
            // convenient here is also the direction that is sound.
            let claimed_daa = (daa as i64 - DAA_BACKOFF).max(m.not_before);
            if claimed_daa < m.not_before {
                return Err("current DAA precedes not_before".into());
            }
            println!("claimed daa    : {claimed_daa} (chain at {daa})");

            let plan = SpendPlan {
                agent: m.agent,
                root: m.root,
                not_before: m.not_before,
                expires_at: m.expires_at,
                cov: m.covenant_id.parse()?,
                prev_spent: m.spent,
                prev_reserved: m.reserved,
                prev_epoch_index: m.epoch_index,
                prev_epoch_spent: m.epoch_spent,
                outpoint: TransactionOutpoint {
                    transaction_id: grant.outpoint.transaction_id,
                    index: grant.outpoint.index,
                },
                in_value: grant.utxo_entry.amount,
                block_daa: grant.utxo_entry.block_daa_score,
                is_coinbase: grant.utxo_entry.is_coinbase,
                claimed_daa,
                amount: KAS / 2,
                injecting,
            };
            let (tx, entry) = build_spend(&plan, &kp)?;

            // Local verdict FIRST. If the engine refuses it here, the fault is
            // ours and the mempool would only tell us so less clearly.
            let local = validate_locally(&tx, entry);
            println!("local engine   : {local:?}");

            if injecting {
                println!("\n--- PROMPT INJECTION ---");
                println!("paying {} — NOT in the allowlist", hex(&attacker()));
                println!("the agent builds and signs this willingly; there is simply");
                println!("no proof that places the payee in the tree.\n");
                if local.is_ok() {
                    println!("UNEXPECTED: the local engine ACCEPTED the injection.");
                    println!("stopping before broadcast — investigate the allowlist.");
                    return Ok(());
                }
                println!("REJECTED locally, as designed. Broadcasting anyway so the");
                println!("network's own refusal is on the record.\n");
            } else {
                println!("\npaying {} KAS to an allowlisted API", plan.amount as f64 / KAS as f64);
                if local.is_err() {
                    return Err(format!("local engine refused a spend that should pass: {local:?}").into());
                }
            }

            match client.submit_transaction((&tx).into(), false).await {
                Ok(txid) => {
                    if injecting {
                        println!("UNEXPECTED: injection ACCEPTED by the network — txid {txid}");
                    } else {
                        println!("accepted. txid: {txid}");
                        // The grant has MOVED. Record where, or the next
                        // command looks at an address it has already left.
                        let ei = (plan.claimed_daa - m.not_before) / EPOCH_LENGTH;
                        let es = if ei == m.epoch_index { m.epoch_spent } else { 0 } + plan.amount;
                        let raw = std::fs::read_to_string("grant.json")?;
                        let updated = raw
                            .replace(&format!("\"spent_total\": {}", m.spent),
                                     &format!("\"spent_total\": {}", m.spent + plan.amount))
                            .replace(&format!("\"epoch_index\": {}", m.epoch_index),
                                     &format!("\"epoch_index\": {ei}"))
                            .replace(&format!("\"epoch_spent\": {}", m.epoch_spent),
                                     &format!("\"epoch_spent\": {es}"));
                        std::fs::write("grant.json", updated)?;
                        println!("grant.json updated — the grant now lives at a new address");
                    }
                }
                Err(e) => {
                    if injecting {
                        println!("REJECTED by consensus, as designed:\n  {e}");
                    } else {
                        println!("rejected: {e}");
                    }
                }
            }
        }


        "template" => {
            // Emits the covenant template the JS SDK needs.
            //
            // A grant's ADDRESS is P2SH(covenant compiled with its state), and
            // JavaScript cannot compile Silverscript. But every constructor
            // value lands in fixed-width slices of the bytecode, so JS can
            // splice new values into a template and hash the result.
            //
            // Two things this got wrong before, both worth stating plainly:
            //
            //   1. It probed only the 13 STATE fields. The principal and
            //      revocation keys are compiled in too — in the revoke and
            //      reclaim entrypoints — and without slots for them the SDK
            //      could only derive addresses for a grant whose principal key
            //      was literally the probe value. Every real address was
            //      wrong, and the self-check below could not see it because it
            //      also held those fields fixed. A check run with the varying
            //      part held constant measures the constant.
            //
            //   2. A field can appear MORE THAN ONCE. Taking first..last of
            //      the diff spans everything in between, including bytes that
            //      must not move. Occurrences are found as contiguous runs and
            //      exported individually.
            //
            // Offsets are derived by DIFFING, not by reading the compiler's
            // layout struct — if the encoding ever changes, this notices
            // instead of silently producing wrong addresses.
            let principal = [0x21u8; 32];
            let revocation = [0x23u8; 32];
            let agent = [0x22u8; 32];
            let root = [0x13u8; 32];
            let (nb, ex) = (1_000_000i64, 1_007_000i64);

            // Baseline constructor: distinct values in every key slot, so a
            // probe of one cannot be confused with another.
            let base_ctor = |sp: i64, rs: i64, ei: i64, es: i64| {
                let mut c = grant_ctor(agent, principal, root, nb, ex, sp, rs, ei, es);
                c[1] = Expr::bytes(revocation.to_vec()); // revocationKey, independent of principal
                c
            };

            let base = compile(base_ctor(0, 0, 0, 0))?;
            let layout = (base.state_layout.start, base.state_layout.len);
            println!("bytecode  : {} bytes", base.bytecode.len());
            println!("state slice: {}..{}", layout.0, layout.0 + layout.1);

            // Probe values must differ from the baseline in EVERY byte, or the
            // diff reports a narrower field than really exists and the SDK
            // splices into the wrong slot. A `+1` probe only moves the low
            // byte — which is exactly the bug this comment exists to prevent.
            const PROBE_INT: i64 = 0x0102_0304_0506_0708;

            // (name, group, kind, ctor index, probe). `authority` fields are
            // compiled-in constants outside the state slice; `state` fields
            // are the mutable ones the address moves with.
            let probes: Vec<(&str, &str, &str, usize, Expr)> = vec![
                ("principalKey", "authority", "bytes32", 0, Expr::bytes(vec![0x91; 32])),
                ("revocationKey", "authority", "bytes32", 1, Expr::bytes(vec![0x92; 32])),
                ("agentKey", "state", "bytes32", 3, Expr::bytes(vec![0x77; 32])),
                ("budgetTotal", "state", "int64", 4, Expr::int(PROBE_INT)),
                ("maxPerSpend", "state", "int64", 5, Expr::int(PROBE_INT)),
                ("epochLimit", "state", "int64", 6, Expr::int(PROBE_INT)),
                ("epochLength", "state", "int64", 7, Expr::int(PROBE_INT)),
                ("recipientsRoot", "state", "bytes32", 8, Expr::bytes(vec![0x88; 32])),
                ("notBefore", "state", "int64", 9, Expr::int(PROBE_INT)),
                ("expiresAt", "state", "int64", 10, Expr::int(PROBE_INT)),
                ("delegationDepth", "state", "int64", 11, Expr::int(PROBE_INT)),
                ("spentTotal", "state", "int64", 13, Expr::int(PROBE_INT)),
                ("reserved", "state", "int64", 14, Expr::int(PROBE_INT)),
                ("epochIndex", "state", "int64", 15, Expr::int(PROBE_INT)),
                ("epochSpent", "state", "int64", 16, Expr::int(PROBE_INT)),
            ];

            let mut fields = Vec::new();
            let mut slots: Vec<(String, &str, usize, Vec<usize>)> = Vec::new();
            let mut ok = true;
            for (name, group, kind, idx, probe) in probes {
                let expected_width = if kind == "bytes32" { 32 } else { 8 };
                let mut c = base_ctor(0, 0, 0, 0);
                c[idx] = probe;
                let v = compile(c)?;
                if v.bytecode.len() != base.bytecode.len() {
                    println!("{name:<16} LENGTH CHANGED — compiled in, not spliceable");
                    ok = false;
                    continue;
                }
                let diff: Vec<usize> = base.bytecode.iter().zip(v.bytecode.iter()).enumerate()
                    .filter(|(_, (x, y))| x != y).map(|(i, _)| i).collect();
                if diff.is_empty() {
                    println!("{name:<16} NO BYTES CHANGED — probe ineffective");
                    ok = false;
                    continue;
                }

                // Group the differing indices into contiguous runs; each run
                // is one occurrence of the field in the bytecode.
                let mut runs: Vec<(usize, usize)> = Vec::new();
                for i in diff {
                    match runs.last_mut() {
                        Some(last) if last.1 == i => last.1 = i + 1,
                        _ => runs.push((i, i + 1)),
                    }
                }
                let widths: Vec<usize> = runs.iter().map(|(a, b)| b - a).collect();
                if widths.iter().any(|w| *w != expected_width) {
                    println!("{name:<16} RUNS OF UNEXPECTED WIDTH {widths:?}, expected {expected_width}");
                    ok = false;
                    continue;
                }
                let offsets: Vec<usize> = runs.iter().map(|(a, _)| *a).collect();
                let inside = group != "state"
                    || offsets.iter().all(|a| *a >= layout.0 && a + expected_width <= layout.0 + layout.1);
                println!("{name:<16} {group:<9} width {expected_width:<2} x{} at {:?} {}",
                    offsets.len(), offsets,
                    if inside { "" } else { "OUTSIDE STATE SLICE" });
                if !inside { ok = false; }
                fields.push(format!(
                    "    {{ \"name\": \"{name}\", \"group\": \"{group}\", \"kind\": \"{kind}\", \"width\": {expected_width}, \"offsets\": [{}] }}",
                    offsets.iter().map(|o| o.to_string()).collect::<Vec<_>>().join(", ")));
                slots.push((name.to_string(), kind, expected_width, offsets));
            }

            // Two constructor values are deliberately absent above, and for
            // the same underlying reason: their encoded WIDTH depends on their
            // value, so they cannot occupy a fixed slot.
            //
            //   maxProofDepth sets the Merkle loop's unroll count, so a deeper
            //   grant is a longer program outright.
            //
            //   maxFee is pushed with Kaspa's minimal script-number encoding —
            //   5,000,000 takes three bytes, a larger value takes more. It
            //   looked spliceable only because every test used one value.
            //
            // Both are properties OF a template rather than values spliced
            // into one, so a grant that changes either needs its own template.
            // Demonstrated rather than asserted, so the claim keeps being true.
            {
                let mut c = base_ctor(0, 0, 0, 0);
                c[12] = Expr::int(MAX_PROOF_DEPTH + 1);
                let deeper = compile(c)?;
                println!("maxProofDepth    baked in: depth {} is {} bytes, depth {} is {} bytes",
                    MAX_PROOF_DEPTH, base.bytecode.len(), MAX_PROOF_DEPTH + 1, deeper.bytecode.len());
                if deeper.bytecode.len() == base.bytecode.len() {
                    println!("  (unexpected: proof depth no longer changes the bytecode — re-check this assumption)");
                }

                let mut c = base_ctor(0, 0, 0, 0);
                c[2] = Expr::int(PROBE_INT);
                let costly = compile(c)?;
                println!("maxFee           baked in: {} is {} bytes, a wider value is {} bytes",
                    MAX_FEE, base.bytecode.len(), costly.bytecode.len());
                if costly.bytecode.len() == base.bytecode.len() {
                    println!("  (unexpected: maxFee is now fixed-width — it could become a spliceable field)");
                }
            }

            let put = |buf: &mut Vec<u8>, name: &str, bytes: &[u8]| {
                if let Some((_, _, w, offsets)) = slots.iter().find(|(n, ..)| n == name) {
                    assert_eq!(bytes.len(), *w, "{name}: wrong width for splice");
                    for off in offsets { buf[*off..off + w].copy_from_slice(bytes); }
                }
            };

            // TRUST ANCHOR. The SDK splices values into this template and
            // derives addresses from the result. If splicing and compiling
            // ever disagree, every address the SDK computes is wrong and funds
            // go somewhere unspendable. So prove they agree, here, every time
            // the template is regenerated — and prove it while varying EVERY
            // field, authority included. Holding the authority fixed is what
            // hid a whole missing half of this manifest.
            let alt_principal = [0x41u8; 32];
            let alt_revocation = [0x42u8; 32];
            let alt_agent = [0x43u8; 32];
            let alt_root = [0x44u8; 32];
            let (alt_nb, alt_ex) = (2_500_000i64, 9_900_000i64);
            let (sp, rs, ei, es) = (3 * KAS, KAS, 7i64, KAS / 4);

            let mut alt_ctor = grant_ctor(alt_agent, alt_principal, alt_root, alt_nb, alt_ex, sp, rs, ei, es);
            alt_ctor[1] = Expr::bytes(alt_revocation.to_vec());
            let compiled = compile(alt_ctor)?;

            let mut spliced = base.bytecode.clone();
            put(&mut spliced, "principalKey", &alt_principal);
            put(&mut spliced, "revocationKey", &alt_revocation);
            put(&mut spliced, "agentKey", &alt_agent);
            put(&mut spliced, "recipientsRoot", &alt_root);
            for (name, v) in [
                ("budgetTotal", BUDGET), ("maxPerSpend", MAX_PER_SPEND),
                ("epochLimit", EPOCH_LIMIT), ("epochLength", EPOCH_LENGTH),
                ("notBefore", alt_nb), ("expiresAt", alt_ex), ("delegationDepth", DELEGATION_DEPTH),
                ("spentTotal", sp), ("reserved", rs), ("epochIndex", ei), ("epochSpent", es),
            ] {
                put(&mut spliced, name, &v.to_le_bytes());
            }

            if spliced == compiled.bytecode {
                println!("\nsplice == compile across authority AND state: byte-identical.");
            } else {
                let d: Vec<usize> = spliced.iter().zip(compiled.bytecode.iter()).enumerate()
                    .filter(|(_, (x, y))| x != y).map(|(i, _)| i).collect();
                println!("\nSPLICE DISAGREES WITH COMPILE at {} bytes: {:?}", d.len(),
                    &d[..d.len().min(12)]);
                println!("do NOT build the SDK on this template until the encoding is pinned.");
                ok = false;
            }

            // Known-good (authority + state -> address) vectors. These are
            // what prove the SDK agrees with the compiler. At least one MUST
            // vary the authority, or the vectors re-create the blind spot.
            let mut vectors = Vec::new();
            for (label, pk, rk, ak, rt, sp, rs, ei, es) in [
                ("zero", principal, revocation, agent, root, 0i64, 0i64, 0i64, 0i64),
                ("after_one_spend", principal, revocation, agent, root, KAS / 2, 0, 0, KAS / 2),
                ("with_reserve", principal, revocation, agent, root, KAS, 3 * KAS, 0, KAS),
                ("later_epoch", principal, revocation, agent, root, 2 * KAS, 0, 7, KAS / 4),
                ("other_principal", alt_principal, revocation, agent, root, 0, 0, 0, 0),
                ("other_revocation", principal, alt_revocation, agent, root, 0, 0, 0, 0),
                ("other_agent", principal, revocation, alt_agent, root, 0, 0, 0, 0),
                ("all_different", alt_principal, alt_revocation, alt_agent, alt_root, sp, rs, ei, es),
            ] {
                let mut c = grant_ctor(ak, pk, rt, nb, ex, sp, rs, ei, es);
                c[1] = Expr::bytes(rk.to_vec());
                let c = compile(c)?;
                let spk = pay_to_script_hash_script(&c.bytecode);
                let addr = extract_script_pub_key_address(&spk, Prefix::Testnet)?;
                // The script hash is what JS can verify without porting
                // Kaspa's bech32. kaspa-wasm turns a hash into an address;
                // reimplementing that in the SDK would buy nothing but bugs.
                let script_hash = blake2b_simd::Params::new().hash_length(32)
                    .to_state().update(&c.bytecode).finalize();
                vectors.push(format!(
                    "    {{ \"label\": \"{label}\", \"authority\": {{ \"principalKey\": \"{}\", \"revocationKey\": \"{}\" }}, \"state\": {{ \"agentKey\": \"{}\", \"budgetTotal\": {BUDGET}, \"maxPerSpend\": {MAX_PER_SPEND}, \"epochLimit\": {EPOCH_LIMIT}, \"epochLength\": {EPOCH_LENGTH}, \"recipientsRoot\": \"{}\", \"notBefore\": {nb}, \"expiresAt\": {ex}, \"delegationDepth\": {DELEGATION_DEPTH}, \"spentTotal\": {sp}, \"reserved\": {rs}, \"epochIndex\": {ei}, \"epochSpent\": {es} }}, \"scriptHash\": \"{}\", \"address\": \"{addr}\" }}",
                    hex(&pk), hex(&rk), hex(&ak), hex(&rt), hex(script_hash.as_bytes())));
                println!("{label:<17} {}  {addr}", &hex(script_hash.as_bytes())[..16]);
            }

            let manifest = format!(
"{{
  \"bytecodeLen\": {},
  \"baked\": {{
    \"_comment\": \"Compiled in, not spliced. Both have value-dependent widths, so they cannot occupy a fixed slot: maxProofDepth sets the Merkle loop's unroll count, and maxFee uses minimal script-number encoding. A grant that changes either needs its own template.\",
    \"maxProofDepth\": {},
    \"maxFee\": {}
  }},
  \"stateStart\": {},
  \"stateLen\": {},
  \"baselineHex\": \"{}\",
  \"baseline\": {{
    \"_comment\": \"The values the baseline was compiled with. Probe constants, never keys. Splice over every one of them.\",
    \"principalKey\": \"{}\",
    \"revocationKey\": \"{}\",
    \"agentKey\": \"{}\",
    \"recipientsRoot\": \"{}\",
    \"notBefore\": {},
    \"expiresAt\": {}
  }},
  \"fields\": [
{}
  ],
  \"addressVectors\": [
{}
  ]
}}
",
                base.bytecode.len(), MAX_PROOF_DEPTH, MAX_FEE, layout.0, layout.1,
                // The FULL baseline, not prefix+suffix. The state region has
                // push opcodes interleaved between field slots; exporting only
                // the ends would leave them zeroed and silently produce wrong
                // addresses. Splice into a copy of this.
                hex(&base.bytecode),
                hex(&principal), hex(&revocation), hex(&agent), hex(&root), nb, ex,
                fields.join(",\n"), vectors.join(",\n"));

            std::fs::write("covenant-template.json", &manifest)?;
            println!("\nwrote covenant-template.json");
            if ok {
                println!("every field is a fixed-width slice, and splicing reproduces the compiler.");
                println!("a JS SDK can derive grant addresses with no compiler.");
            } else {
                println!("SOME FIELDS DO NOT SPLICE CLEANLY — see above. Do not ship the SDK on this.");
                std::process::exit(1);
            }
        }

        "golden" => {
            // A reference transaction for cross-implementation testing.
            //
            // These bytes come from the same build_spend_full() that produced
            // the spend testnet-10 accepted, so an implementation that
            // reproduces them is reproducing something the network has already
            // validated — not agreeing with a second guess.
            //
            // Duplicating the RULES in another language would be dangerous: a
            // divergence there fails by wrongly PERMITTING. Duplicating
            // ASSEMBLY is safe: a divergence fails by producing a transaction
            // the network rejects. This vector is what turns the second kind
            // of failure from a testnet surprise into a unit test.
            //
            // The signature is deliberately not the thing being compared —
            // schnorr signing draws a random nonce, so two correct
            // implementations produce different bytes. What IS compared is the
            // unsigned sigscript (every argument, serialized) and the sighash
            // (the digest, which commits to the covenant binding). Get those
            // right and the signature is correct by construction.
            let kp = golden_key();
            let agent = kp.x_only_public_key().0.serialize();
            let members = demo_recipients();
            let root = merkle_root(&members);
            let not_before = 1_000_000i64;
            let claimed_daa = not_before + 500;
            let amount = KAS / 2;
            let cov = kaspa_consensus_core::Hash::from_bytes([7u8; 32]);
            let outpoint = TransactionOutpoint {
                transaction_id: kaspa_consensus_core::Hash::from_bytes([9u8; 32]),
                index: 0,
            };
            let plan = SpendPlan {
                agent,
                root,
                not_before,
                expires_at: not_before + 864_000,
                cov,
                outpoint,
                in_value: BUDGET as u64,
                block_daa: not_before as u64,
                is_coinbase: false,
                claimed_daa,
                amount,
                injecting: false,
                prev_spent: 0,
                prev_reserved: 0,
                prev_epoch_index: 0,
                prev_epoch_spent: 0,
            };

            let b = build_spend_full(&plan, &kp)?;

            // A vector that the engine would refuse is worse than no vector:
            // it would teach a second implementation to be wrong confidently.
            let verdict = validate_locally(&b.tx, b.entry.clone());
            println!("reference spend -> {verdict:?}");
            if verdict.is_err() {
                return Err("refusing to write a golden vector the engine rejects".into());
            }

            let grant_addr = extract_script_pub_key_address(&b.grant_spk, Prefix::Testnet)?;
            let succ_addr = extract_script_pub_key_address(&b.successor_spk, Prefix::Testnet)?;

            // The ABI, so the vector describes its own argument layout rather
            // than making a second implementation guess at it. The dispatch tag
            // is the first 4 bytes of blake3("name(type,type,...)") — derived
            // from these strings, so a rename here changes the tag and every
            // spend built against the old one stops dispatching.
            let entry = b
                .contract
                .entry_by_name("__covenant_entrypoint_auth_spend")
                .ok_or("compiled contract has no auth_spend entrypoint")?;
            let abi_inputs = entry
                .inputs
                .iter()
                .map(|i| format!("      {{ \"name\": \"{}\", \"typeName\": \"{}\" }}", i.name, i.type_name))
                .collect::<Vec<_>>()
                .join(",\n");
            let dispatch_tag = hex(&entry.dispatch_tag());

            let hexlist = |v: &[[u8; 32]]| -> String {
                v.iter().map(|x| format!("\"{}\"", hex(x))).collect::<Vec<_>>().join(", ")
            };
            let boollist = |v: &[bool]| -> String {
                v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(", ")
            };
            let outputs = b
                .tx
                .outputs
                .iter()
                .map(|o| {
                    let covenant = match &o.covenant {
                        Some(c) => format!(
                            "{{ \"authorizingInput\": {}, \"covenantId\": \"{}\" }}",
                            c.authorizing_input, c.covenant_id
                        ),
                        None => "null".to_string(),
                    };
                    format!(
                        "    {{ \"value\": {}, \"scriptPublicKeyVersion\": {}, \"scriptPublicKeyHex\": \"{}\", \"covenant\": {} }}",
                        o.value,
                        o.script_public_key.version(),
                        hex(o.script_public_key.script()),
                        covenant
                    )
                })
                .collect::<Vec<_>>()
                .join(",\n");

            let json = format!(
r#"{{
  "note": "Reference spend for cross-implementation testing. Produced by the same construction path as the transaction testnet-10 accepted. Compare unsignedSignatureScriptHex and sighashHex; the signature itself is nondeterministic and is recorded for reference only.",
  "generatedBy": "warda-deploy golden",
  "network": "kaspatest",

  "key": {{
    "_comment": "Fixed and public. NEVER FUND THIS. Derived from blake2b-256(\"warda-golden-vector-v1\") so any implementation can regenerate the whole vector.",
    "secretHex": "{sk}",
    "xonlyPublicHex": "{agent}"
  }},

  "params": {{
    "principalKey": "{agent}",
    "revocationKey": "{agent}",
    "agentKey": "{agent}",
    "maxFee": {max_fee},
    "budgetTotal": {budget},
    "maxPerSpend": {max_per_spend},
    "epochLimit": {epoch_limit},
    "epochLength": {epoch_length},
    "recipientsRoot": "{root}",
    "notBefore": {not_before},
    "expiresAt": {expires_at},
    "delegationDepth": {deleg_depth},
    "maxProofDepth": {max_proof_depth},
    "prevState": {{ "spentTotal": 0, "reserved": 0, "epochIndex": 0, "epochSpent": 0 }},
    "nextState": {{ "spentTotal": {next_spent}, "reserved": 0, "epochIndex": {next_epoch}, "epochSpent": {next_epoch_spent} }}
  }},

  "abi": {{
    "entrypoint": "{abi_name}",
    "dispatchTag": "{dispatch_tag}",
    "inputs": [
{abi_inputs}
    ]
  }},

  "recipients": {{
    "_comment": "Unsorted as given; the tree sorts canonically before hashing.",
    "members": [{members}],
    "target": "{recipient}",
    "proof": {{ "siblings": [{sibs}], "left": [{lefts}] }}
  }},

  "spend": {{
    "amount": {amount},
    "claimedDaa": {claimed_daa},
    "fee": {fee},
    "computeBudget": {compute_budget}
  }},

  "grant": {{
    "redeemScriptHex": "{redeem}",
    "scriptPublicKeyHex": "{grant_spk}",
    "address": "{grant_addr}"
  }},

  "successor": {{
    "_comment": "A different address: the state is part of what the address commits to, so spending MOVES the grant.",
    "redeemScriptHex": "{succ_redeem}",
    "scriptPublicKeyHex": "{succ_spk}",
    "address": "{succ_addr}"
  }},

  "utxo": {{
    "outpointTransactionId": "{op_txid}",
    "outpointIndex": {op_index},
    "value": {in_value},
    "scriptPublicKeyVersion": 0,
    "scriptPublicKeyHex": "{grant_spk}",
    "blockDaaScore": {block_daa},
    "isCoinbase": false,
    "covenantId": "{cov}"
  }},

  "transaction": {{
    "version": 1,
    "lockTime": {claimed_daa},
    "subnetworkId": "0000000000000000000000000000000000000000",
    "gas": 0,
    "payloadHex": "",
    "input": {{
      "_comment": "A version-1 input commits to a COMPUTE BUDGET, not a sigop count; the sigop field does not exist on it.",
      "sequence": {sequence},
      "computeBudget": {input_budget}
    }},
    "outputs": [
{outputs}
    ],
    "txid": "{txid}"
  }},

  "unsignedSignatureScriptHex": "{unsigned_ss}",
  "sighashHex": "{sighash}",
  "signatureHex": "{signature}",
  "signedSignatureScriptHex": "{signed_ss}"
}}
"#,
                sk = hex(&kp.secret_key().secret_bytes()),
                agent = hex(&agent),
                max_fee = MAX_FEE,
                budget = BUDGET,
                max_per_spend = MAX_PER_SPEND,
                epoch_limit = EPOCH_LIMIT,
                epoch_length = EPOCH_LENGTH,
                root = hex(&root),
                not_before = not_before,
                expires_at = plan.expires_at,
                deleg_depth = DELEGATION_DEPTH,
                max_proof_depth = MAX_PROOF_DEPTH,
                next_spent = amount,
                next_epoch = b.epoch_index,
                next_epoch_spent = b.epoch_spent,
                abi_name = entry.name,
                dispatch_tag = dispatch_tag,
                abi_inputs = abi_inputs,
                members = hexlist(&members),
                recipient = hex(&b.recipient),
                sibs = hexlist(&b.sibs),
                lefts = boollist(&b.lefts),
                amount = amount,
                claimed_daa = claimed_daa,
                fee = SPEND_FEE,
                compute_budget = SPEND_COMPUTE_BUDGET,
                redeem = hex(&b.contract.bytecode),
                grant_spk = hex(b.grant_spk.script()),
                grant_addr = grant_addr,
                succ_redeem = hex(&b.successor.bytecode),
                succ_spk = hex(b.successor_spk.script()),
                succ_addr = succ_addr,
                op_txid = plan.outpoint.transaction_id,
                op_index = plan.outpoint.index,
                in_value = plan.in_value,
                block_daa = plan.block_daa,
                cov = cov,
                sequence = b.tx.inputs[0].sequence,
                input_budget = b.tx.inputs[0].compute_commit.compute_budget().unwrap_or_default(),
                outputs = outputs,
                txid = b.tx.id(),
                unsigned_ss = hex(&b.unsigned.inputs[0].signature_script),
                sighash = hex(&b.sighash),
                signature = hex(&b.signature),
                signed_ss = hex(&b.tx.inputs[0].signature_script),
            );

            std::fs::write("golden-spend.json", &json)?;
            println!("wrote golden-spend.json");
            println!("  redeem script : {} bytes", b.contract.bytecode.len());
            println!("  unsigned sigscript: {} bytes", b.unsigned.inputs[0].signature_script.len());
            println!("  sighash       : {}", hex(&b.sighash));
            println!("  txid          : {}", b.tx.id());

            // ---- and the genesis that creates a grant in the first place ----
            //
            // Spending is only half the protocol. Until a second
            // implementation can ISSUE a grant, a principal still needs the
            // Rust tool, and "an agent can be given a budget" is not something
            // an application can do on its own.
            //
            // The chicken-and-egg here is the part worth pinning: the grant
            // output's covenant binding contains a covenant id derived from
            // the funding outpoint and that same output — so the id is
            // computed over the output WITHOUT its binding, then written into
            // it. Get that order wrong and the id is self-referential and
            // wrong, with nothing to indicate which of the two it was.
            let gplan = GenesisPlan {
                agent,
                principal: agent,
                root,
                not_before,
                expires_at: not_before + 864_000,
                funding_outpoint: TransactionOutpoint {
                    transaction_id: kaspa_consensus_core::Hash::from_bytes([0x5au8; 32]),
                    index: 1,
                },
                funding_value: (BUDGET as u64) + GENESIS_FEE + 25 * (KAS as u64),
                funding_block_daa: not_before as u64,
                funding_is_coinbase: false,
                grant_value: BUDGET as u64,
            };
            let g = build_genesis(&gplan, &kp)?;
            let funding_addr = address_of(&kp);
            let genesis_grant_addr = extract_script_pub_key_address(&g.grant_spk, Prefix::Testnet)?;

            let genesis_json = format!(
r#"{{
  "note": "Reference genesis: the transaction that CREATES a grant. Produced by the same build_genesis() the deploy tool submits. Compare the unsigned transaction and the sighash; the signature is nondeterministic.",
  "generatedBy": "warda-deploy golden",
  "network": "kaspatest",

  "key": {{
    "_comment": "Fixed and public. NEVER FUND THIS.",
    "secretHex": "{sk}",
    "xonlyPublicHex": "{agent}"
  }},

  "params": {{
    "principalKey": "{agent}",
    "revocationKey": "{agent}",
    "agentKey": "{agent}",
    "maxFee": {max_fee},
    "budgetTotal": {budget},
    "maxPerSpend": {max_per_spend},
    "epochLimit": {epoch_limit},
    "epochLength": {epoch_length},
    "recipientsRoot": "{root}",
    "notBefore": {not_before},
    "expiresAt": {expires_at},
    "delegationDepth": {deleg_depth},
    "initialState": {{ "spentTotal": 0, "reserved": 0, "epochIndex": 0, "epochSpent": 0 }}
  }},

  "funding": {{
    "_comment": "An ordinary P2PK wallet UTXO. Genesis is a normal spend that happens to pay into a covenant.",
    "outpointTransactionId": "{f_txid}",
    "outpointIndex": {f_index},
    "value": {f_value},
    "scriptPublicKeyVersion": 0,
    "scriptPublicKeyHex": "{f_spk}",
    "address": "{f_addr}",
    "blockDaaScore": {f_daa},
    "isCoinbase": false,
    "covenantId": null
  }},

  "grant": {{
    "redeemScriptHex": "{redeem}",
    "scriptPublicKeyHex": "{g_spk}",
    "address": "{g_addr}",
    "value": {g_value}
  }},

  "covenantId": {{
    "_comment": "blake2b-256 keyed with \"CovenantID\" over the funding outpoint and the authorized outputs, each WITHOUT its covenant binding. Computed first, then written into the binding.",
    "value": "{cov}"
  }},

  "spend": {{
    "fee": {fee},
    "computeBudget": {compute_budget},
    "changeValue": {change}
  }},

  "transaction": {{
    "version": 1,
    "lockTime": 0,
    "subnetworkId": "0000000000000000000000000000000000000000",
    "gas": 0,
    "payloadHex": "",
    "input": {{
      "sequence": {sequence},
      "computeBudget": {input_budget}
    }},
    "outputs": [
{outputs}
    ],
    "txid": "{txid}"
  }},

  "unsignedSignatureScriptHex": "",
  "sighashHex": "{sighash}",
  "signedSignatureScriptHex": "{signed_ss}"
}}
"#,
                sk = hex(&kp.secret_key().secret_bytes()),
                agent = hex(&agent),
                max_fee = MAX_FEE,
                budget = BUDGET,
                max_per_spend = MAX_PER_SPEND,
                epoch_limit = EPOCH_LIMIT,
                epoch_length = EPOCH_LENGTH,
                root = hex(&root),
                not_before = not_before,
                expires_at = gplan.expires_at,
                deleg_depth = DELEGATION_DEPTH,
                f_txid = gplan.funding_outpoint.transaction_id,
                f_index = gplan.funding_outpoint.index,
                f_value = gplan.funding_value,
                f_spk = hex(g.change_spk.script()),
                f_addr = funding_addr,
                f_daa = gplan.funding_block_daa,
                redeem = hex(&g.contract.bytecode),
                g_spk = hex(g.grant_spk.script()),
                g_addr = genesis_grant_addr,
                g_value = gplan.grant_value,
                cov = g.covenant_id,
                fee = GENESIS_FEE,
                compute_budget = GENESIS_COMPUTE_BUDGET,
                change = g.change_value,
                sequence = g.tx.inputs[0].sequence,
                input_budget = g.tx.inputs[0].compute_commit.compute_budget().unwrap_or_default(),
                outputs = g
                    .tx
                    .outputs
                    .iter()
                    .map(|o| {
                        let covenant = match &o.covenant {
                            Some(c) => format!(
                                "{{ \"authorizingInput\": {}, \"covenantId\": \"{}\" }}",
                                c.authorizing_input, c.covenant_id
                            ),
                            None => "null".to_string(),
                        };
                        format!(
                            "    {{ \"value\": {}, \"scriptPublicKeyVersion\": {}, \"scriptPublicKeyHex\": \"{}\", \"covenant\": {} }}",
                            o.value,
                            o.script_public_key.version(),
                            hex(o.script_public_key.script()),
                            covenant
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",\n"),
                txid = g.tx.id(),
                sighash = hex(&g.sighash),
                signed_ss = hex(&g.signature_script),
            );

            std::fs::write("golden-genesis.json", &genesis_json)?;
            println!("\nwrote golden-genesis.json");
            println!("  covenant id   : {}", g.covenant_id);
            println!("  grant address : {genesis_grant_addr}");
            println!("  sighash       : {}", hex(&g.sighash));
            println!("  txid          : {}", g.tx.id());

            // ---- and delegation, the half that makes this more than a cap ----
            //
            // Every value in a delegation's sigscript is encoded differently
            // from a spend's, and not because anything about State changed.
            // `delegate` takes `State[]`, and the compiler TRANSPOSES a struct
            // array: it emits one push per FIELD holding that field's value
            // across every element, so `State[2]` is thirteen pushes rather
            // than two. Inside those arrays every element must be one width,
            // so integers are fixed at 8 bytes little-endian — the opposite of
            // the minimal script numbers a scalar State uses.
            //
            // A second implementation that laid the two states out one after
            // the other would produce the same total byte count with every
            // value in the wrong place. That is precisely the kind of mistake
            // a vector catches and a code review does not.
            let dplan = DelegationPlan {
                agent,
                principal: agent,
                root,
                not_before,
                expires_at: not_before + 864_000,
                cov,
                outpoint,
                in_value: BUDGET as u64,
                block_daa: not_before as u64,
                is_coinbase: false,
                prev_spent: 0,
                prev_reserved: 0,
                prev_epoch_index: 0,
                prev_epoch_spent: 0,
                child: ChildTerms {
                    agent: [0x99u8; 32],
                    budget: 4 * KAS,
                    max_per_spend: KAS,
                    epoch_limit: 2 * KAS,
                    delegation_depth: DELEGATION_DEPTH - 1,
                },
            };
            let d = build_delegation(&dplan, &kp)?;

            let dverdict = validate_locally(&d.tx, d.entry.clone());
            println!("\nreference delegation -> {dverdict:?}");
            if dverdict.is_err() {
                return Err("refusing to write a delegation vector the engine rejects".into());
            }

            let dentry = d
                .contract
                .entry_by_name("__covenant_entrypoint_auth_delegate")
                .ok_or("compiled contract has no auth_delegate entrypoint")?;
            let dabi_inputs = dentry
                .inputs
                .iter()
                .map(|i| format!("      {{ \"name\": \"{}\", \"typeName\": \"{}\" }}", i.name, i.type_name))
                .collect::<Vec<_>>()
                .join(",\n");

            let parent_addr = extract_script_pub_key_address(&d.parent_spk, Prefix::Testnet)?;
            let parent_next_addr = extract_script_pub_key_address(&d.parent_next_spk, Prefix::Testnet)?;
            let child_addr = extract_script_pub_key_address(&d.child_spk, Prefix::Testnet)?;

            let delegation_json = format!(
r#"{{
  "note": "Reference delegation: a 1:2 fanout that subdivides a grant. Parent continues at output 0, child is created at output 1. Produced by the same build_delegation() the deploy tool uses.",
  "generatedBy": "warda-deploy golden",
  "network": "kaspatest",

  "key": {{
    "_comment": "Fixed and public. NEVER FUND THIS.",
    "secretHex": "{sk}",
    "xonlyPublicHex": "{agent}"
  }},

  "abi": {{
    "entrypoint": "{dabi_name}",
    "dispatchTag": "{ddispatch}",
    "inputs": [
{dabi_inputs}
    ]
  }},

  "params": {{
    "principalKey": "{agent}",
    "revocationKey": "{agent}",
    "agentKey": "{agent}",
    "budgetTotal": {budget},
    "maxPerSpend": {max_per_spend},
    "epochLimit": {epoch_limit},
    "epochLength": {epoch_length},
    "recipientsRoot": "{root}",
    "notBefore": {not_before},
    "expiresAt": {expires_at},
    "delegationDepth": {deleg_depth},
    "prevState": {{ "spentTotal": 0, "reserved": 0, "epochIndex": 0, "epochSpent": 0 }}
  }},

  "child": {{
    "_comment": "Every term may only ever shrink. Fields not listed are inherited from the parent, which is the safe default: a forgotten field is one the child SHARES rather than one it invents.",
    "agentKey": "{child_agent}",
    "budgetTotal": {child_budget},
    "maxPerSpend": {child_max_per_spend},
    "epochLimit": {child_epoch_limit},
    "delegationDepth": {child_depth}
  }},

  "conservation": {{
    "_comment": "The parent RESERVES exactly what the child receives, and coins move with it. Reserve without coins and the child can pay nobody; coins without reserve and the same KAS is spendable twice, from two addresses, both legitimately.",
    "parentReservedBefore": 0,
    "parentReservedAfter": {reserved_after},
    "childBudget": {child_budget},
    "childOutputValue": {child_budget}
  }},

  "parent": {{
    "redeemScriptHex": "{parent_redeem}",
    "scriptPublicKeyHex": "{parent_spk}",
    "address": "{parent_addr}"
  }},

  "parentSuccessor": {{
    "redeemScriptHex": "{parent_next_redeem}",
    "scriptPublicKeyHex": "{parent_next_spk}",
    "address": "{parent_next_addr}"
  }},

  "childGrant": {{
    "_comment": "Shares the parent's AUTHORITY — same principal, same revocation key. Delegation subdivides an agent's budget; it does not hand over the right to revoke or reclaim.",
    "redeemScriptHex": "{child_redeem}",
    "scriptPublicKeyHex": "{child_spk}",
    "address": "{child_addr}"
  }},

  "utxo": {{
    "outpointTransactionId": "{op_txid}",
    "outpointIndex": {op_index},
    "value": {in_value},
    "scriptPublicKeyVersion": 0,
    "scriptPublicKeyHex": "{parent_spk}",
    "blockDaaScore": {block_daa},
    "isCoinbase": false,
    "covenantId": "{cov}"
  }},

  "spend": {{
    "fee": {fee},
    "computeBudget": {compute_budget},
    "parentChange": {parent_change}
  }},

  "transaction": {{
    "version": 1,
    "_lockTime": "Zero. A delegation makes no claim about the chain's height; only a spend needs to, because only a spend consumes an epoch allowance.",
    "lockTime": 0,
    "subnetworkId": "0000000000000000000000000000000000000000",
    "gas": 0,
    "payloadHex": "",
    "input": {{
      "sequence": {dsequence},
      "computeBudget": {dinput_budget}
    }},
    "outputs": [
{doutputs}
    ],
    "txid": "{dtxid}"
  }},

  "unsignedSignatureScriptHex": "{dunsigned_ss}",
  "sighashHex": "{dsighash}",
  "signatureHex": "{dsignature}",
  "signedSignatureScriptHex": "{dsigned_ss}"
}}
"#,
                sk = hex(&kp.secret_key().secret_bytes()),
                agent = hex(&agent),
                dabi_name = dentry.name,
                ddispatch = hex(&dentry.dispatch_tag()),
                dabi_inputs = dabi_inputs,
                budget = BUDGET,
                max_per_spend = MAX_PER_SPEND,
                epoch_limit = EPOCH_LIMIT,
                epoch_length = EPOCH_LENGTH,
                root = hex(&root),
                not_before = not_before,
                expires_at = dplan.expires_at,
                deleg_depth = DELEGATION_DEPTH,
                child_agent = hex(&dplan.child.agent),
                child_budget = dplan.child.budget,
                child_max_per_spend = dplan.child.max_per_spend,
                child_epoch_limit = dplan.child.epoch_limit,
                child_depth = dplan.child.delegation_depth,
                reserved_after = dplan.prev_reserved + dplan.child.budget,
                parent_redeem = hex(&d.contract.bytecode),
                parent_spk = hex(d.parent_spk.script()),
                parent_addr = parent_addr,
                parent_next_redeem = hex(&d.parent_next.bytecode),
                parent_next_spk = hex(d.parent_next_spk.script()),
                parent_next_addr = parent_next_addr,
                child_redeem = hex(&d.child.bytecode),
                child_spk = hex(d.child_spk.script()),
                child_addr = child_addr,
                op_txid = dplan.outpoint.transaction_id,
                op_index = dplan.outpoint.index,
                in_value = dplan.in_value,
                block_daa = dplan.block_daa,
                cov = dplan.cov,
                fee = SPEND_FEE,
                compute_budget = SPEND_COMPUTE_BUDGET,
                parent_change = d.parent_change,
                dsequence = d.tx.inputs[0].sequence,
                dinput_budget = d.tx.inputs[0].compute_commit.compute_budget().unwrap_or_default(),
                doutputs = d
                    .tx
                    .outputs
                    .iter()
                    .map(|o| {
                        let covenant = match &o.covenant {
                            Some(c) => format!(
                                "{{ \"authorizingInput\": {}, \"covenantId\": \"{}\" }}",
                                c.authorizing_input, c.covenant_id
                            ),
                            None => "null".to_string(),
                        };
                        format!(
                            "    {{ \"value\": {}, \"scriptPublicKeyVersion\": {}, \"scriptPublicKeyHex\": \"{}\", \"covenant\": {} }}",
                            o.value,
                            o.script_public_key.version(),
                            hex(o.script_public_key.script()),
                            covenant
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",\n"),
                dtxid = d.tx.id(),
                dunsigned_ss = hex(&d.unsigned.inputs[0].signature_script),
                dsighash = hex(&d.sighash),
                dsignature = hex(&d.signature),
                dsigned_ss = hex(&d.tx.inputs[0].signature_script),
            );

            std::fs::write("golden-delegation.json", &delegation_json)?;
            println!("\nwrote golden-delegation.json");
            println!("  parent    : {parent_addr}");
            println!("  successor : {parent_next_addr}  (reserved {} KAS)", dplan.child.budget / KAS);
            println!("  child     : {child_addr}  (budget {} KAS)", dplan.child.budget / KAS);
            println!("  sigscript : {} bytes", d.unsigned.inputs[0].signature_script.len());
            println!("  txid      : {}", d.tx.id());
        }

        cmd @ ("verify" | "submit" | "advance") => {
            // Runs a transaction built ELSEWHERE through the real script engine,
            // and optionally puts it on the network.
            //
            // Why this exists, given the golden vector already exists: passing
            // the golden test proves the JS SDK agrees with a file we also
            // wrote. It does not prove the CONSENSUS ENGINE agrees with either
            // of us — a shared misreading of the spec satisfies both. Feeding
            // JavaScript's output to the same TxScriptEngine a node runs turns
            // "matches our reference" into "the engine accepts it".
            let path = std::env::args().nth(2).unwrap_or_else(|| "js-spend.json".into());
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| format!("cannot read {path}: {e}"))?;
            let v: serde_json::Value = serde_json::from_str(&raw)?;

            let (tx, entry) = parse_wire(&v)?;

            // The builder states what IT thinks the id is. Recomputing it here
            // catches a serialization disagreement before anything is signed
            // into a chain, where it would present as an unexplained rejection.
            if let Some(claimed) = v.get("txid").and_then(|t| t.as_str()) {
                let actual = tx.id().to_string();
                if claimed != actual {
                    println!("txid MISMATCH");
                    println!("  builder says : {claimed}");
                    println!("  recomputed   : {actual}");
                    return Err("the builder and this tool disagree about serialization".into());
                }
            }

            println!("built by   : {}", v.get("builtBy").and_then(|b| b.as_str()).unwrap_or("unknown"));
            println!("txid       : {}", tx.id());
            println!("sigscript  : {} bytes", tx.inputs[0].signature_script.len());
            println!("outputs    : {}", tx.outputs.len());

            // Cloned: the entry is needed again below, to decide whether this
            // transaction is even this manifest's business.
            let verdict = validate_locally(&tx, entry.clone());
            println!("\nscript engine -> {verdict:?}");
            match verdict {
                Ok(()) => println!("the consensus engine accepts a transaction this tool did not build."),
                Err(e) => return Err(format!("the engine refused it: {e:?}").into()),
            }

            if cmd == "submit" {
                let client = connect(&url).await?;
                require_ready(&client).await?;
                match client.submit_transaction((&tx).into(), false).await {
                    Ok(txid) => {
                        println!("\nSUBMITTED: {txid}");
                        println!("a transaction assembled in JavaScript is now on testnet-10.");
                    }
                    Err(e) => return Err(format!("node refused it: {e}").into()),
                }
            } else if cmd == "verify" {
                println!("\n(not broadcast — run `submit` with a synced node to put it on chain)");
            }

            // Whether we broadcast or are catching up after the fact, the
            // manifest has to follow the grant. `verify` deliberately does not
            // advance it: nothing was sent, so nothing moved.
            if cmd != "verify" {
                match read_manifest() {
                    Ok(m) => match advance_manifest(&m, &tx, &entry)? {
                        Some(manifest) => {
                            std::fs::write("grant.json", &manifest)?;
                            println!("\nadvanced grant.json — the grant has MOVED to a new address.");
                            println!("re-run `plan` before the next spend; the old address is now empty.");
                        }
                        None => println!("\n(not a transaction of the grant in grant.json — manifest unchanged)"),
                    },
                    Err(e) => println!("\n(no manifest to advance: {e})"),
                }
            }
        }

        "plan" => {
            // The one thing the JS SDK genuinely cannot do: find the grant.
            //
            // A grant's address is derived from its state, so it MOVES after
            // every spend. Locating the current UTXO means asking a node, and
            // the SDK has no node client. Rather than give it one that cannot
            // be tested until it is already wrong, this command does the
            // network half and writes down everything the assembly half needs.
            //
            // The split is not a workaround, it is the safe factoring: network
            // I/O here, byte layout there, and a transaction that crosses
            // between them gets checked by `verify` before `submit` broadcasts.
            let m = read_manifest()?;
            let client = connect(&url).await?;
            let daa = require_ready(&client).await?;

            let contract = compile(grant_ctor(
                m.agent, m.agent, m.root, m.not_before, m.expires_at,
                m.spent, m.reserved, m.epoch_index, m.epoch_spent,
            ))?;
            let grant_addr = extract_script_pub_key_address(
                &pay_to_script_hash_script(&contract.bytecode), Prefix::Testnet)?;
            println!("grant state    : spent {} / reserved {} / epoch {}",
                formatted(m.spent), formatted(m.reserved), m.epoch_index);
            println!("grant address  : {grant_addr}");

            let utxos = client.get_utxos_by_addresses(vec![grant_addr.clone()]).await?;
            let grant = utxos
                .first()
                .ok_or("no UTXO at the grant address — has genesis confirmed, and is grant.json current?")?;
            println!("grant utxo     : {} sompi", grant.utxo_entry.amount);

            // Behind the tip, for the reason spelled out in the spend arm: the
            // claimed DAA becomes a CLTV lock, and a lock equal to the tip is
            // not yet final. Understating only costs epoch headroom;
            // overstating is impossible. The convenient direction is the sound
            // one.
            let claimed_daa = (daa as i64 - DAA_BACKOFF).max(m.not_before);
            if claimed_daa < m.not_before {
                return Err("current DAA precedes not_before".into());
            }
            println!("claimed daa    : {claimed_daa} (chain at {daa})");

            let members = demo_recipients();
            let amount = KAS / 2;

            let json = format!(
r#"{{
  "note": "Everything @warda/kaspa needs to build the next spend against the LIVE grant. Regenerate this before every spend: the grant's address moves each time, so a stale plan points at a UTXO that no longer exists.",
  "generatedBy": "warda-deploy plan",
  "network": "kaspatest",
  "chainDaa": {daa},

  "authority": {{
    "principalKey": "{agent}",
    "revocationKey": "{agent}"
  }},

  "state": {{
    "agentKey": "{agent}",
    "budgetTotal": {budget},
    "maxPerSpend": {max_per_spend},
    "epochLimit": {epoch_limit},
    "epochLength": {epoch_length},
    "recipientsRoot": "{root}",
    "notBefore": {not_before},
    "expiresAt": {expires_at},
    "delegationDepth": {deleg_depth},
    "spentTotal": {spent},
    "reserved": {reserved},
    "epochIndex": {epoch_index},
    "epochSpent": {epoch_spent}
  }},

  "grantAddress": "{grant_addr}",

  "utxo": {{
    "outpointTransactionId": "{op_txid}",
    "outpointIndex": {op_index},
    "value": {in_value},
    "blockDaaScore": {block_daa},
    "isCoinbase": {is_coinbase},
    "covenantId": "{cov}"
  }},

  "recipients": {{
    "members": [{members}],
    "target": "{target}"
  }},

  "spend": {{
    "amount": {amount},
    "claimedDaa": {claimed_daa},
    "fee": {fee},
    "computeBudget": {compute_budget}
  }}
}}
"#,
                daa = daa,
                agent = hex(&m.agent),
                budget = BUDGET,
                max_per_spend = MAX_PER_SPEND,
                epoch_limit = EPOCH_LIMIT,
                epoch_length = EPOCH_LENGTH,
                root = hex(&m.root),
                not_before = m.not_before,
                expires_at = m.expires_at,
                deleg_depth = DELEGATION_DEPTH,
                spent = m.spent,
                reserved = m.reserved,
                epoch_index = m.epoch_index,
                epoch_spent = m.epoch_spent,
                grant_addr = grant_addr,
                op_txid = grant.outpoint.transaction_id,
                op_index = grant.outpoint.index,
                in_value = grant.utxo_entry.amount,
                block_daa = grant.utxo_entry.block_daa_score,
                is_coinbase = grant.utxo_entry.is_coinbase,
                cov = m.covenant_id,
                members = members
                    .iter()
                    .map(|r| format!("\"{}\"", hex(r)))
                    .collect::<Vec<_>>()
                    .join(", "),
                target = hex(&members[0]),
                amount = amount,
                claimed_daa = claimed_daa,
                fee = SPEND_FEE,
                compute_budget = SPEND_COMPUTE_BUDGET,
            );

            let out = std::env::args().nth(2).unwrap_or_else(|| "../../sdk/spend-plan.json".into());
            std::fs::write(&out, &json)?;
            println!("\nwrote {out}");
            println!("next: cd ../../sdk && WARDA_SK=... npm run build:live > js-spend.json");
            println!("then: cd ../covenant/deploy && cargo run -- submit ../../sdk/js-spend.json");
        }

        other => println!("unknown command {other:?}\nusage: warda-deploy <status|address|template|golden|plan|verify|submit|advance|dry-run|genesis|spend|inject>"),
    }
    Ok(())
}

// ---- grant manifest ------------------------------------------------------

struct Manifest {
    covenant_id: String,
    agent: [u8; 32],
    root: [u8; 32],
    not_before: i64,
    expires_at: i64,
    /// The grant's CURRENT state. Not bookkeeping — the address is derived
    /// from it, so a stale state here means looking for the UTXO at an
    /// address the grant has already left.
    spent: i64,
    reserved: i64,
    epoch_index: i64,
    epoch_spent: i64,
}

/// Advances the manifest to the state a submitted spend produced.
///
/// This is not bookkeeping. A grant's ADDRESS is derived from its state, so a
/// manifest left behind points at an address the grant has already left, and
/// the next `plan` reports "no UTXO at the grant address" for a grant that is
/// perfectly healthy. That reads as a lost grant and is merely a stale file.
///
/// The new state is not guessed from what we intended to do. It is derived
/// from the transaction's OWN numbers and then checked against the successor
/// address that transaction actually pays to. If those disagree, nothing is
/// written: a confidently wrong manifest is worse than a missing one.
fn advance_manifest(m: &Manifest, tx: &Transaction, entry: &UtxoEntry) -> Result<Option<String>, Box<dyn Error>> {
    if tx.outputs.len() != 2 {
        return Ok(None);
    }
    let cov: kaspa_consensus_core::Hash = m.covenant_id.parse()?;
    match &tx.outputs[0].covenant {
        Some(c) if c.covenant_id == cov => {}
        _ => return Ok(None),
    }

    // Is this a spend of THIS grant, or of a relative?
    //
    // The covenant id is NOT unique per grant. A delegated child inherits its
    // parent's id, so "output 0 is bound to this covenant" is true of every
    // grant in the tree, and a child's spend looked like a spend of the
    // parent. The successor-address check caught it and refused, which is the
    // right outcome reached by the wrong route: it reported a disagreement
    // about a transaction that was never this grant's business.
    //
    // The honest gate is the INPUT. A transaction spends the grant this
    // manifest describes only if the UTXO it consumes sits at the address the
    // manifest's current state derives.
    let current = compile(grant_ctor(
        m.agent, m.agent, m.root, m.not_before, m.expires_at,
        m.spent, m.reserved, m.epoch_index, m.epoch_spent,
    ))?;
    if pay_to_script_hash_script(&current.bytecode) != entry.script_public_key {
        return Ok(None);
    }

    // A SPEND and a DELEGATION are both "two outputs, output 0 bound to this
    // covenant", and they move the state in completely different directions.
    // The discriminator is output 1: a spend pays a recipient's plain P2PK,
    // while a delegation pays a CHILD GRANT, which carries a binding of its
    // own. Reading a delegation as a spend charges the child's whole budget
    // to spent_total, and reads a delegation's zero lock time as a claimed
    // DAA — which puts the epoch index far into the negative.
    let delegating = matches!(&tx.outputs[1].covenant, Some(c) if c.covenant_id == cov);

    let (spent, reserved, epoch_index, epoch_spent) = if delegating {
        // Delegation moves budget from uncommitted to RESERVED. Nothing is
        // spent — the coin has not left the grant, it has been subdivided —
        // and no epoch allowance is consumed, which is why a delegation
        // carries no lock time to read one from.
        (m.spent, m.reserved + tx.outputs[1].value as i64, m.epoch_index, m.epoch_spent)
    } else {
        let amount = tx.outputs[1].value as i64;
        let claimed_daa = tx.lock_time as i64;
        let epoch_index = (claimed_daa - m.not_before) / EPOCH_LENGTH;
        // A new epoch resets the allowance; the same epoch accumulates.
        let carried = if epoch_index == m.epoch_index { m.epoch_spent } else { 0 };
        (m.spent + amount, m.reserved, epoch_index, carried + amount)
    };

    // The check that makes this safe: derive the successor address from the
    // state we just computed, and require the transaction to be paying it.
    let successor = compile(grant_ctor(
        m.agent, m.agent, m.root, m.not_before, m.expires_at,
        spent, reserved, epoch_index, epoch_spent,
    ))?;
    let expected = pay_to_script_hash_script(&successor.bytecode);
    if expected != tx.outputs[0].script_public_key {
        // Printed rather than folded into the error string: `main` renders
        // errors with Debug, which turns a multi-line diagnostic into escaped
        // \n soup at exactly the moment someone needs to read it.
        println!("\nREFUSING to advance grant.json.");
        println!("  read as a {}:", if delegating { "DELEGATION" } else { "SPEND" });
        println!("  the state derived from this transaction:");
        println!("    spent {spent}, reserved {reserved}, epoch {epoch_index}, epochSpent {epoch_spent}");
        println!("  implies a successor at:");
        println!("    {}", hex(expected.script()));
        println!("  but the transaction pays:");
        println!("    {}", hex(tx.outputs[0].script_public_key.script()));
        println!("\nEither grant.json describes a different state than this spend was built");
        println!("from, or this is not the transaction it appears to be. The manifest is");
        println!("unchanged — a confidently wrong one is worse than a missing one.");
        return Err("manifest and transaction disagree about the successor state".into());
    }

    Ok(Some(format!(
        "{{\n  \"covenant_id\": \"{}\",\n  \"agent\": \"{}\",\n  \"recipients_root\": \"{}\",\n  \"not_before\": {},\n  \"expires_at\": {},\n  \"budget\": {BUDGET},\n  \"max_per_spend\": {MAX_PER_SPEND},\n  \"epoch_limit\": {EPOCH_LIMIT},\n  \"epoch_length\": {EPOCH_LENGTH},\n  \"grant_value\": {},\n  \"spent_total\": {spent},\n  \"reserved\": {reserved},\n  \"epoch_index\": {epoch_index},\n  \"epoch_spent\": {epoch_spent}\n}}\n",
        m.covenant_id, hex(&m.agent), hex(&m.root), m.not_before, m.expires_at,
        tx.outputs[0].value,
    )))
}

fn read_manifest() -> Result<Manifest, Box<dyn Error>> {
    let raw = std::fs::read_to_string("grant.json")
        .map_err(|_| "no grant.json — run `genesis` first, from this directory")?;
    let field = |k: &str| -> Result<String, Box<dyn Error>> {
        let pat = format!("\"{k}\":");
        let i = raw.find(&pat).ok_or(format!("grant.json missing {k}"))?;
        let rest = &raw[i + pat.len()..];
        Ok(rest
            .trim_start()
            .trim_start_matches('"')
            .chars()
            .take_while(|c| *c != ',' && *c != '"' && *c != '\n' && *c != '}')
            .collect::<String>()
            .trim()
            .to_string())
    };
    let b32 = |s: String| -> Result<[u8; 32], Box<dyn Error>> {
        let v = (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()?;
        let mut o = [0u8; 32];
        if v.len() != 32 {
            return Err("bad 32-byte hex in grant.json".into());
        }
        o.copy_from_slice(&v);
        Ok(o)
    };
    Ok(Manifest {
        covenant_id: field("covenant_id")?,
        agent: b32(field("agent")?)?,
        root: b32(field("recipients_root")?)?,
        not_before: field("not_before")?.parse()?,
        expires_at: field("expires_at")?.parse()?,
        spent: field("spent_total").unwrap_or_else(|_| "0".into()).parse().unwrap_or(0),
        reserved: field("reserved").unwrap_or_else(|_| "0".into()).parse().unwrap_or(0),
        epoch_index: field("epoch_index").unwrap_or_else(|_| "0".into()).parse().unwrap_or(0),
        epoch_spent: field("epoch_spent").unwrap_or_else(|_| "0".into()).parse().unwrap_or(0),
    })
}

/// A real, spendable payee derived deterministically, so the demo moves money
/// somewhere that actually exists rather than to a filler pubkey.
fn demo_api_key() -> Keypair {
    let seed = b2b(&[b"warda-demo-api-v1"]);
    Keypair::from_seckey_slice(&Secp256k1::new(), &seed).expect("valid demo key")
}

fn merkle_proof(members: &[[u8; 32]], target: &[u8; 32]) -> (Vec<[u8; 32]>, Vec<bool>) {
    let mut sorted = members.to_vec();
    sorted.sort();
    let mut levels: Vec<Vec<[u8; 32]>> = vec![sorted.iter().map(|r| b2b(&[&[LEAF], r])).collect()];
    while levels.last().unwrap().len() > 1 {
        let prev = levels.last().unwrap();
        let mut next = Vec::new();
        let mut i = 0;
        while i < prev.len() {
            if i + 1 < prev.len() {
                next.push(b2b(&[&[NODE], &prev[i], &prev[i + 1]]));
            } else {
                next.push(prev[i]);
            }
            i += 2;
        }
        levels.push(next);
    }
    let mut idx = sorted.iter().position(|m| m == target).unwrap_or(0);
    let (mut sibs, mut lefts) = (Vec::new(), Vec::new());
    for level in &levels[..levels.len() - 1] {
        let pair = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
        if pair < level.len() {
            sibs.push(level[pair]);
            lefts.push(pair < idx);
        }
        idx /= 2;
    }
    (sibs, lefts)
}

fn byte32_array(items: Vec<[u8; 32]>) -> Expr<'static> {
    Expr::array(
        TypeRef { base: TypeBase::Byte, array_dims: vec![ArrayDim::Fixed(32), ArrayDim::Dynamic] },
        items.into_iter().map(|b| Expr::bytes(b.to_vec())).collect(),
    )
}

fn bool_array(items: Vec<bool>) -> Expr<'static> {
    Expr::array(
        TypeRef { base: TypeBase::Bool, array_dims: vec![ArrayDim::Dynamic] },
        items.into_iter().map(Expr::bool).collect(),
    )
}

#[allow(clippy::too_many_arguments)]
fn grant_state(
    agent: [u8; 32],
    root: [u8; 32],
    not_before: i64,
    expires_at: i64,
    spent: i64,
    reserved: i64,
    epoch_index: i64,
    epoch_spent: i64,
) -> Expr<'static> {
    struct_object(
        "State",
        vec![
            ("agentKey", Expr::bytes(agent.to_vec())),
            ("budgetTotal", Expr::int(BUDGET)),
            ("maxPerSpend", Expr::int(MAX_PER_SPEND)),
            ("epochLimit", Expr::int(EPOCH_LIMIT)),
            ("epochLength", Expr::int(EPOCH_LENGTH)),
            ("recipientsRoot", Expr::bytes(root.to_vec())),
            ("notBefore", Expr::int(not_before)),
            ("expiresAt", Expr::int(expires_at)),
            ("delegationDepth", Expr::int(DELEGATION_DEPTH)),
            ("spentTotal", Expr::int(spent)),
            ("reserved", Expr::int(reserved)),
            ("epochIndex", Expr::int(epoch_index)),
            ("epochSpent", Expr::int(epoch_spent)),
        ],
    )
}

fn covenant_sigscript(
    c: &CompiledContract<'_>,
    function: &str,
    args: Vec<Expr<'_>>,
) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut s = c
        .build_sig_script_for_covenant_decl(function, args, CovenantDeclCallOptions { is_leader: false })
        .map_err(|e| format!("sigscript: {e:?}"))?;
    let redeem = ScriptBuilder::with_flags(EngineFlags { covenants_enabled: true, ..Default::default() })
        .add_data(&c.bytecode)?
        .drain();
    s.extend_from_slice(&redeem);
    Ok(s)
}

/// Signs a covenant input. The covenant binding is part of the digest at v1 —
/// see SIGNING.md. A signer that omits it produces a signature the engine
/// refuses, and the failure looks exactly like a covenant bug.
fn sign_covenant(tx: Transaction, entries: Vec<UtxoEntry>, idx: usize, kp: &Keypair) -> Result<Vec<u8>, Box<dyn Error>> {
    let mtx = MutableTransaction::with_entries(tx, entries);
    let reused = SigHashReusedValuesUnsync::new();
    let sig_hash = calc_schnorr_signature_hash(&mtx.as_verifiable(), idx, SIG_HASH_ALL, &reused);
    let msg = secp256k1::Message::from_digest_slice(sig_hash.as_bytes().as_slice())?;
    let mut sig = kp.sign_schnorr(msg).as_ref().to_vec();
    sig.push(SIG_HASH_ALL.to_u8());
    Ok(sig)
}

fn formatted(sompi: i64) -> String {
    format!("{:.3} KAS", sompi as f64 / KAS as f64)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---- reading a transaction built elsewhere -------------------------------
//
// Deliberately strict. Every one of these fields is load-bearing, and a
// permissive parser that defaults a missing one turns a builder's omission
// into this tool's wrong answer.

fn wire_hex(v: &serde_json::Value, key: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    let s = v.get(key).and_then(|x| x.as_str()).ok_or(format!("missing string field {key}"))?;
    if s.len() % 2 != 0 {
        return Err(format!("{key}: hex has odd length").into());
    }
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|e| format!("{key}: {e}").into())
}

fn wire_hash(v: &serde_json::Value, key: &str) -> Result<kaspa_consensus_core::Hash, Box<dyn Error>> {
    let b = wire_hex(v, key)?;
    let a: [u8; 32] = b.try_into().map_err(|_| format!("{key}: expected 32 bytes"))?;
    Ok(kaspa_consensus_core::Hash::from_bytes(a))
}

/// Amounts arrive as STRINGS. A sompi value exceeds what a JSON number holds
/// exactly, and a parser that accepts f64 here would silently round a balance.
fn wire_u64(v: &serde_json::Value, key: &str) -> Result<u64, Box<dyn Error>> {
    let s = v.get(key).and_then(|x| x.as_str()).ok_or(format!("missing string field {key} (amounts must be strings, not JSON numbers)"))?;
    s.parse::<u64>().map_err(|e| format!("{key}: {e}").into())
}

fn wire_u32(v: &serde_json::Value, key: &str) -> Result<u32, Box<dyn Error>> {
    let n = v.get(key).and_then(|x| x.as_u64()).ok_or(format!("missing integer field {key}"))?;
    u32::try_from(n).map_err(|e| format!("{key}: {e}").into())
}

fn parse_wire(v: &serde_json::Value) -> Result<(Transaction, UtxoEntry), Box<dyn Error>> {
    let version = v.get("version").and_then(|x| x.as_u64()).ok_or("missing version")? as u16;
    if version < 1 {
        return Err("only version-1 transactions carry covenants".into());
    }

    let inputs_json = v.get("inputs").and_then(|x| x.as_array()).ok_or("missing inputs")?;
    let mut inputs = Vec::new();
    for i in inputs_json {
        let outpoint = TransactionOutpoint {
            transaction_id: wire_hash(i, "previousOutpointTransactionId")?,
            index: wire_u32(i, "previousOutpointIndex")?,
        };
        let budget = i.get("computeBudget").and_then(|x| x.as_u64()).ok_or("input missing computeBudget")? as u16;
        inputs.push(TransactionInput::new_with_compute_budget(
            outpoint,
            wire_hex(i, "signatureScriptHex")?,
            wire_u64(i, "sequence")?,
            budget,
        ));
    }

    let outputs_json = v.get("outputs").and_then(|x| x.as_array()).ok_or("missing outputs")?;
    let mut outputs = Vec::new();
    for o in outputs_json {
        let spk_version = o.get("scriptPublicKeyVersion").and_then(|x| x.as_u64()).ok_or("output missing scriptPublicKeyVersion")? as u16;
        // `null` and absent are NOT the same thing here: null says "this output
        // carries no covenant binding", which is a claim; absent is an omission.
        let covenant = match o.get("covenant") {
            Some(serde_json::Value::Null) => None,
            Some(c) => Some(CovenantBinding {
                authorizing_input: c.get("authorizingInput").and_then(|x| x.as_u64()).ok_or("covenant missing authorizingInput")? as u16,
                covenant_id: wire_hash(c, "covenantId")?,
            }),
            None => return Err("output must state its covenant binding, even as null".into()),
        };
        outputs.push(TransactionOutput {
            value: wire_u64(o, "value")?,
            script_public_key: ScriptPublicKey::new(spk_version, wire_hex(o, "scriptPublicKeyHex")?.into()),
            covenant,
        });
    }

    let subnetwork = wire_hex(v, "subnetworkId")?;
    if subnetwork.iter().any(|b| *b != 0) {
        return Err("only the native subnetwork is supported".into());
    }

    let tx = Transaction::new(
        version,
        inputs,
        outputs,
        wire_u64(v, "lockTime")?,
        SUBNETWORK_ID_NATIVE,
        wire_u64(v, "gas")?,
        wire_hex(v, "payloadHex")?,
    );

    // A covenant spend cannot be validated without its UTXO: the digest commits
    // to the entry's script and value, and the engine reads the covenant id
    // from it.
    let u = v.get("utxo").ok_or("missing utxo — a covenant spend cannot be checked without it")?;
    let spk_version = u.get("scriptPublicKeyVersion").and_then(|x| x.as_u64()).ok_or("utxo missing scriptPublicKeyVersion")? as u16;
    let covenant_id = match u.get("covenantId") {
        Some(serde_json::Value::Null) => None,
        Some(_) => Some(wire_hash(u, "covenantId")?),
        None => return Err("utxo must state its covenant id, even as null".into()),
    };
    let entry = UtxoEntry::new(
        wire_u64(u, "value")?,
        ScriptPublicKey::new(spk_version, wire_hex(u, "scriptPublicKeyHex")?.into()),
        wire_u64(u, "blockDaaScore")?,
        u.get("isCoinbase").and_then(|x| x.as_bool()).ok_or("utxo missing isCoinbase")?,
        covenant_id,
    );

    Ok((tx, entry))
}
