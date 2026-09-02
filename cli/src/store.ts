/**
 * What lives in .warda, and why each piece has to.
 *
 *   .warda/agent.key    the agent's secret, 0600. The whole authority, and
 *                       bounded by the grant rather than by trust.
 *   .warda/grant.json   the manifest. ADVANCED after every payment, because a
 *                       spend moves the grant: its address is a hash of its
 *                       state, so a manifest left behind points at an address
 *                       the grant has already left.
 *   .warda/config.json  the node url and the RECIPIENT LIST.
 *
 * The recipient list is the part people are surprised by. A grant commits to
 * the Merkle ROOT of its payees, and a root cannot produce an inclusion proof —
 * so a lost member list is a grant that can still be revoked and reclaimed but
 * never spent. It is kept here for the same reason the key is.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DIR = ".warda";
const p = (f: string) => join(DIR, f);

export interface Config {
  node?: string;
  recipients: string[];
  network: string;
}

export const paths = { key: p("agent.key"), grant: p("grant.json"), config: p("config.json") };

export function initialised(): boolean {
  return existsSync(paths.key) && existsSync(paths.config);
}

export function saveKey(secretHex: string): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(paths.key, secretHex + "\n", { mode: 0o600 });
}

export function readKey(): string {
  if (!existsSync(paths.key)) {
    throw new Error(`no ${paths.key}. Run \`warda init\` first.`);
  }
  return readFileSync(paths.key, "utf8").trim();
}

export function saveConfig(c: Config): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(c, null, 2) + "\n");
}

export function readConfig(): Config {
  if (!existsSync(paths.config)) {
    throw new Error(`no ${paths.config}. Run \`warda init\` first.`);
  }
  return JSON.parse(readFileSync(paths.config, "utf8")) as Config;
}

export function saveGrant(m: unknown): void {
  writeFileSync(paths.grant, JSON.stringify(m, null, 2) + "\n");
}

export function readGrant(): Record<string, unknown> {
  if (!existsSync(paths.grant)) {
    throw new Error(`no ${paths.grant}. Run \`warda grant create\` first.`);
  }
  return JSON.parse(readFileSync(paths.grant, "utf8")) as Record<string, unknown>;
}

/** KAS in, sompi out. The CLI talks KAS because people do. */
export function sompi(kas: string): bigint {
  if (!/^\d+(\.\d{1,8})?$/.test(kas)) {
    throw new Error(`not an amount in KAS: ${kas} (up to 8 decimal places)`);
  }
  const [whole, frac = ""] = kas.split(".");
  return BigInt(whole!) * 100_000_000n + BigInt(frac.padEnd(8, "0"));
}

export function kas(v: bigint): string {
  const whole = v / 100_000_000n, frac = v % 100_000_000n;
  return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}
