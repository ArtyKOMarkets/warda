/**
 * A manifest is somebody's CLAIM about a grant. This file turns that claim
 * into the objects the protocol works with, and refuses claims it cannot turn
 * into anything — before a node is asked, so a malformed request costs a round
 * trip to nobody.
 *
 * The shape is the one grants are actually issued with: the deploy manifest
 * that `genesis.ts` writes and that a principal hands to a counterparty.
 * Inventing a second format for this service would mean every caller
 * translating before they could ask a question, and a translation is a place
 * for a digit to move.
 *
 * Two rules run through the whole file.
 *
 * Amounts are read as strings wherever a string was given, and a JSON number
 * is accepted only when it is exactly representable. kaspad returns u64 fields
 * that are not — one of them rounded inside `JSON.parse` before any code in
 * this repo saw it — and a budget quietly rounded here would produce an
 * address that is right about everything except where the grant lives.
 *
 * A field that is part of the ADDRESS is never silently defaulted. Guessing
 * `delegation_depth` produces a perfectly valid address with nothing at it,
 * and "nothing there" is the same answer a spent grant gives. Where a default
 * is unavoidable it is recorded as an assumption and reported, because the
 * caller is the only one who can tell a stale manifest from a wrong one.
 */
import {
  EMPTY_RESERVE,
  RecipientSet,
  decodeAddress,
  templateIdFor,
  toHex,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
  type NetworkPrefix,
} from "@warda_protocol/kaspa";

/** What the service assumed because the manifest did not say. */
export interface Assumption {
  field: string;
  value: string;
  why: string;
}

export interface Materialised {
  authority: GrantAuthority;
  state: GrantState;
  recipients: RecipientSet | null;
  prefix: NetworkPrefix;
  /** The covenant id the manifest claims, if it claims one. */
  covenantId: string | null;
  /** The coin the manifest says the grant holds, if it says. */
  grantValue: bigint | null;
  assumptions: Assumption[];
}

export class ManifestError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = "ManifestError";
    this.field = field;
  }
}

const HEX32 = /^[0-9a-f]{64}$/i;

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function obj(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(field, `expected a JSON object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * A 32-byte value as hex. Checked here because the failure downstream is
 * silent: a key of the wrong length still hashes, still yields an address,
 * and that address simply never has anything at it.
 */
function hex32(m: Record<string, unknown>, field: string): string {
  const v = m[field];
  if (typeof v !== "string") {
    throw new ManifestError(field, `expected 64 hex characters, got ${describe(v)}`);
  }
  if (!HEX32.test(v)) {
    throw new ManifestError(
      field,
      `expected 64 hex characters (32 bytes), got ${v.length} characters. A value of the ` +
        `wrong length still derives an address — one with nothing at it — so it is ` +
        `rejected here rather than reported as a missing grant.`,
    );
  }
  return v.toLowerCase();
}

/**
 * A non-negative integer, from a quoted string or from a JSON number that is
 * exactly representable. This is the u64 rule, applied at the edge.
 */
function int(m: Record<string, unknown>, field: string): bigint {
  const v = m[field];
  if (typeof v === "string") {
    if (!/^\d+$/.test(v)) {
      throw new ManifestError(field, `expected a non-negative integer, got ${JSON.stringify(v)}`);
    }
    return BigInt(v);
  }
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new ManifestError(
        field,
        `${v} is not a safe integer, so JSON.parse has already changed it and the ` +
          `original value is not recoverable from this request. Send large amounts as ` +
          `quoted strings.`,
      );
    }
    return BigInt(v);
  }
  throw new ManifestError(field, `expected an integer, got ${describe(v)}`);
}

function optionalInt(
  m: Record<string, unknown>,
  field: string,
  fallback: bigint,
  assumptions: Assumption[],
  why: string,
): bigint {
  if (m[field] === undefined || m[field] === null) {
    assumptions.push({ field, value: fallback.toString(), why });
    return fallback;
  }
  return int(m, field);
}

const PREFIXES: Record<string, NetworkPrefix> = {
  "testnet-10": "kaspatest",
  "testnet-11": "kaspatest",
  testnet: "kaspatest",
  kaspatest: "kaspatest",
  mainnet: "kaspa",
  kaspa: "kaspa",
  simnet: "kaspasim",
  devnet: "kaspadev",
};

export function prefixFor(network: unknown, field = "network"): NetworkPrefix {
  if (typeof network !== "string") {
    throw new ManifestError(field, `expected a network name, got ${describe(network)}`);
  }
  const p = PREFIXES[network.toLowerCase()];
  if (!p) {
    throw new ManifestError(
      field,
      `unknown network ${JSON.stringify(network)}. Known: ${Object.keys(PREFIXES).join(", ")}. ` +
        `Getting this wrong is the quiet failure — a testnet manifest read against a ` +
        `mainnet node derives perfectly and finds nothing.`,
    );
  }
  return p;
}

/**
 * The payee list, as either Kaspa addresses or raw x-only keys.
 *
 * Optional, because a manifest commits to a ROOT and the root is enough to
 * derive the address. It is required to answer a question about a specific
 * payee: a root cannot produce an inclusion proof, and cannot answer "is this
 * vendor on the list" either.
 */
export function parseRecipients(input: unknown, field = "recipients"): RecipientSet {
  if (!Array.isArray(input) || input.some((r) => typeof r !== "string")) {
    throw new ManifestError(field, "expected an array of Kaspa addresses or 32-byte hex keys");
  }
  const members = (input as string[]).map((t, i) => {
    const s = t.trim();
    if (s.includes(":")) {
      try {
        return toHex(decodeAddress(s).payload);
      } catch (e) {
        throw new ManifestError(`${field}[${i}]`, (e as Error).message);
      }
    }
    if (!HEX32.test(s)) {
      throw new ManifestError(
        `${field}[${i}]`,
        `expected a Kaspa address or 64 hex characters, got ${JSON.stringify(s)}`,
      );
    }
    return s.toLowerCase();
  });
  try {
    return new RecipientSet(members);
  } catch (e) {
    throw new ManifestError(field, (e as Error).message);
  }
}

export interface MaterialiseInput {
  manifest: unknown;
  recipients?: unknown;
  network?: unknown;
}

export function materialise(input: MaterialiseInput, template: CovenantTemplate): Materialised {
  const m = obj(input.manifest, "manifest");
  const assumptions: Assumption[] = [];

  const prefix = prefixFor(
    input.network ?? m.network ?? process.env.WARDA_NETWORK ?? "testnet-10",
    input.network === undefined && m.network === undefined ? "network (defaulted)" : "network",
  );

  const principalKey = hex32(m, "principal");
  let revocationKey: string;
  if (m.revocation === undefined || m.revocation === null) {
    revocationKey = principalKey;
    assumptions.push({
      field: "revocation",
      value: principalKey,
      why: "the manifest names no revocation key, so the principal's own key was used. This is the ordinary case, and it is part of the address.",
    });
  } else {
    revocationKey = hex32(m, "revocation");
  }
  const authority: GrantAuthority = { principalKey, revocationKey };

  const state: GrantState = {
    agentKey: hex32(m, "agent"),
    budgetTotal: int(m, "budget"),
    maxPerSpend: int(m, "max_per_spend"),
    epochLimit: int(m, "epoch_limit"),
    epochLength: int(m, "epoch_length"),
    recipientsRoot: hex32(m, "recipients_root"),
    notBefore: int(m, "not_before"),
    expiresAt: int(m, "expires_at"),
    delegationDepth: optionalInt(
      m,
      "delegation_depth",
      2n,
      assumptions,
      "the manifest does not state it. Delegation depth is part of the address, so if the real grant used a different depth this report is about a script nothing was ever paid into.",
    ),
    templateId: templateIdFor(template, authority),
    spentTotal: optionalInt(m, "spent_total", 0n, assumptions, "absent, so the grant is treated as never having spent"),
    reserved: optionalInt(m, "reserved", 0n, assumptions, "absent, so the grant is treated as having no outstanding delegated children"),
    epochIndex: optionalInt(m, "epoch_index", 0n, assumptions, "absent, so the grant is treated as still in its first epoch"),
    epochSpent: optionalInt(m, "epoch_spent", 0n, assumptions, "absent, so the grant is treated as having spent nothing this epoch"),
    reserveRoot: EMPTY_RESERVE,
  };

  if (m.reserve_root === undefined || m.reserve_root === null) {
    assumptions.push({
      field: "reserve_root",
      value: EMPTY_RESERVE,
      why: "absent, so the grant is treated as having delegated nothing. The reserve root is part of the address: a grant that has delegated and omits it derives an address it does not live at.",
    });
  } else {
    state.reserveRoot = hex32(m, "reserve_root");
  }

  if (state.epochLength === 0n) {
    throw new ManifestError(
      "epoch_length",
      `an epoch of zero has no length to divide by — the covenant computes the current ` +
        `epoch as (daaScore - not_before) / epoch_length.`,
    );
  }
  if (state.expiresAt <= state.notBefore) {
    throw new ManifestError(
      "expires_at",
      `expiry ${state.expiresAt} is not after not_before ${state.notBefore}, so the ` +
        `spending window is empty and no spend is possible under this grant.`,
    );
  }
  if (state.spentTotal + state.reserved > state.budgetTotal) {
    throw new ManifestError(
      "spent_total",
      `spent ${state.spentTotal} plus reserved ${state.reserved} exceeds the budget ` +
        `${state.budgetTotal}. No sequence of covenant-accepted spends reaches this state, ` +
        `so the manifest describes something that did not happen.`,
    );
  }

  let recipients: RecipientSet | null = null;
  if (input.recipients !== undefined) {
    recipients = parseRecipients(input.recipients);
    if (recipients.rootHex !== state.recipientsRoot) {
      throw new ManifestError(
        "recipients",
        `these ${recipients.members.length} payees hash to ${recipients.rootHex}, and the ` +
          `manifest commits to ${state.recipientsRoot}. One of the two is not describing this ` +
          `grant. The root is what the covenant checks, so the payee list is the part to ` +
          `doubt — but either way no proof built from this list would satisfy the covenant.`,
      );
    }
  }

  return {
    authority,
    state,
    recipients,
    prefix,
    covenantId: m.covenant_id === undefined ? null : hex32(m, "covenant_id"),
    grantValue: m.grant_value === undefined || m.grant_value === null ? null : int(m, "grant_value"),
    assumptions,
  };
}
