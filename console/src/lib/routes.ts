import { useEffect, useState } from "react";

/* routes.json: every way in from a stablecoin, with each leg's status as
   last checked. Read once per visit. */
export type Token = "USDC" | "USDT";
export interface Source {
  chain: string; chainId: number; tokens: Token[]; routes: string[];
  changenow?: Partial<Record<Token, { currency: string; network: string; legacy: string }>>;
  tokenRoutes?: Partial<Record<Token, string[]>>;
  rpc?: string[]; contracts?: Partial<Record<Token, string>>;
}
export interface Leg { does: string; via: string; status: "live" | "paused" | "experimental"; since?: string; why: string; source?: string; minKas?: number; custodial?: boolean }
export interface RouteDef { name: string; custody: string; summary: string; legs: string[] }
export interface Routes {
  checkedAt: string;
  networks: { "testnet-10": { none: string; faucet: string }; mainnet: { sources: Source[]; routes: Record<string, RouteDef>; legs: Record<string, Leg> } };
}

let p: Promise<Routes | false> | null = null;
export function loadRoutes() {
  p ??= fetch("/routes.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : false)).catch(() => { p = null; return false; });
  return p;
}
export function useRoutes(): Routes | false | null {
  const [r, setR] = useState<Routes | false | null>(null);
  useEffect(() => { loadRoutes().then(setR); }, []);
  return r;
}

export const stale = (r: Routes) => !r.checkedAt || Date.now() - new Date(r.checkedAt + "T00:00:00Z").getTime() > 14 * 86_400_000;
export const routeOpen = (r: Routes, id: string) => {
  const m = r.networks.mainnet;
  return !stale(r) && !!m.routes[id] && m.routes[id]!.legs.every((l) => m.legs[l]?.status === "live");
};

/* ---- what an 0x address holds, read from each chain's public node ---- */
async function rpcCall(urls: string[], method: string, params: unknown[]): Promise<any> {
  for (const u of urls) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
      const j = await r.json();
      if (j && !j.error && j.result != null) return j.result;
    } catch { /* next */ } finally { clearTimeout(t); }
  }
  throw new Error("no RPC answered");
}
export const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
function abiStr(hex: string): string {
  hex = String(hex || "").replace(/^0x/, "");
  const body = hex.length >= 192 ? hex.slice(128, 128 + parseInt(hex.slice(64, 128), 16) * 2) : hex.replace(/(00)+$/, "");
  try { return new TextDecoder().decode(new Uint8Array((body.match(/../g) ?? []).map((h) => parseInt(h, 16)))).replace(/\0/g, "").trim(); } catch { return ""; }
}
export function fromUnits(raw: bigint, dec: number): string {
  let s = raw.toString(); if (!dec) return s;
  s = s.padStart(dec + 1, "0");
  const f = s.slice(-dec).replace(/0+$/, "");
  return s.slice(0, -dec) + (f ? "." + f : "");
}
export function units(dec: number, s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(s)); if (!m) return null;
  return BigInt(m[1]! + (m[2] || "").slice(0, dec).padEnd(dec, "0"));
}
export interface Holding { chain: string; chainId: number; token: Token; raw?: bigint; amount?: string; err?: string }
export async function readHoldings(routes: Routes, address: string): Promise<Holding[]> {
  const jobs: Promise<Holding>[] = [];
  const addr = address.toLowerCase();
  for (const src of routes.networks.mainnet.sources) {
    if (!src.rpc?.length || !src.contracts) continue;
    for (const tok of Object.keys(src.contracts) as Token[]) {
      const c = src.contracts[tok]!;
      const call = (data: string) => rpcCall(src.rpc!, "eth_call", [{ to: c, data }, "latest"]);
      jobs.push(Promise.all([call("0x70a08231" + word(addr)), call("0x313ce567"), call("0x95d89b41")]).then(([b, d, sy]) => {
        const sym = abiStr(sy), norm = sym.replace(/₮/g, "T").toUpperCase();
        if (norm.indexOf(tok) !== 0) return { chain: src.chain, chainId: src.chainId, token: tok, err: `its contract calls itself ${sym || "nothing"}` };
        const raw = BigInt(b), dec = Number(BigInt(d));
        return { chain: src.chain, chainId: src.chainId, token: tok, raw, amount: fromUnits(raw, dec) };
      }).catch(() => ({ chain: src.chain, chainId: src.chainId, token: tok, err: "no RPC answered" })));
    }
  }
  return Promise.all(jobs);
}
export const money = (x: string | number) => Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const cache = new Map<string, { at: number; rows: Holding[] }>();
export function useHoldings(address: string | null) {
  const routes = useRoutes();
  const [state, setState] = useState<{ rows: Holding[] | null; at: number | null; busy: boolean }>({ rows: null, at: null, busy: false });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!address || !routes) { setState({ rows: null, at: null, busy: false }); return; }
    const c = cache.get(address.toLowerCase());
    if (c && !nonce) { setState({ rows: c.rows, at: c.at, busy: false }); return; }
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    readHoldings(routes, address).then((rows) => {
      if (!live) return;
      cache.set(address.toLowerCase(), { at: Date.now(), rows });
      setState({ rows, at: Date.now(), busy: false });
    });
    return () => { live = false; };
  }, [address, routes, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
