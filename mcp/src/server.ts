#!/usr/bin/env node
/**
 * Warda MCP server — lets an agent framework reason about its own economic
 * authority.
 *
 * ADVISORY ONLY. Nothing here enforces anything. An agent is free to ignore
 * every answer this server gives, build the transaction anyway, and broadcast
 * it — and the covenant will refuse it, which is the entire point. Warda's
 * security does not depend on the agent asking first.
 *
 * What this is actually for:
 *   - an agent can know its real headroom before planning a purchase
 *   - an agent can avoid building transactions that cannot be valid
 *   - a framework can discover the protocol without a custom integration
 *   - a rejection can be explained in words rather than an opaque script error
 *
 * Every verdict comes from @warda/core, the same code the covenant was
 * verified against. A server carrying its own copy of the rules would be worse
 * than none: it could tell an agent it may spend when the chain will refuse.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { validateSpend, validateDelegation } from "../../src/validate.ts";
import { materialise, headroom, kas, formatKas, type GrantDescriptor } from "./grant.ts";
import type { FailureCode } from "../../src/types.ts";

const EXPLAIN: Record<FailureCode, string> = {
  NOT_ACTIVE: "The grant is not active.",
  REVOKED: "The principal revoked this grant.",
  NOT_YET_VALID: "The grant has not opened yet — the chain has not reached not_before.",
  EXPIRED: "The grant's window has closed. The principal may now reclaim the balance.",
  AMOUNT_NOT_POSITIVE: "The amount must be greater than zero.",
  EXCEEDS_MAX_PER_SPEND: "Larger than the per-transaction cap. Split it or ask the principal to raise the cap.",
  EXCEEDS_AVAILABLE_BUDGET: "More than the grant has left after spending and delegation.",
  EXCEEDS_EPOCH_LIMIT: "Within budget overall, but over the limit for this epoch. It will free up next epoch.",
  RECIPIENT_NOT_AUTHORIZED: "This payee is not on the grant's allowlist. No proof exists to place it there.",
  INVALID_SUCCESSOR: "The next state does not follow from this spend.",
  ASSET_MISMATCH: "A child grant must use the same asset as its parent.",
  CHILD_BUDGET_EXCEEDS_PARENT: "A child cannot receive more than the parent still holds.",
  CHILD_MAX_PER_SPEND_EXCEEDS_PARENT: "A child's per-spend cap cannot exceed its parent's.",
  CHILD_EPOCH_LIMIT_EXCEEDS_PARENT: "A child's epoch limit cannot exceed its parent's.",
  CHILD_STARTS_BEFORE_PARENT: "A child cannot open before its parent does.",
  CHILD_OUTLIVES_PARENT: "A child cannot outlive its parent.",
  DELEGATION_DEPTH_EXHAUSTED: "This grant cannot delegate any further.",
  CHILD_RECIPIENTS_NOT_SUBSET: "A child's allowlist must be its parent's, or a proven subset of it.",
  CHILD_RECIPIENTS_NOT_CANONICAL: "Allowlist members must be distinct and in ascending order.",
  CHILD_RECIPIENTS_TOO_MANY: "Too many recipients named for one child grant.",
  PARENT_ID_MISMATCH: "This request does not refer to the grant it claims to.",
};

const GrantShape = z.object({
  agentKey: z.string(), principalKey: z.string(), revocationKey: z.string(),
  budgetKas: z.string(), maxPerSpendKas: z.string(), epochLimitKas: z.string(),
  epochLength: z.string(), recipients: z.array(z.string()),
  notBefore: z.string(), expiresAt: z.string(),
  delegationDepth: z.number(), nonce: z.string(),
  state: z.object({
    spentTotalKas: z.string(), reservedKas: z.string(),
    epochIndex: z.string(), epochSpentKas: z.string(),
  }).optional(),
}).describe("The grant, as issued by the principal.");

export function buildServer(): McpServer {
  const server = new McpServer({ name: "warda", version: "0.1.0" });
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

  server.registerTool(
  "warda_grant_authority",
  {
    title: "What may this agent spend?",
    description:
      "Report a grant's remaining authority: budget left, epoch headroom, per-transaction cap, " +
      "and the largest single payment permitted right now. Use this before planning a purchase. " +
      "Advisory — the covenant enforces these limits whether or not you ask.",
    inputSchema: { grant: GrantShape, daaScore: z.string().describe("Current DAA score of the chain.") },
  },
  async ({ grant, daaScore }) =>
    json(headroom(materialise(grant as GrantDescriptor), BigInt(daaScore))),
);

  server.registerTool(
  "warda_check_spend",
  {
    title: "Would this payment be allowed?",
    description:
      "Check a proposed payment against every rule the covenant enforces, and return the same " +
      "verdict the chain would. Builds the recipient proof for you. " +
      "ADVISORY: a 'permitted' answer is not permission — it means the covenant would accept " +
      "this transaction. A 'refused' answer means no valid transaction exists, so broadcasting " +
      "one would only waste a fee.",
    inputSchema: {
      grant: GrantShape,
      amountKas: z.string().describe("Amount to pay, in KAS."),
      recipient: z.string().describe("Payee public key, 32 bytes of hex."),
      daaScore: z.string(),
    },
  },
  async ({ grant, amountKas, recipient, daaScore }) => {
    const m = materialise(grant as GrantDescriptor);
    const amount = kas(amountKas);
    const daa = BigInt(daaScore);
    const known = m.set.has(recipient);
    const epochNow = daa >= m.grant.notBefore
      ? (daa - m.grant.notBefore) / m.grant.epochLength : 0n;
    const spentThisEpoch = epochNow === m.state.epochIndex ? m.state.epochSpent : 0n;

    const verdict = validateSpend(m.grant, m.state, {
      grantId: m.grant.grantId,
      amount,
      recipient,
      // A payee that is not on the list has no proof. Supplying a borrowed one
      // is the best an attacker could do, and is what the covenant sees.
      recipientProof: known ? m.set.proof(recipient) : m.set.proof(m.set.recipients[0]!),
      daaScore: daa,
      successor: {
        grantId: m.grant.grantId,
        spentTotal: m.state.spentTotal + amount,
        reserved: m.state.reserved,
        epochIndex: epochNow,
        epochSpent: spentThisEpoch + amount,
        status: m.state.status,
      },
    });

    return json({
      permitted: verdict.ok,
      reasons: verdict.failures.map((f) => ({ code: f, explanation: EXPLAIN[f] })),
      recipientOnAllowlist: known,
      ...headroom(m, daa),
      enforcement:
        "Advisory. The covenant enforces this on-chain regardless of whether this check was run.",
    });
  },
);

  server.registerTool(
  "warda_check_delegation",
  {
    title: "Would this delegation be allowed?",
    description:
      "Check whether a proposed child grant is a legal narrowing of this one. A child may only " +
      "ever be more restrictive than its parent, and the parent must reserve exactly what the " +
      "child receives — authority is subdivided, never created. Advisory.",
    inputSchema: {
      parent: GrantShape,
      childBudgetKas: z.string(),
      childMaxPerSpendKas: z.string(),
      childEpochLimitKas: z.string(),
      childAgentKey: z.string(),
      daaScore: z.string(),
    },
  },
  async ({ parent, childBudgetKas, childMaxPerSpendKas, childEpochLimitKas, childAgentKey, daaScore }) => {
    const m = materialise(parent as GrantDescriptor);
    const p = parent as GrantDescriptor;
    const childBudget = kas(childBudgetKas);
    const child = materialise({
      ...p,
      agentKey: childAgentKey,
      budgetKas: childBudgetKas,
      maxPerSpendKas: childMaxPerSpendKas,
      epochLimitKas: childEpochLimitKas,
      delegationDepth: p.delegationDepth - 1,
      nonce: "02".repeat(32),
      state: undefined,
    }).grant;

    const verdict = validateDelegation(m.grant, m.state, {
      parentId: m.grant.grantId,
      child: { ...child, parentId: m.grant.grantId },
      daaScore: BigInt(daaScore),
      parentSuccessor: { ...m.state, reserved: m.state.reserved + childBudget },
    });

    return json({
      permitted: verdict.ok,
      reasons: verdict.failures.map((f) => ({ code: f, explanation: EXPLAIN[f] })),
      parentReservesKas: formatKas(childBudget),
      parentRemainingAfterKas: formatKas(
        m.grant.budgetTotal - m.state.spentTotal - m.state.reserved - childBudget,
      ),
      enforcement: "Advisory. The covenant enforces attenuation and conservation on-chain.",
    });
  },
);

  return server;
}

// Only start stdio when run as a binary; tests drive buildServer() directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  await buildServer().connect(new StdioServerTransport());
}
