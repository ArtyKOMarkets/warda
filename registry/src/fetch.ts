import { candidatesIn, checkOrigin, verifyListingSignature, type ListingVerdict } from "./verify.ts";
import type { ServiceManifest } from "./manifest.ts";

export interface FetchOptions {
  /** Injected so tests do not reach the network and so a caller can impose its
   *  own timeout, proxy or user-agent. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Refuse a body larger than this. A registry that will read an arbitrary
   *  number of bytes from a stranger's server has handed that stranger a way
   *  to occupy it. */
  maxBytes?: number;
  timeoutMs?: number;
}

export const DEFAULT_MAX_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Fetch a listing from the operator's own domain and say whether it stands.
 *
 * This is the whole trust model in one function. The registry stores a URL and
 * nothing else; everything a listing claims is re-read from the operator's
 * server and re-checked here, every time. So a poisoned entry in the registry's
 * own store cannot make a bad listing appear — it can only point at a manifest
 * that fails this and drops out.
 *
 * It follows no redirects. A redirect is a way to move the host between the
 * check and the fetch, which is exactly the binding `checkOrigin` exists to
 * make; a listing that needs one is a listing published at the wrong URL.
 */
export async function fetchListing(url: string, opts: FetchOptions = {}): Promise<ListingVerdict> {
  const all = await fetchListings(url, opts);
  return all[0]!;
}

/**
 * Every listing a host publishes at one URL.
 *
 * `fetchListing` is the single-service convenience over this; the registry uses
 * this one, because a host that sells three things has three listings and
 * indexing one of them arbitrarily would be worse than indexing none.
 */
export async function fetchListings(url: string, opts: FetchOptions = {}): Promise<ListingVerdict[]> {
  const f = opts.fetch ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const checkedAt = new Date().toISOString();

  let body: string;
  try {
    const res = await f(url, {
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return [{ ok: false, failures: ["UNREACHABLE"], source: url, checkedAt }];
    }
    body = await res.text();
    if (body.length > maxBytes) {
      return [{ ok: false, failures: ["UNREACHABLE"], source: url, checkedAt }];
    }
  } catch {
    return [{ ok: false, failures: ["UNREACHABLE"], source: url, checkedAt }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [{ ok: false, failures: ["NOT_JSON"], source: url, checkedAt }];
  }

  return candidatesIn(parsed).map((candidate) => {
    const verdict = verifyListingSignature(candidate);
    verdict.source = url;

    /* Origin is checked even when the signature already failed, so an operator
       gets both problems in one reply rather than fixing one and discovering
       the other on the next attempt. */
    if (verdict.manifest) {
      const origin = checkOrigin(verdict.manifest as ServiceManifest, url);
      if (origin.length > 0) {
        verdict.ok = false;
        verdict.failures = [...new Set([...verdict.failures, ...origin])];
      }
    }
    return verdict;
  });
}
