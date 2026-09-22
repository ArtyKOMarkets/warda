/**
 * Set one line of runner/.env in place, keeping every other line as it was.
 * Never prints a value.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const ENV_PATH = new URL("../.env", import.meta.url).pathname;

export function readDotenv(path = ENV_PATH): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function setDotenv(key: string, value: string, path = ENV_PATH): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const i = lines.findIndex((l) => re.test(l));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${value}`, "");
  }
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
}
