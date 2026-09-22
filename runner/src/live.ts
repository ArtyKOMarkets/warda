/**
 * The engine's ports, wired to the real thing: `@warda_protocol/agent` for the
 * grant and its payments, the vault for the key, Telegram for messages.
 *
 * `openAgent` is the caller's: it knows where each agent's manifest and
 * allowlist live (a file today, Postgres next). Everything else is here.
 */

import {
  amountOf,
  dialect,
  parsePaymentRequired,
  selectRequirement,
} from "@warda_protocol/x402";
import type { Agent } from "@warda_protocol/agent";
import type { Approvals, Http, Notifier, Payments, X402Outcome } from "./engine.ts";
import type { GrantReader, GrantView } from "./grant.ts";

export interface OpenedAgent {
  agent: Agent;
  /** The allowlist as addresses, in the order the grant committed to them. */
  payees: string[];
  /** Pay through a relay hop (x402 v2 vendors need it). */
  relay?: boolean;
  /** Releases what `open` acquired (the chain connection). */
  close?: () => Promise<void>;
}

export type OpenAgent = (agentId: string) => Promise<OpenedAgent>;

/** Ten blocks a second. The covenant counts DAA; people count hours. */
const MS_PER_DAA = 100n;

export function liveGrants(open: OpenAgent, now: () => number = Date.now): GrantReader {
  return {
    async read(agentId) {
      let opened: OpenedAgent | null = null;
      try {
        opened = await open(agentId);
        const { agent, payees } = opened;
        const s = agent.state;
        const chain = agent.chainAccess;
        const [dag, utxos] = await Promise.all([chain.getBlockDagInfo(), chain.getUtxosByAddresses([agent.address])]);
        // Nothing at the address is UNDECIDED, not empty: moved, drained, or a
        // node that is behind all look the same from here.
        if (utxos.length === 0) return null;
        const coin = utxos.reduce((t, u) => t + u.entry.value, 0n);
        const daa = dag.virtualDaaScore;
        let epochRemaining: bigint | null = null;
        if (s.epochLimit > 0n && s.epochLength > 0n && daa >= s.notBefore) {
          const current = (daa - s.notBefore) / s.epochLength;
          const used = current === s.epochIndex ? s.epochSpent : 0n;
          epochRemaining = s.epochLimit > used ? s.epochLimit - used : 0n;
        }
        const expired = daa >= s.expiresAt;
        const view: GrantView = {
          address: agent.address,
          status: expired ? "EXPIRED" : "ACTIVE",
          budgetTotal: s.budgetTotal,
          spentTotal: s.spentTotal,
          reserved: s.reserved,
          maxPerSpend: s.maxPerSpend,
          epochRemaining,
          coin,
          payees,
          expiresAtMs: now() + Number((s.expiresAt - daa) * MS_PER_DAA),
        };
        return view;
      } catch {
        return null;
      } finally {
        await opened?.close?.().catch(() => {});
      }
    },
  };
}

/** What the vendor served, capped: it goes back to an agent, not into a log. */
async function text(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 65_536 ? t.slice(0, 65_536) + "\n…(truncated)" : t;
  } catch {
    return "";
  }
}

async function quote(res: Response): Promise<bigint> {
  const body = await res.clone().json().catch(() => {
    throw new Error("the 402 carried no readable price");
  });
  return dialect(body) === "v2" ? amountOf(selectRequirement(body)) : parsePaymentRequired(body).amountSompi;
}

export function livePayments(open: OpenAgent): Payments {
  return {
    async x402(agentId, req, limitSompi, onSubmitted): Promise<X402Outcome> {
      const init: RequestInit = { method: req.method };
      if (req.body !== undefined) {
        init.body = req.body;
        init.headers = { "Content-Type": req.contentType ?? "application/json" };
      }
      // Ask the price first, and refuse above the limit before the agent is
      // even opened. `Agent.fetch` would pay any invoice the grant allows;
      // the workflow's own maximum is narrower, and it is enforced here.
      const probe = await fetch(req.url, init);
      if (probe.status !== 402) return { kind: "free", status: probe.status, body: await text(probe) };
      const price = await quote(probe);
      if (price > limitSompi) {
        return {
          kind: "refused",
          reason: `the vendor asks ${price} sompi and this step may spend at most ${limitSompi}`,
        };
      }
      const opened = await open(agentId);
      try {
        const { agent, relay } = opened;
        let recording: Promise<void> | null = null;
        const { response, paid } = await agent.fetch(req.url, init, {
          ...(relay ? { relay: true } : {}),
          onEvent: (e) => {
            if (e.type === "paid") recording = onSubmitted(e.result.txid, e.result.amountSompi);
          },
        });
        if (recording) await recording;
        if (!paid) return { kind: "free", status: response.status, body: await text(response) };
        return { kind: "paid", status: response.status, txid: paid.txid, sompi: paid.amountSompi, body: await text(response) };
      } finally {
        await opened.close?.().catch(() => {});
      }
    },

    async send(agentId, to, sompi, onSubmitted) {
      const opened = await open(agentId);
      try {
        const r = await opened.agent.pay(to, sompi);
        await onSubmitted(r.txid, r.amountSompi);
        return { txid: r.txid };
      } finally {
        await opened.close?.().catch(() => {});
      }
    },
  };
}

/** Telegram by bot token; a webhook by POST. The token never reaches a log. */
export function liveNotifier(opts: { telegramToken?: string }): Notifier {
  return {
    async notify(channel, to, text) {
      if (channel === "webhook") {
        const r = await fetch(to, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) throw new Error(`the webhook answered ${r.status}`);
        return;
      }
      if (!opts.telegramToken) throw new Error("no Telegram bot token is configured for this runner");
      const r = await fetch(`https://api.telegram.org/bot${opts.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: to, text, disable_web_page_preview: true }),
      });
      if (!r.ok) throw new Error(`Telegram answered ${r.status}`);
    },
  };
}

export const liveHttp: Http = {
  async request(url, method, body) {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = body;
      init.headers = { "Content-Type": "application/json" };
    }
    return (await fetch(url, init)).status;
  },
};

/** Tells the owner there is something to sign, with a link to the console. */
export function liveApprovals(n: Notifier, ownerChat: (agent: string) => string | null, consoleUrl: string): Approvals {
  return {
    async announce(a) {
      const chat = ownerChat(a.agent);
      if (!chat) return;
      await n.notify(
        "telegram",
        chat,
        `Agent ${a.agent} asks you to ${a.op} its grant.${a.note ? " " + a.note : ""}\n` +
          `Nothing happens until you sign it in your own wallet: ${consoleUrl}#/agent/${a.agent}`,
      );
    },
  };
}


