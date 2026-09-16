import { fetchListing, type FetchOptions } from "./fetch.ts";
import { search, type Query } from "./match.ts";
import type { ListingVerdict } from "./verify.ts";
import type { SignedServiceManifest } from "./manifest.ts";

/**
 * The registry, as one function from Request to Response.
 *
 * Framework-free on purpose: a Vercel function, a Node server and a test all
 * hand it a Request and read a Response, so the thing that is deployed is the
 * thing the tests exercise. The alternative — a handler shaped around one
 * host's API — is a service whose behaviour under test is a paraphrase of its
 * behaviour in production.
 *
 * ## What this service is allowed to be
 *
 * Not required. An agent that already knows an endpoint pays without asking
 * this anything, and a service found once never needs it again. If this were
 * in the payment path, a protocol whose whole claim is that authority lives in
 * consensus would have a single host it depends on.
 *
 * So every route here is a convenience over a convention that works without
 * it: a listing is a signed manifest at a well-known path on the operator's
 * own domain, and anyone can fetch and check one with no registry involved.
 */

export interface RegistryConfig {
  /** The curated index: URLs of manifests to offer under an empty query.
   *  Pointers, not claims — every one is re-fetched and re-verified per
   *  request, so an entry here cannot make a bad listing appear. */
  sources: string[];
  fetchOptions?: FetchOptions;
  /** Seconds a browse response may be cached. Short: the whole point is that a
   *  listing which stops verifying stops being listed. */
  maxAgeSeconds?: number;
}

export interface ListedService extends SignedServiceManifest {
  /** Where this was read from, and when. Both are facts about the registry's
   *  reading rather than claims by the operator, so they are namespaced away
   *  from the manifest's own fields. */
  _source: string;
  _verifiedAt: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function queryFrom(params: URLSearchParams): Query {
  const caps = params.getAll("capability").flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean);
  const q: Query = {};
  if (caps.length > 0) q.capability = caps;
  const maxPrice = params.get("maxPrice");
  if (maxPrice !== null) q.maxPrice = maxPrice;
  const network = params.get("network");
  if (network !== null) q.network = network;
  const text = params.get("q");
  if (text !== null) q.q = text;
  return q;
}

/** Read every source, keep the ones that stand, and report the ones that do not. */
export async function readIndex(config: RegistryConfig): Promise<{
  listings: ListedService[];
  dropped: { source: string; failures: string[] }[];
}> {
  const verdicts = await Promise.all(
    config.sources.map((u) => fetchListing(u, config.fetchOptions)),
  );
  const listings: ListedService[] = [];
  const dropped: { source: string; failures: string[] }[] = [];
  for (const v of verdicts) {
    if (v.ok && v.manifest) {
      listings.push({ ...v.manifest, _source: v.source!, _verifiedAt: v.checkedAt });
    } else {
      dropped.push({ source: v.source ?? "?", failures: v.failures });
    }
  }
  return { listings, dropped };
}

export async function handle(req: Request, config: RegistryConfig): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...JSON_HEADERS, "access-control-allow-methods": "GET, OPTIONS" },
    });
  }
  if (req.method !== "GET") {
    return json({ error: "method_not_allowed", allowed: ["GET"] }, 405);
  }

  /* ---- verify one listing, by URL -------------------------------------
     The self-serve half, and it needs no storage at all. An operator checks
     their own listing before anyone indexes it; an agent checks a listing it
     was told about without trusting this service's index. Same code path the
     index uses, so a listing that passes here passes there. */
  if (path === "/verify") {
    const target = url.searchParams.get("url");
    if (!target) {
      return json({ error: "missing_url", hint: "/verify?url=https://your-domain/.well-known/warda-service.json" }, 400);
    }
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return json({ error: "not_a_url", url: target }, 400);
    }
    if (parsed.protocol !== "https:") {
      return json({ error: "not_https", url: target,
        why: "a manifest fetched over http is one anyone on the path can replace, and it names the key money goes to" }, 400);
    }
    const verdict: ListingVerdict = await fetchListing(target, config.fetchOptions);
    return json(verdict, verdict.ok ? 200 : 422, { "cache-control": "no-store" });
  }

  if (path === "/" || path === "/services") {
    const { listings, dropped } = await readIndex(config);
    const q = queryFrom(url.searchParams);
    const matched = search(listings, q);
    return json(
      {
        count: matched.length,
        indexed: config.sources.length,
        query: q,
        services: matched,
        /* Reported rather than hidden. A source that stopped verifying is the
           registry working; silently shrinking the list would look like the
           operator was never there. */
        dropped,
        note:
          "Every listing here was re-fetched from its operator's own domain and its signature " +
          "re-checked just now. The registry indexes; it does not vouch. Prices and availability " +
          "are the operator's claims about themselves.",
      },
      200,
      { "cache-control": `public, max-age=${config.maxAgeSeconds ?? 60}, must-revalidate` },
    );
  }

  return json({ error: "not_found", routes: ["/", "/services", "/verify?url="] }, 404);
}
