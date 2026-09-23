/**
 * Listener: finds conversations on X where Warda has something to say.
 *
 * Scout's sibling, and deliberately the same shape: queries written here and
 * reviewed like code, an injected fetcher so the tests pin the answers that
 * matter, and a ranking that is dull and printed rather than clever and
 * hidden. The difference is the unit. Scout finds PROJECTS, which stay
 * findable for months; this finds POSTS, which are dead in a day or two. That
 * one fact decides almost everything below.
 *
 * ## What it does not do
 *
 * It does not decide whether to reply, and it does not write the reply. It
 * produces a shortlist with the reason each entry is on it, the same contract
 * Scout has with Researcher: "matched `x402` and three people are arguing
 * about spending limits" is a fact; "this person wants Warda" is a guess, and
 * guesses do not leave this file.
 *
 * ## Why a score at all, when Researcher refuses to sell one
 *
 * Because the cost here is ATTENTION rather than money, and the list is long.
 * Researcher refuses to score because a buyer cannot check a score; this score
 * is not sold to anyone, it decides which twelve of two hundred posts are
 * worth a Telegram message, and every component of it is printed beside the
 * post so a wrong ranking is visible rather than mysterious. When the reasons
 * stop matching the posts, the rule is wrong and you can see that it is.
 */

export type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; body: string }>;

export interface Query {
  /** A short name for the report: why this post was looked at. */
  label: string;
  /** X search syntax, without the recency window — `since` is added. */
  q: string;
}

/**
 * What a run looks at. Edited here, reviewed like code, not typed at a prompt.
 *
 * `-is:retweet` on every one of them: a retweet is not a conversation, it is
 * the same conversation counted twice, and paying to read it twice is the
 * cheapest mistake available here. `lang:en` because a reply in a language
 * nobody here writes is not an opportunity, it is a liability.
 */
export const QUERIES: Query[] = [
  { label: "x402", q: "x402 -is:retweet lang:en" },
  { label: "agent payments", q: "(\"agent payments\" OR \"agentic payments\" OR \"agents pay\") -is:retweet lang:en" },
  { label: "agent wallet", q: "(\"agent wallet\" OR \"wallet for agents\") -is:retweet lang:en" },
  { label: "spending limits", q: "(\"spending limit\" OR \"spend limit\" OR \"budget\") (agent OR agents OR AI) -is:retweet lang:en" },
  { label: "paid MCP", q: "(MCP OR \"model context protocol\") (payment OR paid OR monetize OR billing) -is:retweet lang:en" },
  { label: "autonomous agents + money", q: "(\"autonomous agent\" OR \"autonomous agents\") (money OR payment OR spend OR wallet) -is:retweet lang:en" },
  { label: "machine payments", q: "(\"machine payments\" OR \"machine-to-machine\" OR m2m) (payment OR pay) -is:retweet lang:en" },
  { label: "Kaspa", q: "kaspa (agent OR agents OR payments OR x402) -is:retweet lang:en" },
];

/** A post as this module needs it, whatever the API around it looks like. */
export interface Post {
  id: string;
  url: string;
  text: string;
  author: { handle: string; name: string | null; followers: number; verified: boolean };
  at: string;
  likes: number;
  replies: number;
  reposts: number;
  /** Every query that found it, so the report says why it is here. */
  matched: string[];
}

export interface Scored {
  post: Post;
  score: number;
  /** Every component, in the order it was applied. Printed beside the post. */
  why: string[];
  band: "high" | "worth a look" | "skip";
}

/**
 * ## What the first real run taught this file
 *
 * Six queries, sixty posts, $0.30. Of the six it surfaced, four were
 * marketing or news and one was a real thread — and the best post in the run,
 * a stranger asking "what safeguards exist against unauthorized transactions
 * when giving an agent a wallet", was scored 5 and cut.
 *
 * Three causes, and all three were the rule rewarding the SHAPE of a sentence
 * rather than the fact behind it:
 *
 *   - "someone is building" fired on `built|building`, which is what a press
 *     release says about itself. "BAI Is Building The Infrastructure That
 *     Connects AI Intelligence" is not a person with a problem.
 *   - "a question, so there is an opening" fired on any `?`, including
 *     "BLACKROCK MAKES A BET ON WEB4?", which is a headline.
 *   - "no discussion yet" penalised posts with no replies, which on a
 *     twice-daily agent is exactly backwards: being early is the advantage,
 *     and a post forty minutes old has not had time to have replies.
 *
 * So the signals below are narrower and mostly first-person. A marketing
 * sentence is written about a product; a person with the problem writes about
 * themselves. That distinction is cheap to test for and it is the whole
 * difference between the two lists above.
 */

/** Promotion, which matches every payments query and is never a conversation. */
const NOT_A_CONVERSATION = /\b(airdrop|giveaway|presale|whitelist|claim now|dm me|guaranteed|1000x|moon|pump)\b/i;

/** A launch announcement. Adjacent to relevant and never somewhere to reply. */
const PROMO = /(\bintroducing\b|\bnow live\b|\bwe'?re live\b|\bearly access\b|\bwaitlist\b|\bjoin the\b|\bdon'?t miss\b|\bis building the\b|🚀)/i;

/** Coverage of somebody else's announcement. Relevant topic, no opening. */
const NEWSY = /\b(report|study|paper|whitepaper|announces|announced|unveils|unveiled|launches|launched|according to|just put out|just released)\b/i;

/** A post that is only a link and some tags is an announcement, not a discussion. */
const MOSTLY_LINKS = (text: string) => text.replace(/https?:\/\/\S+/g, "").replace(/[#@]\S+/g, "").trim().length < 40;

/**
 * Somebody describing their OWN work. This is the signal that survived: a
 * person says "I built", "my agent", "we shipped"; a launch says "X is
 * building". The grammar is the tell, and it costs one regex.
 */
const FIRST_PERSON = /\b(i|we|my|our)\s+\w{0,6}\s?(built|build|building|shipped|made|wrote|ran|running|run|deployed|tried|hit|use|using|switched|tested)\b|\b(my|our)\s+(@?[\w.-]+\s+){0,2}(agent|agents|bot|wallet|script|setup)\b/i;

/** Concrete nouns. Weak on their own — a topic, not a person with a problem. */
const TECHNICAL = /\b(402|sdk|endpoint|repo|github|testnet|mainnet|webhook|api key|signature|private key|rate limit)\b/i;

/**
 * Somebody actually asking. Not any `?` — headlines end in those too. Only
 * the forms a person uses when they want an answer.
 */
const ASKING = /\b(how do (i|you)|how are (you|people)|anyone (know|tried|using|else|got)|does anyone|has anyone|looking for|what'?s the best|is there a|any (recommendations|suggestions|ideas)|struggling with|can'?t figure|not sure how|what safeguards|what stops)\b/i;

/**
 * The question Warda answers, asked by somebody who does not know Warda
 * exists: an agent, and a worry about what it is able to spend.
 *
 * Two tests rather than one pattern, because the first attempt required the
 * agent word to come BEFORE the worry — and the post this was written for
 * puts them the other way round ("What safeguards exist … when giving an
 * agent a wallet"). Co-occurrence is what matters in 280 characters; order
 * is an accident of how the sentence was built.
 *
 * The authority list is phrases, not words. Bare `budget` and bare `limit`
 * are everywhere — "my AI budget has been 60% openai" is a real post from the
 * same run, and it is not somebody asking what bounds an agent.
 */
const AGENTY = /\b(agents?|agentic|bot|ai)\b/i;
const AUTHORITY = /(\bsafeguards?\b|\bunauthori[sz]ed\b|\boverspend\w*|\bdrain(ed|ing)?\b|\bgoes rogue\b|\bguardrails?\b|\bblast radius\b|\bdelegated consent\b|\bspend(ing)? (limit|cap)s?\b|\bbudget cap\b|\bcap on\b|\blimits? on what\b|\b(allowed|able) to spend\b|\bcan spend\b|\bstops? it spending\b|\bwithout a human\b)/i;
const THE_QUESTION = (text: string) => AGENTY.test(text) && AUTHORITY.test(text);

export interface ScoreOptions {
  /** Below this, it is not sent. Default 5. */
  floor?: number;
  /** At or above this, it is a HIGH VALUE message. Default 9. */
  high?: number;
  /** Handles never worth reporting — ours, and anyone already talked to. */
  mute?: Set<string>;
}

/**
 * The rule, in one place, in the order it reads.
 *
 * Deliberately small integers rather than weights to three decimal places. A
 * score of 11 made of five named reasons can be argued with; a score of 0.834
 * can only be believed.
 */
export function score(post: Post, options: ScoreOptions = {}): Scored {
  const floor = options.floor ?? 5;
  const high = options.high ?? 9;
  const why: string[] = [];
  let n = 0;

  const add = (points: number, reason: string) => { n += points; why.push(`${points > 0 ? "+" : ""}${points} ${reason}`); };

  /* Relevance: how many separate searches found it. Two queries agreeing is
     a much stronger signal than either alone, so this is per-query and not a
     flat "matched". */
  add(post.matched.length * 2, post.matched.length === 1 ? `matched ${post.matched[0]}` : `matched ${post.matched.join(", ")}`);

  const hours = (Date.now() - new Date(post.at).getTime()) / 3_600_000;

  /* The three signals about the POST rather than about the search. At least
     one has to fire or nothing below can lift this over the floor — see the
     band rule at the end. */
  const theQuestion = THE_QUESTION(post.text);
  const firstPerson = FIRST_PERSON.test(post.text);
  const asking = ASKING.test(post.text);

  if (theQuestion) add(5, "asking what bounds an agent — the question Warda answers");
  if (firstPerson) add(4, "describing their own work, not a product's");
  else if (TECHNICAL.test(post.text)) add(1, "concrete, but not first-hand");
  if (asking) add(3, "actually asking, not a headline");

  /* Account quality. Followers are a weak proxy and treated as one: a bounded
     bonus, never a multiplier, because a 500k-follower take is not worth more
     of your time than a 500-follower person with the actual problem. */
  if (post.author.followers >= 20_000) add(1, "large account");
  else if (post.author.followers < 50) add(-2, "almost no followers");

  /* Engagement, and replies count double: likes mean people saw it, replies
     mean people are TALKING. But silence on a post that is an hour old is not
     evidence of anything — it is a post that is an hour old, and being there
     first is the advantage a twice-daily agent has. */
  const talk = post.replies * 2 + post.reposts;
  if (talk >= 20) add(3, `${post.replies} replies, ${post.reposts} reposts`);
  else if (talk >= 5) add(2, `${post.replies} replies, ${post.reposts} reposts`);
  else if (hours <= 3) add(1, "early — no replies yet, and that is the opening");
  else if (post.likes >= 50) add(1, `${post.likes} likes but few replies`);
  else add(-1, "no discussion, and old enough that there should be");

  if (NOT_A_CONVERSATION.test(post.text)) add(-8, "reads like promotion");
  if (PROMO.test(post.text)) add(-5, "a launch announcement");
  if (NEWSY.test(post.text) && !FIRST_PERSON.test(post.text)) add(-3, "coverage of somebody else's news");
  if (MOSTLY_LINKS(post.text)) add(-4, "a link and tags, not a point");
  if (options.mute?.has(post.author.handle.toLowerCase())) add(-99, "muted handle");

  /* Age. Not a penalty on a curve — a hard statement about whether you can
     still join. A thread from Tuesday is not a smaller opportunity than one
     from an hour ago; it is not an opportunity. */
  if (hours > 48) add(-6, `${Math.round(hours)}h old, the thread has moved on`);
  else if (hours > 24) add(-2, `${Math.round(hours)}h old`);

  /**
   * Keywords and a clock are not a reason to interrupt somebody.
   *
   * The second real run put three posts in the top six on `+4 matched two
   * queries` and `+1 early` alone — five points, nothing of it about the post.
   * A post can match two searches by coincidence and be recent by luck; that
   * combination says the search worked, not that there is a conversation to
   * join. So the floor needs one signal about the post itself, and the score
   * is left alone rather than fudged: it reports what it found, and this
   * decides what that is worth.
   */
  const band = !(theQuestion || firstPerson || asking)
    ? "skip" as const
    : n >= high ? "high" as const : n >= floor ? "worth a look" as const : "skip" as const;
  if (band === "skip" && n >= floor) why.push("(nothing about the post itself, only the search)");

  return { post, score: n, why, band };
}

/**
 * What makes two posts the same post.
 *
 * Handle included, because two people saying "23.2M transactions in four
 * weeks" in the same thread are two people, and only one of them is a
 * duplicate of themselves. Links and mentions stripped, because a reposted
 * line usually differs only in its trailing t.co.
 */
export function fingerprint(p: Post): string {
  const t = p.text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[@#]\S+/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${p.author.handle.toLowerCase()}::${t}`;
}

/** The X search request. Separate so a test can assert the URL without a network. */
export function searchUrl(query: Query, sinceIso: string, perQuery = 25): string {
  const p = new URLSearchParams({
    query: query.q,
    start_time: sinceIso,
    max_results: String(Math.max(10, Math.min(100, perQuery))),
    "tweet.fields": "created_at,public_metrics,author_id,lang",
    "user.fields": "username,name,public_metrics,verified",
    expansions: "author_id",
  });
  return `https://api.x.com/2/tweets/search/recent?${p}`;
}

/**
 * What a status from X actually means, in the words you need to act on.
 *
 * A search that answers `402: 0 posts` is not a bug report, it is a number,
 * and the number is the one thing about the situation that is already on
 * screen. The first real run of this printed six of them and nothing else —
 * the token was fine, the account had no credits, and there was no way to
 * tell that from the output.
 *
 * Every line here is a state somebody will hit on their first day, and the
 * distinction that matters most is 401 against 402: a bad token and an empty
 * balance look identical until one of them sends you to the portal to
 * regenerate a credential that was never the problem.
 */
export function explain(status: number): string {
  switch (status) {
    case 200: return "ok";
    case 0: return "no answer — the request never completed";
    case 401: return "401 — X rejected the token. Wrong value, or regenerated since it was copied.";
    case 402: return "402 — the token is fine; the account has no credits. Buy them at console.x.com.";
    case 403: return "403 — the token is valid but not allowed this endpoint.";
    case 429: return "429 — rate limited. Wait, then run fewer queries a pass.";
    default:
      if (status >= 500) return `${status} — X is having trouble. Nothing to fix here; try later.`;
      return `${status} — unexpected; X's response body says more than the code does.`;
  }
}

/** X's shape, flattened. Exported because the paid service returns this too. */
export function postsFrom(body: string, matched: string): Post[] {
  let doc: {
    data?: { id?: string; text?: string; created_at?: string; author_id?: string;
             public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number } }[];
    includes?: { users?: { id?: string; username?: string; name?: string; verified?: boolean;
                           public_metrics?: { followers_count?: number } }[] };
  };
  try { doc = JSON.parse(body); } catch { return []; }
  const users = new Map((doc.includes?.users ?? []).map((u) => [u.id ?? "", u]));
  const out: Post[] = [];
  for (const t of doc.data ?? []) {
    if (!t.id || !t.text) continue;
    const u = users.get(t.author_id ?? "");
    const handle = u?.username ?? "";
    /* No handle means no link worth tapping and no account to judge, so the
       post is unusable however good its text is. */
    if (!handle) continue;
    out.push({
      id: t.id,
      url: `https://x.com/${handle}/status/${t.id}`,
      text: t.text,
      author: {
        handle, name: u?.name ?? null,
        followers: u?.public_metrics?.followers_count ?? 0,
        verified: Boolean(u?.verified),
      },
      at: t.created_at ?? new Date().toISOString(),
      likes: t.public_metrics?.like_count ?? 0,
      replies: t.public_metrics?.reply_count ?? 0,
      reposts: t.public_metrics?.retweet_count ?? 0,
      matched: [matched],
    });
  }
  return out;
}

export interface ListenOptions extends ScoreOptions {
  /** Only posts from on or after this instant. */
  since: string;
  /** Post ids already reported, in any past run. Never reported twice. */
  seen?: Set<string>;
  /** How many to report. Each one is a Telegram message and your attention. */
  limit: number;
  /** Per query. Each result is a post read, and a post read costs money. */
  perQuery?: number;
}

export interface Reading {
  label: string;
  url: string;
  status: number;
  found: number;
}

export interface ListenResult {
  /** Above the floor, best first. */
  found: Scored[];
  /** Scored and dropped, so a run that reports nothing can say why. */
  rejected: Scored[];
  /** What was searched and what each search answered. */
  searched: Reading[];
  /** Posts actually read. This is the bill. */
  reads: number;
}

/**
 * Run every query, merge, drop what has been reported before, score, cut.
 *
 * A post found by three queries is ONE post with three reasons, not three
 * posts — merged before scoring, because `matched.length` is the strongest
 * component of the score and counting it right is the difference between the
 * rule working and the rule being noise.
 */
export async function listen(fetcher: Fetcher, options: ListenOptions, queries: Query[] = QUERIES): Promise<ListenResult> {
  const seen = options.seen ?? new Set<string>();
  const byId = new Map<string, Post>();
  const byText = new Map<string, string>();
  const searched: Reading[] = [];
  let reads = 0;

  for (const query of queries) {
    const url = searchUrl(query, options.since, options.perQuery);
    const res = await fetcher(url).catch(() => ({ status: 0, body: "" }));
    const posts = res.status === 200 ? postsFrom(res.body, query.label) : [];
    searched.push({ label: query.label, url, status: res.status, found: posts.length });
    reads += posts.length;

    for (const p of posts) {
      if (seen.has(p.id)) continue;
      const have = byId.get(p.id);
      if (have) {
        if (!have.matched.includes(query.label)) have.matched.push(query.label);
        continue;
      }
      /* The same words posted twice under two ids. The second run had four
         accounts doing it — reposting their own line minutes apart — and each
         copy arrived as a separate candidate competing for the same slot. The
         first one seen wins and the rest fold into it, exactly as a
         cross-query duplicate does. */
      const key = fingerprint(p);
      const twin = byText.get(key);
      if (twin) {
        const first = byId.get(twin);
        if (first && !first.matched.includes(query.label)) first.matched.push(query.label);
        continue;
      }
      byText.set(key, p.id);
      byId.set(p.id, p);
    }
  }

  const all = [...byId.values()].map((p) => score(p, options)).sort((a, b) => b.score - a.score);
  const keep = all.filter((s) => s.band !== "skip");
  /* Sorted, so the printed list reads top to bottom. Before this, the
     above-floor overflow was appended after the skips and a 7 appeared below
     a -2, which made the output impossible to scan. */
  return {
    found: keep.slice(0, options.limit),
    rejected: all.filter((x) => !keep.slice(0, options.limit).includes(x)),
    searched,
    reads,
  };
}
