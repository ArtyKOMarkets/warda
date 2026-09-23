/**
 * One opportunity, as it arrives on a phone.
 *
 * ## The angle is looked up, not written
 *
 * The obvious thing here is to generate a suggested reply. This does not,
 * and the reason is the same one that stops Researcher selling a score: a
 * sentence about Warda that Warda cannot stand behind is worse than no
 * sentence, and it is worst precisely when it is fluent. A generated angle
 * would be fluent every time and true most of the time, and the times it was
 * not would be public, under your name, in a thread you were trying to join.
 *
 * So the angles are written here, once, reviewed like code, and chosen by
 * which query found the post. There are eight of them. If none fits, the
 * message says so and suggests nothing, which is a normal outcome and not a
 * failure — the point of the message is to get you to a conversation worth
 * your attention, and you can write your own first line.
 *
 * ## What it refuses to put in a message
 *
 * The score. You get the REASONS — matched two searches, nine replies, forty
 * minutes old — and not the number, because a number invites tuning the
 * number, and the reasons are what tell you whether to tap.
 */
import type { Scored } from "./listen.ts";

/**
 * One per query label, so adding a query without an angle is visible rather
 * than silent. Each is a claim Warda can defend on testnet today — bounded
 * authority that the network enforces — and none of them says "audited",
 * "production", or anything about money that is worth something.
 */
export const ANGLES: Record<string, string> = {
  "x402": "x402 settles the payment but says nothing about what the agent was allowed to spend. That limit can live in the coin itself rather than in the client.",
  "agent payments": "The hard part isn't the payment, it's the authority behind it: how much, to whom, by when — enforced where the agent can't edit it.",
  "agent wallet": "A wallet gives an agent a key. The open question is what stops that key spending everything, without a human in the loop for each payment.",
  "spending limits": "A limit in the agent's own code is a limit the agent can be argued out of. On Kaspa the budget, the per-payment cap and the allowlist are consensus rules.",
  "paid MCP": "If an MCP server meters, the client side needs a spending bound that isn't just a config value the model can read and route around.",
  "autonomous agents + money": "Autonomy and unbounded spend are separable. A grant can be genuinely unattended and still be incapable of paying the wrong person.",
  "machine payments": "Machine-to-machine payments need machine-checkable authority — not an API key that implies unlimited spend until someone revokes it.",
  "Kaspa": "Kaspa covenants can hold an agent's budget and enforce its limits at the consensus layer, with settlement in seconds.",
};

export interface Alert {
  text: string;
  /** For the log: which angle was used, or none. */
  angle: string | null;
}

const trim = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/**
 * Plain text, not Markdown.
 *
 * Telegram's parse modes fail the whole message on one unescaped character,
 * and a post from a stranger is a reliable source of underscores, asterisks
 * and brackets. A message that arrives plain is readable; a message that does
 * not arrive is a silent gap in exactly the feed you are trusting to be
 * complete.
 */
export function alert(s: Scored, index?: { n: number; of: number }): Alert {
  const p = s.post;
  const head = s.band === "high" ? "HIGH VALUE" : "WORTH A LOOK";
  const counter = index ? ` ${index.n}/${index.of}` : "";

  const mins = Math.max(0, Math.round((Date.now() - new Date(p.at).getTime()) / 60_000));
  const age = mins < 90 ? `${mins}m old` : `${Math.round(mins / 60)}h old`;

  /* The first angle whose query found this post, in the order the queries are
     listed — not the highest scoring, because the score has no opinion about
     which angle is apt. */
  const label = p.matched.find((m) => ANGLES[m]);
  const angle = label ? ANGLES[label]! : null;

  const lines = [
    `${head}${counter}`,
    "",
    `@${p.author.handle}${p.author.name ? ` · ${p.author.name}` : ""}`,
    `${p.author.followers.toLocaleString("en-US")} followers · ${age}`,
    "",
    `"${trim(p.text.replace(/\s+/g, " ").trim(), 260)}"`,
    "",
    `Why: ${s.why.filter((w) => w.startsWith("+")).join(", ")}`,
  ];
  if (angle) lines.push("", `Angle: ${angle}`);
  else lines.push("", "Angle: none of the written angles fits this one — your words.");
  lines.push("", p.url);

  return { text: lines.join("\n"), angle: label ?? null };
}

/** The line that closes a pass, including the passes that found nothing. */
export function summary(a: { searched: number; reads: number; sent: number; skipped: number; costUsd: number; spentKas: number; note?: string }): string {
  const lines = [
    `Listener: ${a.sent} sent, ${a.skipped} skipped, from ${a.searched} searches.`,
    `${a.reads} posts read — $${a.costUsd.toFixed(3)} to X, ${a.spentKas.toFixed(2)} KAS on chain.`,
  ];
  if (a.note) lines.push(a.note);
  return lines.join("\n");
}
