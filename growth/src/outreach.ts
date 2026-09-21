/**
 * Outreach: turns a checked record into a message a person can send.
 *
 * ## It holds no grant, and sends nothing
 *
 * This is the one agent in the tree that writes to strangers, which makes it
 * the one that can embarrass somebody. So it has no authority to spend and no
 * way to send: it writes DRAFTS, and Arty reads them and decides. That is not a
 * checkbox in front of a send button — there is no send button.
 *
 * ## Only what the record established
 *
 * Every sentence about the other project comes from a finding or a signal in
 * the record Researcher sold, and the draft carries those findings' sources so
 * the person sending it can check each one before putting their name under it.
 * Anything the record lists as unverified is never said. "You need this" is
 * never said at all: the record says, in so many words, that whether anyone
 * wants to pay for anything is something only they can say.
 *
 * ## No draft is a result
 *
 * A project with no signal, or no channel its maintainers chose to publish,
 * gets no message. The report lists it with the reason, because "we looked and
 * there was nothing to say" is worth as much as a draft and costs nobody an
 * unwanted email.
 */
import type { Finding, Record as ProjectRecord } from "./verify-project.ts";

export interface Draft {
  project: string;
  /** Where to send it, and why that channel: the one THEY published. */
  channel: { kind: "x" | "discussions" | "website"; target: string; source: string };
  subject: string;
  body: string;
  /** The findings the body relies on — check these before sending. */
  basis: Finding[];
  /** Which argument was made, for the report. */
  angle: Angle;
}

export interface Skipped {
  project: string;
  reason: string;
}

export type Angle = "payments-infra" | "sells-over-x402" | "agents-that-pay" | "mcp" | "kaspa";

const LINKS = {
  start: "https://wardaprotocol.com/start",
  console: "https://wardaprotocol.com/app",
  attack: "https://wardaprotocol.com/attack",
  /* The offer: we fund their agent's first testnet grant. An invitation to
     try it beats a description of it. */
  grant: "https://wardaprotocol.com/grant",
};

function signalHas(record: ProjectRecord, label: string, words: string[]): boolean {
  return record.signals.some((s) => s.startsWith(label) && words.some((w) => s.includes(w)));
}

const INFRA = /\b(payments?|billing|checkout|settlement)\b.{0,24}\b(protocol|sdk|api|infrastructure|rails?|gateway|facilitator|library|layer)\b|\bx402\b.{0,24}\b(sdk|facilitator|middleware|server|client|library)\b/i;
/* It mentions payments because it LISTS things that take them. */
const DIRECTORY = /\b(list|directory|collection|catalog(ue)?|index|registry) of\b|\baggregat|\bevery public api|\bawesome\b|\bcurated\b/i;

function describedAs(record: ProjectRecord): string | null {
  const f = record.findings.find((x) => x.fact.startsWith("it describes itself as"));
  return f ? f.fact.replace(/^it describes itself as "?/, "").replace(/"$/, "") : null;
}

/** The argument that fits, from the words on their own pages. Most specific first. */
export function angleFor(record: ProjectRecord): Angle | null {
  /* A project whose OWN description says it is payments infrastructure is a
     peer, not a customer: the pitch is "you handle how an agent pays, Warda
     bounds how much it can", never "you need this". */
  if (INFRA.test(describedAs(record) ?? "")) return "payments-infra";
  const pays = record.signals.some((s) => s.startsWith("mentions paying for things"));
  const agents = record.signals.some((s) => s.startsWith("mentions agents"));
  const kaspa = record.signals.some((s) => s.startsWith("mentions Kaspa"));
  if (signalHas(record, "mentions paying for things", ["x402", "402", "payment required"])) return "sells-over-x402";
  if (signalHas(record, "mentions agents", ["mcp server", "model context protocol"]) && pays) return "mcp";
  if (agents && pays) return "agents-that-pay";
  if (kaspa && (agents || pays)) return "kaspa";
  return null;
}

function channelFor(record: ProjectRecord): Draft["channel"] | null {
  /* The handle the project's own website links first: it is the one they keep
     current. The GitHub profile's is a fallback. */
  for (const f of record.findings) {
    const m = /^its website links X @([A-Za-z0-9_]{1,15})$/.exec(f.fact);
    if (m) return { kind: "x", target: `https://x.com/${m[1]}`, source: f.source };
  }
  for (const f of record.findings) {
    const m = /X\/Twitter @([A-Za-z0-9_]{1,15})/.exec(f.fact);
    if (m) return { kind: "x", target: `https://x.com/${m[1]}`, source: f.source };
  }
  const disc = record.findings.find((f) => f.fact.startsWith("GitHub Discussions is switched on"));
  if (disc) return { kind: "discussions", target: `${record.project.replace(/\/$/, "")}/discussions`, source: disc.source };
  for (const f of record.findings) {
    const m = /^(?:their profile links|the repository names a homepage,) (\S+)/.exec(f.fact);
    if (m) return { kind: "website", target: m[1]!, source: f.source };
  }
  return null;
}

function nameOf(record: ProjectRecord): string {
  const f = record.findings.find((x) => x.fact.startsWith("the repository "));
  return /the repository (\S+) is public/.exec(f?.fact ?? "")?.[1] ?? record.project;
}

const PITCH: { [A in Angle]: { subject: (n: string) => string; line: string; link: string } } = {
  "payments-infra": {
    subject: (n) => `${n}: how an agent pays, and how much it may`,
    line:
      "Warda looks complementary to what you are building: you handle how an agent pays, and Warda bounds " +
      "how much it can — a grant with a budget, a per-payment cap and a payee allowlist, enforced by the " +
      "network rather than by the agent's own code, and revocable by a separate key. It works with x402 today.",
    link: LINKS.start,
  },
  "sells-over-x402": {
    subject: (n) => `${n}: buyers whose spending limit you can read`,
    line:
      "Warda gives the agent paying you a grant: a budget, a per-payment cap and a list of who it may pay, " +
      "enforced by the network rather than by the agent's own code. A seller can read those limits " +
      "offline before serving (@warda_protocol/provider), so you know the payment could not have been larger.",
    link: LINKS.start,
  },
  "agents-that-pay": {
    subject: (n) => `${n}: a spending limit your agents cannot talk their way past`,
    line:
      "Warda lets you give an agent a grant instead of a wallet: a budget, a per-payment cap, a rate and " +
      "an allowlist, checked by every node on every spend. If the agent is tricked or its host is " +
      "compromised, the limit still holds — and a separate key can stop it at any moment.",
    link: LINKS.console,
  },
  mcp: {
    subject: (n) => `${n}: paying for tools, with limits`,
    line:
      "Warda's MCP server (in the official MCP registry) gives an agent payment as a tool, bounded by a " +
      "grant the network enforces: total budget, per-call cap, and who it may pay. Nothing to trust on our side.",
    link: LINKS.start,
  },
  kaspa: {
    subject: (n) => `${n}: bounded spending for agents on Kaspa`,
    line:
      "Warda uses Toccata covenants to give an agent a grant rather than a key: a budget, per-payment cap, " +
      "rate and allowlist that every node checks. There is a published key with money behind it you can try to break.",
    link: LINKS.attack,
  },
};

/**
 * A draft, or the reason there is none. Never both, never neither.
 */
export function draft(record: ProjectRecord): Draft | Skipped {
  if (record.findings.some((f) => f.fact.includes("ARCHIVED"))) {
    return { project: record.project, reason: "archived — nobody is there to read it" };
  }
  const self = describedAs(record);
  if (!self) return { project: record.project, reason: "it does not say what it is — a message would have nothing specific to say" };
  if (DIRECTORY.test(self)) return { project: record.project, reason: "a directory or list: it mentions payments because it lists things that take them" };
  const angle = angleFor(record);
  if (!angle) return { project: record.project, reason: "no signal on its own pages that it pays or charges for anything" };
  const channel = channelFor(record);
  if (!channel) return { project: record.project, reason: "its maintainers publish no channel; we do not go looking for one" };

  const name = nameOf(record);
  const described = record.findings.find((f) => f.fact.startsWith("it describes itself as"));
  const signal = record.signals.find((s) =>
    angle === "kaspa" ? s.startsWith("mentions Kaspa") : s.startsWith("mentions paying for things") || s.startsWith("mentions agents"));
  /* Three words at most, the most specific first. A list of nine reads as a
     keyword scan, which is what it is, and the reader should not have to know. */
  const PRIORITY = ["x402", "http 402", "402 payment", "payment required", "stablecoin", "usdc", "usdt", "micropayment", "pay-per-call", "mcp server", "ai agent", "kaspa"];
  const all = signal ? signal.replace(/^mentions [^:]+: /, "").replace(/ \(.*\)$/, "").split(", ") : [];
  const words = [...all].sort((x, y) => (PRIORITY.indexOf(x) + 1 || 99) - (PRIORITY.indexOf(y) + 1 || 99)).slice(0, 3).join(", ");

  const basis: Finding[] = [];
  if (described) basis.push(described);
  const signalSource = /\((https?:[^)]+)\)$/.exec(signal ?? "")?.[1];
  if (signal && signalSource) basis.push({ fact: signal.replace(/ \(https?:[^)]+\)$/, ""), source: signalSource });

  const pitch = PITCH[angle];
  const repo = name.split("/").pop() ?? name;

  /* X is a DM, not a letter: one short paragraph, one question, under ~500
     characters. Email and a website's contact form get the long form. */
  if (channel.kind === "x") {
    const SHORT: { [A in Angle]: string } = {
      "payments-infra": `It looks complementary to ${repo}: you handle how an agent pays, Warda bounds how much it can. Would comparing notes be useful?`,
      "sells-over-x402": `If agents pay ${repo} over x402, you could read a buyer's limits before serving. Would that be useful?`,
      mcp: `Agents paying for ${repo}'s tools could do it under those limits. Would that be useful?`,
      "agents-that-pay": `If ${repo}'s agents pay for things, a grant caps what a tricked or compromised one can spend. Would that be useful?`,
      kaspa: `It is built on Toccata covenants, and there is a funded key published at wardaprotocol.com/attack to try to break. Would you take a look?`,
    };
    const body =
      "Hi — I'm building Warda: spending limits for AI agents that the network enforces rather than the agent's own code " +
      "(budget, per-payment cap, payee allowlist, revocable by a separate key). " +
      `${SHORT[angle]} Worth a try? We'll fund a grant for your agent on testnet (unaudited, no real money): wardaprotocol.com/grant — no worries if not. Arty`;
    return { project: record.project, channel, subject: pitch.subject(name), body, basis, angle };
  }

  const opener = described
    ? `I came across ${name} — ${described.fact.replace(/^it describes itself as /, "described as ")}` +
      (words ? `, and its pages mention ${words}.` : ".")
    : `I came across ${name}; its pages mention ${words}.`;

  const body = [
    "Hi,",
    "",
    opener,
    "",
    pitch.line,
    "",
    `If it is worth a try, we will fund a testnet grant for your agent — send its public key at ${LINKS.grant} and it can pay within a day. More on how it works: ${pitch.link}. It is testnet and unaudited, so there is no real money in it yet.`,
    "",
    "No reply needed if it is not relevant — I will not follow up.",
    "",
    "Arty, Warda",
  ].join("\n");

  return { project: record.project, channel, subject: pitch.subject(name), body, basis, angle };
}

export function isDraft(x: Draft | Skipped): x is Draft {
  return (x as Draft).body !== undefined;
}

/** The file Arty reads on Monday. Plain markdown; every claim with its source. */
export function draftsMarkdown(batch: string, results: (Draft | Skipped)[]): string {
  const drafts = results.filter(isDraft);
  const skipped = results.filter((r): r is Skipped => !isDraft(r));
  const out: string[] = [
    `# Outreach drafts — ${batch}`,
    "",
    `${drafts.length} draft${drafts.length === 1 ? "" : "s"}, ${skipped.length} project${skipped.length === 1 ? "" : "s"} with nothing to send.`,
    "Nothing here has been sent. Check each line under **Based on** before putting your name under it.",
    "",
  ];
  for (const d of drafts) {
    out.push(`## ${d.subject}`, "", `**Send via:** ${d.channel.kind} — ${d.channel.target}`, `**Project:** ${d.project}`, "", "```", d.body, "```", "", "**Based on:**");
    for (const b of d.basis) out.push(`- ${b.fact} — ${b.source}`);
    out.push("");
  }
  if (skipped.length) {
    out.push("## No draft", "");
    for (const s of skipped) out.push(`- ${s.project} — ${s.reason}`);
    out.push("");
  }
  return out.join("\n");
}
