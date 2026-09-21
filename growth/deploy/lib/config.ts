/**
 * The hosted Researcher's configuration, read per request and refused loudly.
 *
 * Every value is the operator's; none has a default that could quietly take
 * money. No payee: nothing to sell. No quote secret: quotes one instance signs
 * the next could not verify. No database: a payment could buy twice.
 */
import { openNode } from "@warda_protocol/vendor";
import { githubFetcher, type ResearcherConfig } from "./service.js";
import { postgresSpent } from "./spent.js";

export function config(origin: string): ResearcherConfig | { missing: string[] } {
  const env = process.env;
  const missing = ["RESEARCHER_ADDRESS", "GROWTH_QUOTE_SECRET", "DATABASE_URL"].filter((k) => !env[k]);
  if (missing.length) return { missing };
  const network = env.WARDA_NETWORK ?? "testnet-10";
  return {
    payTo: env.RESEARCHER_ADDRESS!,
    sompi: BigInt(env.RESEARCHER_PRICE_SOMPI ?? "5000000"),
    network,
    secret: env.GROWTH_QUOTE_SECRET!,
    spent: postgresSpent(env.DATABASE_URL!),
    fetcher: githubFetcher(env.GITHUB_TOKEN),
    openNode: () => openNode({ rpc: env.WARDA_RPC_JSON, network }),
    origin,
  };
}
