/**
 * What the UI may ask the worker to do.
 *
 * The popup is a renderer. It holds no key, builds no transaction and talks to
 * no node; it sends one of these and draws the answer. That is the security
 * boundary, and it is a boundary rather than a habit because there is no
 * message here that returns the principal key. A future `{kind:"exportKey"}`
 * would be a visible diff in this file, which is where it should be argued
 * about.
 *
 * ONE secret crosses this boundary, exactly once: the agent key minted when a
 * grant is issued. It is generated in the worker, returned to the screen so a
 * human can move it to wherever the agent runs, and never stored. An agent key
 * is already bounded by a covenant the network enforces — that is the whole
 * protocol — so it is safe in a way the principal key is not.
 */

import type { IssueTerms } from "./grants.ts";

export type { GrantRecord, IssueTerms, Issued, LiveGrant } from "./grants.ts";

export interface Settings {
  /** JSON wRPC. Default is the project's public four-method proxy. */
  nodeUrl: string;
  network: string;
  lockMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  nodeUrl: "wss://warda-node.tailc0c0ec.ts.net",
  network: "testnet-10",
  lockMinutes: 15,
};

export interface Status {
  hasVault: boolean;
  unlocked: boolean;
  /** Present even when locked, so the console can say whose key it holds. */
  publicKey: string | null;
  address: string | null;
  settings: Settings;
}

export interface NodeStatus {
  url: string;
  reachable: boolean;
  detail: string;
  network: string | null;
  daaScore: string | null;
}

export type Request =
  | { kind: "status" }
  | { kind: "grants" }
  | { kind: "issue"; terms: IssueTerms }
  | { kind: "revoke"; id: string; feeSompi: string }
  | { kind: "create"; passphrase: string; importSecretHex?: string }
  | { kind: "unlock"; passphrase: string }
  | { kind: "lock" }
  | { kind: "setSettings"; settings: Partial<Settings> }
  | { kind: "nodeStatus" }
  | { kind: "destroyVault" };

export type Response<T> = { ok: true; value: T } | { ok: false; error: string };

export async function ask<T>(request: Request): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  if (!reply) throw new Error("the console's background worker did not answer");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
