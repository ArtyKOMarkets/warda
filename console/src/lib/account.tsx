import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet, VERIFY, NET } from "./connect";

/* The console account: a wallet signs a plain-text message, checked once by
   /api/account on this site. It keeps tracked grants, alert rules and where
   alerts go. It never stores a key, a seed, or money. */

export interface Rule { id: string; rule: Record<string, any>; state: null | "firing" | "clear" | "undecided" | "insufficient"; stateAt: string | null; lastMessage: string | null }
export interface Me {
  id: string; createdAt: string; plan: string; email: string | null; telegramChatId: string | null; telegramReady: boolean;
  billing: { enabled: boolean; enforced: boolean; plan: string; status: string | null; customer: boolean; prices: { pro: string; team: string } };
  paid: boolean;
  wallets: { address: string; family: "evm" | "kaspa"; key: string | null; addedAt: string }[];
  grants: { key: string; manifest: Manifest; addedAt: string; payee: string | null; movedAt: string | null; followNote: string | null }[];
  rules: Rule[];
}
export type Manifest = Record<string, any>;
type Res<T = {}> = ({ ok: true } & T) | { ok: false; error: string; message: string };

export async function accountApi<T = {}>(op: string, body?: unknown): Promise<Res<T>> {
  const init: RequestInit = body === undefined ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-warda": "1" }, body: JSON.stringify(body) };
  try {
    const r = await fetch(`/api/account?op=${op}`, init);
    return await r.json().catch(() => ({ ok: false, error: "http", message: `The account service answered ${r.status}.` }));
  } catch { return { ok: false, error: "network", message: "The account service did not answer." }; }
}

function signinMessage(address: string, nonce: string, host: string, chainId: number) {
  return `${host} wants you to sign in to Warda Console with your account:\n${address}\n\n` +
    "Sign in to Warda Console. This proves you hold this address. It cannot move funds and costs nothing.\n\n" +
    `URI: https://${host}/app\nVersion: 1\nChain ID: ${chainId || 1}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
}

/* ---- grants you track, by their grant.json ---- */
const OKEY = "warda.console.grants";
export interface Own { m: Manifest; added: string; synced?: boolean; local?: boolean; payee?: string | null; note?: string | null; movedAt?: string | null }
export type Reading =
  | { st: "reading" } | { st: "node" | "refused" | "none"; err: string }
  | { st: "read"; r: any; from: any; assumptions: { field: string; value: unknown }[]; at: number };
export const ownKey = (m: Manifest) => String(m.covenant_id || `${m.principal}:${m.created_at_daa}`);
const SECRETISH = /secret|priv|seed|mnemonic|passphrase|password|^sk$|_sk$|^wif$/i;
export function checkManifest(m: unknown): string | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "that is not a JSON object — a manifest is one";
  const o = m as Manifest;
  for (const k of Object.keys(o)) if (SECRETISH.test(k) && o[k] !== "" && o[k] != null)
    return `it has a field called "${k}", which is where a secret would be. A grant manifest never holds one, so this file was not stored and not sent anywhere. If it is a key file, keep it private.`;
  for (const f of ["principal", "agent", "revocation", "recipients_root"]) if (!/^[0-9a-f]{64}$/i.test(String(o[f] ?? ""))) return `${f}: expected 64 hex characters. Is this the grant.json that warda grant wrote?`;
  for (const f of ["budget", "max_per_spend", "epoch_limit", "epoch_length", "expires_at"]) {
    const v = o[f];
    if (!((typeof v === "number" && Number.isInteger(v) && v >= 0) || (typeof v === "string" && /^\d+$/.test(v)))) return `${f}: expected a whole number, got ${JSON.stringify(v)}`;
  }
  return null;
}
const loadOwn = (): Own[] => { try { const v = JSON.parse(localStorage.getItem(OKEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveOwn = (o: Own[]) => { try { localStorage.setItem(OKEY, JSON.stringify(o)); return true; } catch { return false; } };

interface Ctx {
  up: boolean | null;            // null unknown · true answers · false not set up on this site
  me: Me | null;
  history: Record<string, { at: string; remainingSompi: string }[]> | null;
  reload(): Promise<void>;
  signIn(op?: "signin" | "link"): Promise<string>;
  signOut(): Promise<void>;
  setMe(m: Me): void;
  own: Own[];
  readings: Record<string, Reading>;
  addGrant(text: string, from: string): string | null;
  removeGrant(key: string): void;
  readGrant(m: Manifest): void;
  setLocal(key: string, local: boolean): void;
  replaceManifest(key: string, m: Manifest): void;
}
const C = createContext<Ctx | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const { wallet, sign } = useWallet();
  const [up, setUp] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [history, setHistory] = useState<Ctx["history"]>(null);
  const [own, setOwnState] = useState<Own[]>(loadOwn);
  const [readings, setReadings] = useState<Record<string, Reading>>({});
  const ownRef = useRef(own);
  const setOwn = (o: Own[]) => { ownRef.current = o; setOwnState(o); saveOwn(o); };

  const readGrant = useCallback(async (m: Manifest) => {
    const k = ownKey(m);
    setReadings((r) => ({ ...r, [k]: { st: "reading" } }));
    let out: Reading;
    try {
      const r = await fetch(`${VERIFY}/v1/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: m, network: NET }) });
      const j = await r.json().catch(() => null);
      if (r.status === 503) out = { st: "node", err: j?.message || "the verifier's node cannot be believed right now" };
      else if (!j || !j.ok) out = { st: "refused", err: j ? (j.field ? j.field + ": " : "") + (j.message || j.error) : `the verifier answered ${r.status} with nothing readable` };
      else out = { st: "read", r: j.result, from: j.readFrom || {}, assumptions: j.assumptions || [], at: Date.now() };
    } catch { out = { st: "none", err: "the verifier did not answer. That is no reading at all — not an empty grant." }; }
    setReadings((r) => ({ ...r, [k]: out }));
  }, []);

  const sync = useCallback(async (acc: Me) => {
    const list = [...ownRef.current];
    const mine = new Set(list.map((x) => ownKey(x.m)));
    const have = new Set(acc.grants.map((g) => g.key));
    for (const g of acc.grants) {
      if (!mine.has(g.key)) { list.push({ m: g.manifest, added: g.addedAt, synced: true, payee: g.payee, note: g.followNote, movedAt: g.movedAt }); readGrant(g.manifest); continue; }
      const x = list.find((o) => ownKey(o.m) === g.key)!;
      x.payee = g.payee; x.note = g.followNote; x.movedAt = g.movedAt;
      if (Number(g.manifest.spent_total || 0) > Number(x.m.spent_total || 0)) { x.m = g.manifest; readGrant(x.m); }
    }
    for (const x of list) {
      if (x.local) continue;
      const k = ownKey(x.m);
      if (!have.has(k)) { const j = await accountApi("grant", { key: k, manifest: x.m }); x.synced = j.ok; }
      else x.synced = true;
    }
    setOwn(list);
  }, [readGrant]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(async () => {
    const j = await accountApi<{ account: Me }>("me");
    if (j.ok) {
      setUp(true); setMe(j.account); sync(j.account);
      accountApi<{ history: Ctx["history"] }>("history").then((h) => { if (h.ok) setHistory(h.history); });
    } else { setMe(null); setUp(j.error === "not_configured" || j.error === "http" || j.error === "network" ? false : true); }
  }, [sync]);

  useEffect(() => {
    reload();
    for (const x of ownRef.current) readGrant(x.m);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const signIn = useCallback(async (op: "signin" | "link" = "signin") => {
    if (!wallet || wallet.problem) return "Connect a wallet with no problems showing first.";
    try {
      const n = await accountApi<{ nonce: string; host: string }>("nonce");
      if (!n.ok) throw new Error(n.message || "no nonce");
      const msg = signinMessage(wallet.address, n.nonce, n.host, wallet.family === "evm" ? wallet.chainId ?? 1 : 1);
      const signature = await sign(msg);
      const j = await accountApi<{ account: Me }>(op, { kind: wallet.family, address: wallet.address, message: msg, signature });
      if (!j.ok) return j.message || "Not signed in.";
      setUp(true); setMe(j.account); sync(j.account);
      return op === "link" ? "Wallet added." : "Signed in.";
    } catch (e: any) {
      const m = String(e?.message ?? e);
      return /reject|denied|cancel/i.test(m) || e?.code === 4001 ? "Not signed in — you declined, which is always fine." : `Not signed in: ${m}`;
    }
  }, [wallet, sign, sync]);

  const signOut = useCallback(async () => { await accountApi("signout", {}); setMe(null); setHistory(null); }, []);

  const addGrant = useCallback((text: string, from: string) => {
    let m: unknown;
    try { m = JSON.parse(text); } catch (e) { return `${from}: not valid JSON (${(e as Error).message})`; }
    const bad = checkManifest(m);
    if (bad) return `${from}: ${bad}`;
    const man = m as Manifest, k = ownKey(man);
    const entry: Own = { m: man, added: new Date().toISOString() };
    const list = [...ownRef.current.filter((x) => ownKey(x.m) !== k), entry];
    setOwn(list);
    if (me) accountApi("grant", { key: k, manifest: man }).then((j) => { if (j.ok) { entry.synced = true; setOwn([...ownRef.current]); } });
    readGrant(man);
    return saveOwn(list) ? null : `${from}: added for this visit, but this browser would not keep it (storage is blocked here)`;
  }, [me, readGrant]); // eslint-disable-line react-hooks/exhaustive-deps

  const removeGrant = useCallback((key: string) => {
    setOwn(ownRef.current.filter((x) => ownKey(x.m) !== key));
    setReadings((r) => { const n = { ...r }; delete n[key]; return n; });
    if (me) accountApi("ungrant", { key });
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLocal = useCallback((key: string, local: boolean) => {
    const x = ownRef.current.find((o) => ownKey(o.m) === key); if (!x) return;
    x.local = local;
    if (local) { x.synced = false; accountApi("ungrant", { key }); }
    else accountApi("grant", { key, manifest: x.m }).then((j) => { x.synced = j.ok; setOwn([...ownRef.current]); });
    setOwn([...ownRef.current]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceManifest = useCallback((key: string, m: Manifest) => {
    const x = ownRef.current.find((o) => ownKey(o.m) === key); if (!x) return;
    x.m = m; setOwn([...ownRef.current]); readGrant(m);
  }, [readGrant]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo<Ctx>(() => ({ up, me, history, reload, signIn, signOut, setMe, own, readings, addGrant, removeGrant, readGrant, setLocal, replaceManifest }),
    [up, me, history, reload, signIn, signOut, own, readings, addGrant, removeGrant, readGrant, setLocal, replaceManifest]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useAccount(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error("useAccount outside AccountProvider");
  return v;
}

/* ---- the market price: a sizing aid, never a comparison ---- */
export interface Market { rate: number; at: string; source: string }
let marketP: Promise<Market | { error: string }> | null = null;
export function market(): Promise<Market | { error: string }> {
  marketP ??= fetch("https://api.coingecko.com/api/v3/simple/price?ids=kaspa&vs_currencies=usd")
    .then((r) => r.json())
    .then((j) => { const v = Number(j?.kaspa?.usd); return v > 0 ? { rate: v, at: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }), source: "CoinGecko" } : { error: "no price in the reply. That is not $0." }; })
    .catch(() => { marketP = null; return { error: "could not be fetched. That is not $0 — nothing here depends on it." }; });
  return marketP;
}
export function useMarket() {
  const [m, setM] = useState<Market | { error: string } | null>(null);
  useEffect(() => { market().then(setM); }, []);
  return m;
}

export const SOMPI = 100_000_000;
export function toSompi(usd: string, rate: number | null | undefined): number | null {
  const u = parseFloat(usd);
  if (!isFinite(u) || !rate || rate <= 0 || u < 0) return null;
  return Math.round((u / rate) * SOMPI);
}
export function kasOfSompi(n: number | string | null | undefined): string {
  if (n == null || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : n;
  if (!isFinite(v)) return "—";
  const a = Math.abs(v), whole = Math.floor(a / SOMPI), frac = String(a % SOMPI).padStart(8, "0").replace(/0+$/, "");
  return (v < 0 ? "-" : "") + whole + (frac ? "." + frac : "");
}
