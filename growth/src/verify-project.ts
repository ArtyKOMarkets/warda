/**
 * What Researcher sells: a record somebody else can check.
 *
 * ## Why it does not ask a model what it thinks
 *
 * The plan this came from wanted a "score with evidence for each criterion".
 * A score is the part nobody can check, and this whole system's claim is that
 * each link in the chain is verifiable by the next one and by the buyer. So
 * Researcher returns FACTS, each with the URL it came from, and an explicit
 * list of what it could not establish. A buyer who disagrees can open the same
 * URLs and see the same things.
 *
 * That is a smaller promise than "qualified lead" and a much harder one to
 * fake, which is the point. An unverifiable score is worth nothing from a
 * stranger, and a stranger is what this is.
 *
 * ## Why the fetch is injected
 *
 * Every finding here depends on a network answer, and a service tested against
 * the live internet is a service whose tests fail when GitHub rate-limits. The
 * seam is one argument.
 */

export type Fetcher = (url: string) => Promise<{ status: number; body: string }>;

export interface Finding {
  /** What was established. */
  fact: string;
  /** Where anyone can see it for themselves. */
  source: string;
}

export interface Record {
  /** What was asked about. */
  project: string;
  checkedAt: string;
  /** Established, each with its source. */
  findings: Finding[];
  /** Not established, and named — the half a score would have hidden. */
  unverified: string[];
  /** Signals relevant to whether an agent here would need to pay for things. */
  signals: string[];
}

const PAYMENT_WORDS = [
  "x402", "http 402", "402 payment", "micropayment", "pay-per-call",
  "usage-based", "api key billing", "stripe", "metered",
];
const AGENT_WORDS = ["autonomous agent", "ai agent", "agentic", "mcp server", "tool use"];

/** A GitHub repo's owner/name, or null if the url is not one. */
export function repoOf(url: string): { owner: string; name: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
  const [owner, name] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !name) return null;
  return { owner, name: name.replace(/\.git$/, "") };
}

/**
 * Verify what can be verified about a project, and say what cannot.
 *
 * Never throws on a project that is simply not there: "the URL did not
 * resolve" is a finding a buyer paid for, and an exception would look like the
 * service failing rather than the project being absent.
 */
export async function verifyProject(url: string, fetcher: Fetcher, now = new Date()): Promise<Record> {
  const findings: Finding[] = [];
  const unverified: string[] = [];
  const signals: string[] = [];
  const record: Record = { project: url, checkedAt: now.toISOString(), findings, unverified, signals };

  const repo = repoOf(url);
  if (!repo) {
    /* Not a refusal. Plenty of real projects are not on GitHub, and a service
       that only answers for one host is a service that answers "no" a lot. */
    const page = await fetcher(url).catch(() => ({ status: 0, body: "" }));
    if (page.status === 0) {
      findings.push({ fact: "the url could not be reached at all", source: url });
      unverified.push("everything else — nothing answered");
      return record;
    }
    findings.push({ fact: `the page answers HTTP ${page.status}`, source: url });
    const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(page.body)?.[1]?.trim();
    if (title) findings.push({ fact: `its title is "${title}"`, source: url });
    scan(page.body, signals);
    unverified.push(
      "whether the project is active — a page gives no commit history",
      "who maintains it, and how to reach them",
    );
    return record;
  }

  const api = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
  const res = await fetcher(api).catch(() => ({ status: 0, body: "" }));
  if (res.status === 404) {
    findings.push({ fact: "no public repository at that path", source: api });
    unverified.push("whether it exists privately, or moved");
    return record;
  }
  if (res.status !== 200) {
    findings.push({ fact: `GitHub answered HTTP ${res.status} rather than the repository`, source: api });
    unverified.push("everything about the project — this is a fact about the request, not about it");
    return record;
  }

  let meta: {
    full_name?: string; description?: string | null; language?: string | null;
    stargazers_count?: number; pushed_at?: string; archived?: boolean; homepage?: string | null;
  };
  try {
    meta = JSON.parse(res.body);
  } catch {
    findings.push({ fact: "GitHub answered 200 with something that is not JSON", source: api });
    unverified.push("everything about the project");
    return record;
  }

  findings.push({ fact: `the repository ${meta.full_name ?? `${repo.owner}/${repo.name}`} is public`, source: api });
  if (meta.description) findings.push({ fact: `it describes itself as "${meta.description}"`, source: api });
  if (meta.language) findings.push({ fact: `its main language is ${meta.language}`, source: api });
  if (typeof meta.stargazers_count === "number") {
    findings.push({ fact: `${meta.stargazers_count} stars`, source: api });
  }

  if (meta.archived) {
    findings.push({ fact: "it is ARCHIVED, so it is not accepting changes", source: api });
  }
  if (meta.pushed_at) {
    const days = Math.floor((now.getTime() - Date.parse(meta.pushed_at)) / 86_400_000);
    findings.push({
      fact: `last pushed ${meta.pushed_at.slice(0, 10)}, which is ${days} day${days === 1 ? "" : "s"} ago`,
      source: api,
    });
  } else {
    unverified.push("when it was last active");
  }

  /* The readme, for signals rather than for judgement. A word appearing is a
     fact; what it implies is the buyer's call. */
  const readme = await fetcher(`${api}/readme`).catch(() => ({ status: 0, body: "" }));
  if (readme.status === 200) {
    try {
      const parsed = JSON.parse(readme.body) as { content?: string; encoding?: string; html_url?: string };
      const text = parsed.encoding === "base64" && parsed.content
        ? Buffer.from(parsed.content, "base64").toString("utf8")
        : "";
      scan(text, signals, parsed.html_url ?? `${api}/readme`);
    } catch {
      unverified.push("the readme's contents — it did not decode");
    }
  } else {
    unverified.push("the readme's contents — it was not readable");
  }

  unverified.push(
    "whether anyone there wants to pay for anything, which only they can say",
    "who to contact, and whether they welcome being contacted",
  );
  return record;
}

/** Words present, with where they were seen. Never a conclusion. */
function scan(text: string, into: string[], source?: string) {
  const hay = text.toLowerCase();
  const seen = (words: string[], label: string) => {
    const hits = words.filter((w) => hay.includes(w));
    if (hits.length) into.push(`${label}: ${hits.join(", ")}${source ? ` (${source})` : ""}`);
  };
  seen(PAYMENT_WORDS, "mentions paying for things");
  seen(AGENT_WORDS, "mentions agents");
}
