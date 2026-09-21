/**
 * Scout: finds projects worth researching. It pays nobody for this part.
 *
 * GitHub's search API is free, so the only thing Scout's grant pays for is the
 * work it cannot do itself: a record from Researcher, one per candidate, that
 * somebody else can check. Scout's output is a SHORTLIST with the search that
 * produced each entry, not a judgement — "matched `x402` in its readme" is a
 * fact; "wants Warda" is a guess, and guesses do not leave this file.
 *
 * ## Not only Kaspa
 *
 * The people who need a spending limit for an agent are the ones building
 * agents that pay for things: x402 sellers and buyers, MCP servers that meter,
 * agent frameworks with wallets. Kaspa projects are one query among several.
 *
 * ## Why the fetch is injected
 *
 * Same reason as Researcher: a scout tested against live GitHub is a test that
 * fails when GitHub rate-limits, and the answers worth pinning are the bad ones.
 */
import type { Fetcher } from "./verify-project.ts";

export interface Query {
  /** A short name for the report: why this candidate was looked at. */
  label: string;
  /** GitHub search syntax, without the date filter — `since` is added. */
  q: string;
}

/** What a week looks at. Edited here, reviewed like code, not typed at a prompt. */
export const QUERIES: Query[] = [
  /* Plain terms only: GitHub's repository search takes quoted phrases, OR and
     qualifiers, but not reliably parentheses, and a query it cannot parse
     answers 422 rather than nothing. */
  { label: "x402", q: "x402 in:name,description,readme" },
  { label: "agent payments", q: "\"agent payments\" OR \"agentic payments\" in:description,readme" },
  { label: "paid MCP server", q: "\"mcp server\" payments in:description,readme" },
  { label: "agent wallet", q: "\"agent wallet\" in:description,readme" },
  { label: "AI agent + stablecoin", q: "\"ai agent\" usdc in:description,readme" },
  { label: "Kaspa", q: "kaspa in:name,description,topics" },
];

export interface Candidate {
  url: string;
  fullName: string;
  description: string | null;
  stars: number;
  pushedAt: string;
  /** Every query that found it, so the report says why it is here. */
  matched: string[];
  /** The search it came from, which anyone can re-run. */
  source: string;
}

export interface ScoutOptions {
  /** Only repositories pushed on or after this day. */
  since: string;
  /** Fewer stars than this is usually a weekend experiment. */
  minStars?: number;
  /** Never researched twice: full names already bought, in any past batch. */
  seen?: Set<string>;
  /** How many to hand Researcher. Each one costs a payment. */
  limit: number;
  /** Per query. GitHub allows 100; a week needs far fewer. */
  perQuery?: number;
  /**
   * Between searches. GitHub allows 10 search requests a minute without a
   * token, and six queries back to back got three 403s on the first real run.
   * The runner passes ~7 s without GITHUB_TOKEN and nothing with one.
   */
  pauseMs?: number;
  /** A 403/429 is retried once after this long. */
  retryAfterMs?: number;
}

/* Reading lists, paper collections and "awesome" indexes match every search
   and are nobody's product. A record about one is money spent on a table of
   contents. */
const NOT_A_PROJECT = /(^|[-_/])(awesome|papers?|list|reading|resources|curated|survey)([-_]|$)/i;

export interface ScoutResult {
  candidates: Candidate[];
  /** What was searched and what each search answered — the report prints it. */
  searched: { label: string; url: string; status: number; found: number }[];
}

export function searchUrl(query: Query, since: string, perQuery = 30): string {
  const q = `${query.q} pushed:>=${since} archived:false fork:false`;
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${perQuery}`;
}

/**
 * Run every query, merge, drop what has been bought before, rank, cut.
 *
 * Ranking is deliberately dull and printed: more queries matched first, then
 * stars, then recency. A clever score is the thing Researcher refuses to sell,
 * and Scout does not get to smuggle one in upstream.
 */
export async function scout(fetcher: Fetcher, options: ScoutOptions, queries: Query[] = QUERIES): Promise<ScoutResult> {
  const minStars = options.minStars ?? 5;
  const seen = options.seen ?? new Set<string>();
  const byName = new Map<string, Candidate>();
  const searched: ScoutResult["searched"] = [];

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const [i, query] of queries.entries()) {
    if (i > 0 && options.pauseMs) await wait(options.pauseMs);
    const url = searchUrl(query, options.since, options.perQuery);
    let res = await fetcher(url).catch(() => ({ status: 0, body: "" }));
    if ((res.status === 403 || res.status === 429) && options.retryAfterMs) {
      await wait(options.retryAfterMs);
      res = await fetcher(url).catch(() => ({ status: 0, body: "" }));
    }
    let items: {
      full_name?: string; html_url?: string; description?: string | null;
      stargazers_count?: number; pushed_at?: string; archived?: boolean; fork?: boolean;
    }[] = [];
    if (res.status === 200) {
      try {
        items = (JSON.parse(res.body) as { items?: typeof items }).items ?? [];
      } catch {
        items = [];
      }
    }
    searched.push({ label: query.label, url, status: res.status, found: items.length });

    for (const it of items) {
      if (!it.full_name || !it.html_url || it.archived || it.fork) continue;
      if (NOT_A_PROJECT.test(it.full_name.split("/")[1] ?? "")) continue;
      if ((it.stargazers_count ?? 0) < minStars) continue;
      const key = it.full_name.toLowerCase();
      if (seen.has(key)) continue;
      /* Our own repositories are not prospects. */
      if (key.startsWith("artykomarkets/")) continue;
      const have = byName.get(key);
      if (have) {
        if (!have.matched.includes(query.label)) have.matched.push(query.label);
        continue;
      }
      byName.set(key, {
        url: it.html_url,
        fullName: it.full_name,
        description: it.description ?? null,
        stars: it.stargazers_count ?? 0,
        pushedAt: it.pushed_at ?? "",
        matched: [query.label],
        source: url,
      });
    }
  }

  const candidates = [...byName.values()]
    .sort((a, b) =>
      b.matched.length - a.matched.length ||
      b.stars - a.stars ||
      b.pushedAt.localeCompare(a.pushedAt))
    .slice(0, options.limit);
  return { candidates, searched };
}
