/**
 * Turning protocol values into JSON, under one rule: no amount is ever a JSON
 * number.
 *
 * This is not fastidiousness. kaspad returns u64 fields — the circulating
 * supply among them — that exceed what a double can hold, and one of them was
 * rounded inside `JSON.parse` in this repo before any code saw it. A verifier
 * that emitted a budget as a number would hand its callers the same bug, and
 * they would have no way to detect it: a rounded amount looks exactly like an
 * amount.
 *
 * So every amount goes out as an object with both units. The sompi string is
 * the value; the KAS string is for people.
 */
import type { Finding, GrantReport } from "@warda_protocol/kaspa";
import type { Assumption } from "./manifest.ts";

export interface Amount {
  sompi: string;
  kas: string;
}

const SOMPI_PER_KAS = 100_000_000n;

export function amount(v: bigint): Amount {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / SOMPI_PER_KAS;
  const frac = (abs % SOMPI_PER_KAS).toString().padStart(8, "0").replace(/0+$/, "");
  return {
    sompi: v.toString(),
    kas: `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`,
  };
}

/** Where the answer came from. A verifier that will not say whom it asked is asking to be trusted. */
export interface ReadFrom {
  url: string;
  network: string;
  serverVersion: string;
  synced: boolean;
  utxoIndexed: boolean;
  covenantAware: boolean | null;
  virtualDaaScore: string;
  /** True when nothing that could produce a plausible wrong answer is wrong. */
  usable: boolean;
  notes: string[];
}

export interface Envelope<T> {
  ok: boolean;
  result: T;
  readFrom: ReadFrom;
  assumptions: Assumption[];
  /**
   * Repeated on every response, because it is the thing most likely to be
   * forgotten by whoever wires this into something else.
   */
  enforcement: string;
}

export const ENFORCEMENT =
  "Advisory. This service reads a node and re-derives what the covenant would " +
  "check; it enforces nothing. The covenant enforces, on chain, and it is the " +
  "only thing that can. A spend this service calls impossible is impossible " +
  "because the script refuses it, not because this said so.";

export function envelope<T>(result: T, readFrom: ReadFrom, assumptions: Assumption[] = []): Envelope<T> {
  return { ok: true, result, readFrom, assumptions, enforcement: ENFORCEMENT };
}

export interface ReportJson {
  address: string;
  scriptHash: string;
  found: boolean;
  value: Amount | null;
  covenantId: string | null;
  remaining: Amount;
  epochRemaining: Amount;
  maxNextSpend: Amount;
  boundBy: GrantReport["boundBy"];
  reclaimable: boolean;
  agrees: boolean;
  findings: Finding[];
}

export function reportJson(r: GrantReport): ReportJson {
  return {
    address: r.address,
    scriptHash: r.scriptHash,
    found: r.found,
    value: r.value === null ? null : amount(r.value),
    covenantId: r.covenantId,
    remaining: amount(r.remaining),
    epochRemaining: amount(r.epochRemaining),
    maxNextSpend: amount(r.maxNextSpend),
    boundBy: r.boundBy,
    reclaimable: r.reclaimable,
    agrees: r.agrees,
    findings: r.findings,
  };
}
