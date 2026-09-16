import { schnorr } from "@noble/curves/secp256k1.js";
import { fromHex, toHex } from "@warda_protocol/core";
import { listingDigest, type ServiceManifest, type SignedServiceManifest } from "./manifest.ts";

export type ListingFailure =
  | "NOT_JSON"
  | "UNKNOWN_VERSION"
  | "MISSING_FIELD"
  | "BAD_PAYEE"
  | "BAD_SIGNATURE_SHAPE"
  | "SIGNATURE_DOES_NOT_VERIFY"
  | "ENDPOINT_NOT_HTTPS"
  | "HOST_MISMATCH"
  | "UNREACHABLE";

export interface ListingVerdict {
  ok: boolean;
  failures: ListingFailure[];
  /** Present when the manifest parsed, even if it failed later — a caller
   *  fixing their listing needs to see what was read, not only that it was
   *  refused. */
  manifest?: SignedServiceManifest;
  /** What this verdict is a statement about. Null until a URL is involved. */
  source: string | null;
  /** The digest the signature should have been made over, so an operator whose
   *  signature does not verify can check their own signing code against it
   *  rather than guessing. */
  digest?: string;
  checkedAt: string;
}

const REQUIRED = ["name", "description", "endpoint", "capabilities", "pricing", "payment", "payee"] as const;

function shapeFailures(m: any): ListingFailure[] {
  const out: ListingFailure[] = [];
  if (m?.version !== 1) out.push("UNKNOWN_VERSION");
  for (const k of REQUIRED) {
    const v = m?.[k];
    if (v === undefined || v === null || v === "") return out.concat("MISSING_FIELD");
  }
  if (!Array.isArray(m.capabilities)) out.push("MISSING_FIELD");
  for (const k of ["asset", "amount", "unit"]) if (!m.pricing?.[k]) out.push("MISSING_FIELD");
  for (const k of ["protocol", "network"]) if (!m.payment?.[k]) out.push("MISSING_FIELD");
  if (typeof m.payee !== "string" || !/^[0-9a-f]{64}$/i.test(m.payee)) out.push("BAD_PAYEE");
  return [...new Set(out)];
}

/**
 * Does this manifest's signature prove the key it names signed these terms?
 *
 * That is the ONLY thing this function answers. It says nothing about whether
 * the service works, whether the price is real, or whether the operator is
 * honest — and the registry that calls it repeats that wherever it renders a
 * listing.
 */
export function verifyListingSignature(input: unknown): ListingVerdict {
  const checkedAt = new Date().toISOString();
  const m = input as SignedServiceManifest;
  if (typeof m !== "object" || m === null) {
    return { ok: false, failures: ["NOT_JSON"], source: null, checkedAt };
  }

  const failures = shapeFailures(m);
  if (typeof m.signature !== "string" || !/^[0-9a-f]{128}$/i.test(m.signature)) {
    failures.push("BAD_SIGNATURE_SHAPE");
  }
  if (failures.length > 0) {
    return { ok: false, failures: [...new Set(failures)], manifest: m, source: null, checkedAt };
  }

  let digest: Uint8Array;
  try {
    digest = listingDigest(m as ServiceManifest);
  } catch {
    return { ok: false, failures: ["MISSING_FIELD"], manifest: m, source: null, checkedAt };
  }

  let good = false;
  try {
    good = schnorr.verify(fromHex(m.signature), digest, fromHex(m.payee));
  } catch {
    good = false;
  }

  return {
    ok: good,
    failures: good ? [] : ["SIGNATURE_DOES_NOT_VERIFY"],
    manifest: m,
    source: null,
    digest: toHex(digest),
    checkedAt,
  };
}

/**
 * The second half of a listing, and the half a signature cannot give you.
 *
 * A signature proves control of the key the service is paid at. It does not
 * prove control of the service — anyone can copy a published manifest and
 * serve it from their own domain, signature and all, because a signature is
 * public. What stops that is WHERE the manifest was found: a listing is only
 * a listing when it is served from the same host as the endpoint it names.
 *
 * Without this check the registry would happily index a copy of somebody
 * else's manifest, and the copy would verify perfectly.
 *
 * https only, because a manifest fetched over http is a manifest anyone on the
 * path can replace, and the payee key inside it is where money goes.
 */
export function checkOrigin(m: ServiceManifest, sourceUrl: string): ListingFailure[] {
  const out: ListingFailure[] = [];
  let endpoint: URL, source: URL;
  try {
    endpoint = new URL(m.endpoint);
    source = new URL(sourceUrl);
  } catch {
    return ["HOST_MISMATCH"];
  }
  if (endpoint.protocol !== "https:" || source.protocol !== "https:") out.push("ENDPOINT_NOT_HTTPS");
  if (endpoint.host !== source.host) out.push("HOST_MISMATCH");
  return out;
}

/**
 * What a well-known document may contain.
 *
 * ONE HOST, SEVERAL SERVICES. The well-known path is per host, and a host can
 * sell more than one thing: warda-demo-api.vercel.app serves /fact at 0.03 to
 * one payee and /digest at 0.04 to another. A document that could describe only
 * one of them would force an operator to choose which of their own services is
 * listable.
 *
 * That is the same wrong assumption /network already had to correct in the
 * other direction — attributing payments by payee credited one listing with all
 * of its neighbour's traffic, because a key serves whatever its owner sells.
 * Making it again here, in a format published on other people's servers, would
 * be far more expensive to undo.
 *
 * Each entry is signed INDEPENDENTLY by its own payee key, so one host's
 * services do not have to share a key and one bad entry does not invalidate the
 * others. A single bare manifest is still accepted: a host selling one thing
 * should not have to wrap it in a list.
 */
export function candidatesIn(input: unknown): unknown[] {
  if (typeof input !== "object" || input === null) return [input];
  const doc = input as Record<string, unknown>;
  if (Array.isArray(doc.services)) return doc.services;
  return [input];
}

/** Where a service publishes its listing. */
export const WELL_KNOWN_PATH = "/.well-known/warda-service.json";

export function wellKnownFor(endpoint: string): string {
  return new URL(WELL_KNOWN_PATH, endpoint).toString();
}
