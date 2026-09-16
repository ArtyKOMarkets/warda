/**
 * Finding a service to buy from.
 *
 * ## The promise this tool has to be careful with
 *
 * Every other tool on this server says NO CHAIN READ, and means something
 * stronger than it sounds: this process makes no outbound connections at all.
 * That is what makes a hosted instance safe to point an agent at — the worst a
 * compromise of the host achieves is wrong advice, and the covenant does not
 * consult advice.
 *
 * Discovery cannot be that, because a listing lives on the operator's own
 * server and has to be read from there. So this tool does reach the network,
 * and the design question is not whether but WHERE TO.
 *
 * It talks to exactly ONE host: the Warda registry. It does not fetch operator
 * domains itself, and it will not follow a URL an agent hands it. A tool on a
 * public endpoint that fetched arbitrary URLs on request would be a
 * server-side request forgery surface with a documentation page, and the fact
 * that the URLs are "service listings" would not make it less of one.
 *
 * The registry does the fetching, in its own process, where it is the only
 * thing at risk. That is the whole reason the registry is an HTTP service
 * rather than a library this server imports.
 *
 * ## What comes back is not a recommendation
 *
 * The registry verifies two things and repeats everything else. It verifies
 * that the operator controls the key the service is paid at, and that the
 * manifest was served from the same host as the endpoint it names. It does not
 * verify the price is real, that the service works, or that it is worth
 * paying. Those are the operator's claims about themselves, and they arrive
 * labelled as such so an agent can weigh them rather than trust them.
 *
 * There is no ranking, and an agent should not read the order as one.
 */
import { z } from "zod";

export const DEFAULT_REGISTRY = "https://registry.wardaprotocol.com";

export interface FindArgs {
  capability?: string[];
  maxPrice?: string;
  network?: string;
  q?: string;
}

export const FindShape = {
  capability: z
    .array(z.string())
    .optional()
    .describe("Capabilities the service must offer, ALL of them. e.g. ['weather.current']"),
  maxPrice: z
    .string()
    .optional()
    .describe("Most you will pay per unit, as a decimal string in the asset's own units, e.g. '0.05'."),
  network: z.string().optional().describe("e.g. 'kaspa:testnet-10'. Omit for any."),
  q: z.string().optional().describe("Plain substring over name and description. Crude on purpose."),
};

export function registryUrl(args: FindArgs, base = process.env.WARDA_REGISTRY ?? DEFAULT_REGISTRY): string {
  const u = new URL("/services", base);
  for (const c of args.capability ?? []) u.searchParams.append("capability", c);
  if (args.maxPrice !== undefined) u.searchParams.set("maxPrice", args.maxPrice);
  if (args.network !== undefined) u.searchParams.set("network", args.network);
  if (args.q !== undefined) u.searchParams.set("q", args.q);
  return u.toString();
}

export interface FindResult {
  count: number;
  services: unknown[];
  registry: string;
  note: string;
  unreachable?: string;
}

/**
 * A registry that is down must not look like a world with no services in it.
 *
 * Returning `{count: 0}` when the lookup failed is the flattering failure: an
 * agent reads "nothing matched", narrows its query, and concludes the market
 * is empty. So an unreachable registry is reported as an unreachable registry,
 * with `count` absent rather than zero.
 */
export async function findServices(
  args: FindArgs,
  opts: { fetch?: typeof globalThis.fetch; base?: string; timeoutMs?: number } = {},
): Promise<FindResult> {
  const f = opts.fetch ?? globalThis.fetch;
  const url = registryUrl(args, opts.base ?? process.env.WARDA_REGISTRY ?? DEFAULT_REGISTRY);
  try {
    const res = await f(url, {
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry answered ${res.status}`);
    const body = (await res.json()) as { count: number; services: unknown[]; note?: string };
    return {
      count: body.count,
      services: body.services,
      registry: url,
      note:
        (body.note ?? "") +
        " Nothing here is ranked, and being listed is not an endorsement. An agent that already " +
        "knows an endpoint does not need this: a listing is a signed manifest at " +
        "/.well-known/warda-service.json on the operator's own domain, readable without any registry.",
    };
  } catch (e) {
    return {
      count: undefined as unknown as number,
      services: [],
      registry: url,
      unreachable: e instanceof Error ? e.message : String(e),
      note:
        "The registry could not be reached, so this is NOT a statement that nothing matched — " +
        "`count` is absent rather than zero for exactly that reason. Discovery is never in the " +
        "payment path: if you already know an endpoint, pay it.",
    };
  }
}
