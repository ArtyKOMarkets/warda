/** Loads runner/.env into process.env without printing anything from it. */
import { existsSync, readFileSync } from "node:fs";

export function loadEnv(path = new URL("../.env", import.meta.url).pathname): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
