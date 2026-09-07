/**
 * The questions this service answers, and the ones it refuses to pretend to.
 *
 * There are three real questions a counterparty has about a grant, and they
 * are not the same question:
 *
 *   "Is this manifest true?"      — /v1/verify. Somebody handed you terms.
 *                                   Does the chain agree with them?
 *   "What is at this address?"    — /v1/grant/:address. You have an address
 *                                   and nothing else. Strictly less can be
 *                                   answered, and the endpoint says so rather
 *                                   than inventing the rest.
 *   "Would this payment go       — /v1/authority. The one an agent framework
 *    through?"                     actually asks, and the only one whose
 *                                   answer is a sentence rather than a number.
 *
 * None of these is a permission. The covenant decides, on chain. Every answer
 * here is a re-derivation of what it would decide, and the value is that a
 * caller learns WHICH rule binds instead of reading a script error after
 * paying a fee to discover it.
 */
import {
  candidateStates,
  describeGrant,
  scriptHashFor,
  scriptHashToAddress,
  toHex,
  type AddressUtxo,
  type DagInfo,
  type CovenantTemplate,
  type Grant as SdkGrant,
  type Payment,
} from "@warda_protocol/kaspa";
import {
  explainRefusal,
  type Grant as PayerGrant,
  type PaymentRequirement,
} from "@warda_protocol/x402";
import { ManifestError, materialise, prefixFor, type Materialised } from "./manifest.ts";
import { NodeUnusable, readFrom, type ChainSource, type Live } from "./node.ts";
import { amount, envelope, reportJson, type Envelope } from "./report.ts";
import { loadTemplate } from "./template.ts";

export interface Reply {
  status: number;
  body: unknown;
}

export class RequestError extends Error {
  readonly status: number;
  readonly field: string | null;
  constructor(status: number, message: string, field: string | null = null) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.field = field;
  }
}

function body(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RequestError(400, "the request body must be a JSON object");
  }
  return input as Record<string, unknown>;
}

/**
 * The fee the next spend will pay.
 *
 * It matters more than it looks. Fees come out of the grant's coin but are not
 * charged against `spentTotal`, so the coin and the budget diverge by exactly
 * the fees paid so far — and the last spend an agent believes it can afford is
 * the one that gets refused. A caller that knows its fee should say so; the
 * default is the covenant's own ceiling, which understates the headroom rather
 * than promising a spend the coin cannot cover.
 */
function feeFrom(b: Record<string, unknown>, template: CovenantTemplate): bigint {
  const v = b.feeSompi;
  if (v === undefined || v === null) return BigInt(template.baked.maxFee);
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new RequestError(400, "feeSompi must be a non-negative integer, quoted as a string", "feeSompi");
}

function sdkGrant(m: Materialised): SdkGrant {
  return { authority: m.authority, state: m.state };
}

function addressOf(m: Materialised, template: CovenantTemplate): string {
  return scriptHashToAddress(scriptHashFor(template, sdkGrant(m)), m.prefix);
}

/**
 * The coin and the chain's position, read together.
 *
 * The DAA score is fetched per request rather than taken from the cached
 * health check. The epoch a grant is in is computed from it, and an epoch
 * boundary can pass between two requests: reporting last minute's epoch would
 * understate the headroom of a grant that has just been given a fresh
 * allowance, which is a wrong answer in the direction of refusing a payment
 * the chain would accept.
 */
async function chainAt(
  source: ChainSource,
  address: string,
): Promise<{ utxo: AddressUtxo | null; all: AddressUtxo[]; dag: DagInfo; live: Live }> {
  const live = await source.acquire();
  const [entries, dag] = await Promise.all([
    live.client.getUtxosByAddresses([address]),
    live.client.getBlockDagInfo(),
  ]);
  // The whole list, not just the first. A GRANT holds exactly one coin by
  // construction, so `entries[0]` is the right answer there and was the only
  // case this was written for. Any other address may hold many, and reporting
  // the first as though it were the balance is a wrong number that looks like
  // a right one — it under-reported a funding wallet by four orders of
  // magnitude the first time somebody pointed this at one.
  return { utxo: entries[0] ?? null, all: entries, dag, live };
}

/** Whether the node reported a covenant binding for this coin. */
function covenantHex(utxo: AddressUtxo | null): string | null {
  const id = utxo?.entry.covenantId;
  return id ? toHex(id) : null;
}

// ---------------------------------------------------------------- /health --

export async function health(source: ChainSource): Promise<Reply> {
  try {
    const live = await source.acquire();
    return { status: 200, body: { ok: true, readFrom: readFrom(live.health) } };
  } catch (e) {
    if (e instanceof NodeUnusable) {
      return {
        status: 503,
        body: {
          ok: false,
          error: "node_unusable",
          message: e.message,
          readFrom: e.health ? readFrom(e.health) : null,
        },
      };
    }
    throw e;
  }
}

// ------------------------------------------------------------- /v1/verify --

export async function verify(source: ChainSource, input: unknown): Promise<Reply> {
  const b = body(input);
  const template = loadTemplate();
  const m = materialise(
    { manifest: b.manifest ?? b, recipients: b.recipients, network: b.network },
    template,
  );
  const fee = feeFrom(b, template);
  const address = addressOf(m, template);

  const { utxo, dag, live } = await chainAt(source, address);
  const report = describeGrant(sdkGrant(m), template, m.prefix, utxo, dag, {
    ...(m.covenantId ? { covenantId: m.covenantId } : {}),
    ...(m.grantValue === null ? {} : { value: m.grantValue }),
    fee,
  });

  const result: Envelope<ReturnType<typeof reportJson>> = envelope(
    reportJson(report),
    readFrom(live.health, utxo ? covenantHex(utxo) !== null : null),
    m.assumptions,
  );
  return { status: 200, body: result };
}

// ------------------------------------------------------ /v1/grant/:address --

/**
 * What a node alone can say about an address, and the line it stops at.
 *
 * It stops early, and the honest thing is to say where. A grant's TERMS are
 * not derivable from its address: the address is a hash of a script, the
 * script is published only when the grant is spent, and finding that spend
 * from an address alone needs an index kaspad does not keep. So this endpoint
 * reports the coin, its size and whether it is covenant-bound — and then says
 * plainly that the budget, the cap and the payee list are not knowable from
 * here, and that the way to learn them is to check somebody's claim against
 * this coin with /v1/verify.
 *
 * An endpoint that guessed the rest would be the most dangerous thing in this
 * repo: a confident answer about a limit nobody enforces.
 */
export async function grantAt(source: ChainSource, address: string): Promise<Reply> {
  if (!address || !address.includes(":")) {
    throw new RequestError(400, `${JSON.stringify(address)} is not a Kaspa address`, "address");
  }
  const { utxo, all, live } = await chainAt(source, address);

  const notKnowable =
    "A grant's terms are not derivable from its address. The address is the hash of a " +
    "script, and the script is published only when the grant is spent — so budget, " +
    "per-payment cap, epoch limit and payee list cannot be read from here by anyone, " +
    "including this service. To check terms somebody gave you, post them to /v1/verify: " +
    "if they describe this grant they will derive this address.";

  if (!utxo) {
    return {
      status: 200,
      body: envelope(
        {
          address,
          found: false,
          value: null,
          covenantId: null,
          note:
            "nothing at this address. A grant's address is derived from its state and " +
            "spending changes that state, so an address that once held a grant holds " +
            "nothing after the next spend. Empty here means 'not at this state', not " +
            "'gone'.",
          termsKnowable: false,
          whyNot: notKnowable,
        },
        readFrom(live.health),
        [],
      ),
    };
  }

  const covenantId = covenantHex(utxo);
  const total = all.reduce((sum, u) => sum + u.entry.value, 0n);
  return {
    status: 200,
    body: envelope(
      {
        address,
        found: true,
        value: amount(utxo.entry.value),
        coins: all.length,
        total: amount(total),
        largest: amount(all.reduce((m, u) => (u.entry.value > m ? u.entry.value : m), 0n)),
        covenantId,
        note:
          (all.length > 1
            ? `this address holds ${all.length} coins. A Warda grant holds exactly one, so ` +
              `this is not a grant at its current state — and if you are funding one, note that ` +
              `genesis takes a single input, so the figure that matters is the largest coin ` +
              `rather than the total. `
            : "") +
          (covenantId
            ? "a covenant-bound coin. Which covenant, and under what terms, is what /v1/verify checks."
            : "the node reports no covenant id for this coin, so nothing here is bound by a covenant at all."),
        termsKnowable: false,
        whyNot: notKnowable,
      },
      readFrom(live.health, covenantId !== null),
      [],
    ),
  };
}

// ---------------------------------------------------------- /v1/authority --

export interface AuthorityAnswer {
  address: string;
  /** null when the covenant would refuse; the reason is in `refusal`. */
  wouldBeRefused: boolean;
  refusal: string | null;
  requested: ReturnType<typeof amount>;
  payTo: string;
  maxNextSpend: ReturnType<typeof amount>;
  boundBy: string;
  found: boolean;
}

/**
 * The agent framework's question: may this payment be made, right now.
 *
 * The refusal sentence comes from `explainRefusal` in @warda_protocol/x402 —
 * the same function the payer calls before it builds anything. This service
 * does not carry its own copy of the ordering. A second implementation of the
 * rules would fail in the direction that matters: by wrongly PERMITTING, which
 * is how a budget gets drained, and by disagreeing with the payer about which
 * rule bound, which is how an operator stops believing either.
 */
export async function authority(source: ChainSource, input: unknown): Promise<Reply> {
  const b = body(input);
  const template = loadTemplate();

  const payment = b.payment;
  if (typeof payment !== "object" || payment === null || Array.isArray(payment)) {
    throw new RequestError(400, "payment must be an object with amountSompi and payTo", "payment");
  }
  const p = payment as Record<string, unknown>;
  const payTo = p.payTo;
  if (typeof payTo !== "string" || !payTo.includes(":")) {
    throw new RequestError(400, "payment.payTo must be a Kaspa address", "payment.payTo");
  }
  const raw = p.amountSompi;
  let amountSompi: bigint;
  if (typeof raw === "string" && /^\d+$/.test(raw)) amountSompi = BigInt(raw);
  else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) amountSompi = BigInt(raw);
  else {
    throw new RequestError(
      400,
      "payment.amountSompi must be a non-negative integer, quoted as a string",
      "payment.amountSompi",
    );
  }

  if (b.recipients === undefined) {
    throw new RequestError(
      400,
      "authority needs the grant's payee list, not just its root. A Merkle root can " +
        "confirm a list but cannot produce a membership proof from one, so 'is this " +
        "vendor allowed' is unanswerable without the members. Send them as `recipients`; " +
        "they are checked against the manifest's recipients_root before anything else.",
      "recipients",
    );
  }

  const m = materialise(
    { manifest: b.manifest ?? b, recipients: b.recipients, network: b.network },
    template,
  );
  const fee = feeFrom(b, template);
  const address = addressOf(m, template);
  const { utxo, dag, live } = await chainAt(source, address);

  const grant: PayerGrant = {
    template,
    authority: m.authority,
    state: m.state,
    recipients: m.recipients!,
  };

  // Shaped exactly like a vendor's quote, because that is what the payer is
  // handed and this must answer the same question the payer will ask. The
  // nonce is empty: it binds a payment to a request, and no payment is being
  // built here.
  const requirement: PaymentRequirement = {
    scheme: "exact",
    network: live.health.network,
    asset: "KAS",
    payTo,
    amountSompi,
    nonce: "",
  };
  const refusal = explainRefusal(requirement, grant, {
    fee,
    ...(utxo ? { coin: utxo.entry.value } : {}),
  });

  const report = describeGrant(sdkGrant(m), template, m.prefix, utxo, dag, { fee });

  const answer: AuthorityAnswer = {
    address,
    wouldBeRefused: refusal !== null,
    refusal,
    requested: amount(amountSompi),
    payTo,
    maxNextSpend: amount(report.maxNextSpend),
    boundBy: report.boundBy,
    found: report.found,
  };

  const assumptions = [...m.assumptions];
  if (!utxo) {
    assumptions.push({
      field: "coin",
      value: "unknown",
      why:
        "nothing is at the grant's derived address, so the coin could not bound this " +
        "answer. The manifest is probably stale by a spend. Everything below is derived " +
        "from the manifest's own numbers, which is strictly more permissive than the " +
        "chain would be.",
    });
  }

  return {
    status: 200,
    body: envelope(answer, readFrom(live.health, utxo ? covenantHex(utxo) !== null : null), assumptions),
  };
}

// ------------------------------------------------------------- /v1/locate --

/**
 * Where a stale manifest's grant went.
 *
 * A grant's address is a hash of its state, so every spend moves it. A holder
 * whose record is a spend or two behind is looking at an empty address and
 * cannot tell that from a grant that is gone — which is the failure this
 * endpoint exists to repair, and one this project has inflicted on itself.
 *
 * It needs the payments the grant made, because those are what advanced the
 * state and kaspad keeps no index that would let anyone recover them from an
 * address. Whoever was PAID has them; so does anyone watching the payee.
 */
export async function locate(source: ChainSource, input: unknown): Promise<Reply> {
  const b = body(input);
  const template = loadTemplate();
  const m = materialise({ manifest: b.manifest ?? b, network: b.network }, template);

  const raw = b.payments;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RequestError(
      400,
      "locate needs the payments the grant made, as [{ valueSompi, blockDaaScore }]. " +
        "They are what moved the state, and no index recovers them from an address.",
      "payments",
    );
  }
  const payments: Payment[] = raw.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const value = e.valueSompi;
    const daa = e.blockDaaScore;
    const asInt = (v: unknown, field: string): bigint => {
      if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
      if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
      throw new RequestError(400, `payments[${i}].${field} must be a quoted integer`, `payments[${i}].${field}`);
    };
    return {
      value: asInt(value, "valueSompi"),
      blockDaaScore: asInt(daa, "blockDaaScore"),
      ...(typeof e.id === "string" ? { id: e.id } : {}),
    };
  });

  const subsets = b.subsets === true;
  const candidates = candidateStates(m.state, payments, subsets ? { subsets: true } : {});

  const live = await source.acquire();
  const checked: { address: string; spentTotal: string; epochIndex: string; applied: number }[] = [];

  for (const c of candidates) {
    const address = scriptHashToAddress(
      scriptHashFor(template, { authority: m.authority, state: c.state }),
      m.prefix,
    );
    const entries = await live.client.getUtxosByAddresses([address]);
    if (entries[0]) {
      return {
        status: 200,
        body: envelope(
          {
            found: true,
            address,
            value: amount(entries[0].entry.value),
            state: {
              spentTotal: amount(c.state.spentTotal),
              reserved: amount(c.state.reserved),
              epochIndex: c.state.epochIndex.toString(),
              epochSpent: amount(c.state.epochSpent),
            },
            paymentsApplied: c.applied.length,
            candidatesTried: checked.length + 1,
            note:
              "this is the grant at its current state. The manifest you sent describes an " +
              "earlier one; replace its state fields with these and the address will " +
              "match again.",
          },
          readFrom(live.health, covenantHex(entries[0]) !== null),
          m.assumptions,
        ),
      };
    }
    checked.push({
      address,
      spentTotal: c.state.spentTotal.toString(),
      epochIndex: c.state.epochIndex.toString(),
      applied: c.applied.length,
    });
  }

  return {
    status: 200,
    body: envelope(
      {
        found: false,
        candidatesTried: checked.length,
        note:
          candidates.length === 0
            ? "no candidate state could be built from these payments: every ordering the " +
              "covenant would accept exceeds a limit the manifest states. Either the " +
              "payments belong to a different grant, or the manifest's limits are not this " +
              "grant's."
            : "none of the states these payments could have produced holds a coin. The " +
              "usual causes are a missing payment, a payment that belongs to another " +
              "grant sharing the payee address (try subsets: true), or a grant that has " +
              "since been reclaimed by its principal.",
        tried: checked.slice(0, 25),
      },
      readFrom(live.health),
      m.assumptions,
    ),
  };
}

export { ManifestError, NodeUnusable, prefixFor };
