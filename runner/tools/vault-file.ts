/**
 * Vault records on disk, one JSON file per agent, until Postgres exists.
 *
 * A Turnkey record holds no secret — a wallet id and an address — so these
 * files are committed next to the grant manifests they belong with. Only the
 * vault methods of `Store` are implemented; a tool that needs the rest is a
 * tool that should be using the real store.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, VaultRecord } from "../src/store.ts";

export const AGENTS_DIR = new URL("../agents/", import.meta.url).pathname;

export function vaultFileStore(dir = AGENTS_DIR): Store {
  const path = (agent: string) => {
    if (!/^[\w-]+$/.test(agent)) throw new Error(`agent id ${JSON.stringify(agent)} is not a safe file name`);
    return join(dir, `${agent}.vault.json`);
  };
  const no = () => {
    throw new Error("vaultFileStore only stores vault records");
  };
  return {
    async getVault(agent) {
      const p = path(agent);
      return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as VaultRecord) : null;
    },
    async putVault(rec) {
      const p = path(rec.agent);
      if (existsSync(p)) throw new Error(`${p} exists; refusing to replace an agent's key record`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, JSON.stringify(rec, null, 2) + "\n", { flag: "wx" });
    },
    putWorkflow: no, getWorkflow: no, listWorkflows: no, claimRun: no, updateRun: no, listRuns: no, staleRuns: no,
    getCursor: no, setCursor: no, getEdge: no, setEdge: no, getLedger: no, setLedger: no,
    putApproval: no, listApprovals: no,
  };
}
