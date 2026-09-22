/* The hosted runner, as the classic console already talks to it: the same
   localStorage key, so anyone signed in there is signed in here. */
const KEY = "warda.runner";
export const DEFAULT_RUNNER = "https://warda-runner.vercel.app";

export interface RunnerConfig { url: string; key: string; agent?: string }

export function loadRunner(): RunnerConfig {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    const url = v.url && v.url !== "http://localhost:8787" ? v.url : DEFAULT_RUNNER;
    return { url, key: v.key || "", agent: v.agent };
  } catch {
    return { url: DEFAULT_RUNNER, key: "" };
  }
}

export function saveRunner(c: RunnerConfig) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* private window */ }
}

export class RunnerError extends Error {}

export async function api<T = any>(c: RunnerConfig, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const base = c.url.trim().replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extra };
  if (c.key) headers.Authorization = `Bearer ${c.key}`;
  let r: Response;
  try {
    r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new RunnerError(`The runner did not answer at ${base}.`);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new RunnerError(j.error || `The runner answered ${r.status}.`);
  return j as T;
}
