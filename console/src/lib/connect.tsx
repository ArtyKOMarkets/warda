import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { decodeAddress } from "./kaspa";

/* The connected wallet. Every adapter answers the same questions — which
   address, which public key, which network, which coins — and the only thing
   the console ever asks one to SIGN is the plain-text sign-in message for a
   console account. A transfer the person starts (the swap deposit) is a
   wallet prompt they approve themselves; the page builds nothing it signs.

   The address is where the key comes from. What the wallet reports as its
   public key is only checked against it. A 0x address never yields a key:
   it is a hash of an ECDSA key and cannot name the Schnorr key a grant commits to. */

export const NET = "testnet-10";
const KASWARE_NET = "kaspa_testnet_10";
export const IGRA = { chainId: 38836, name: "Igra Galleon testnet", rpcUrl: "https://galleon-testnet.igralabs.com:8545", explorer: "https://explorer.galleon-testnet.igralabs.com" };
const CHAINS: Record<number, string> = { 1: "Ethereum", 8453: "Base", 10: "Optimism", 42161: "Arbitrum", 137: "Polygon", 56: "BNB Chain", 43114: "Avalanche", 38833: "Igra mainnet", 38836: "Igra Galleon testnet", 202555: "Kasplex" };
export const chainName = (id: number | null | undefined) => (id ? CHAINS[id] ?? `chain ${id}` : "an unreported chain");
export const NATIVE: Record<number, string> = { 38833: "iKAS", 38836: "iKAS", 1: "ETH", 8453: "ETH", 42161: "ETH", 10: "ETH", 137: "POL", 43114: "AVAX", 56: "BNB" };

const WKEY = "warda.console.wallet";
const WC_ID = typeof __WC_PROJECT_ID__ === "string" ? __WC_PROJECT_ID__ : "";
export const PHONE = typeof navigator !== "undefined" && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)));

export type KasBal = { total: number; largest: number; n: number; from: "wallet" | "verifier" };
export interface Wallet {
  kind: string; name: string; family: "kaspa" | "evm"; address: string;
  key: string | null; network: string | null; chainId: number | null;
  bal: KasBal | "elsewhere" | "unreadable" | null; wei: bigint | null; problem: string | null;
}

type Eip1193 = { request(a: { method: string; params?: unknown }): Promise<any>; on?(ev: string, fn: (...a: any[]) => void): void; isKasware?: boolean; isMetaMask?: boolean; isRabby?: boolean; isCoinbaseWallet?: boolean };
interface EvmFound { key: string; name: string; icon?: string; provider: Eip1193 }

const store = { get: () => { try { return localStorage.getItem(WKEY); } catch { return null; } },
  set: (v: string | null) => { try { v ? localStorage.setItem(WKEY, v) : localStorage.removeItem(WKEY); } catch { /* */ } } };

const toHex = (b: number[] | Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8Hex = (s: string) => "0x" + toHex(new TextEncoder().encode(s));

function coinValue(e: any): number | null {
  const v = e && (e.amount != null ? e.amount : e.entry?.amount != null ? e.entry.amount : e.utxoEntry?.amount != null ? e.utxoEntry.amount : null);
  if (v == null) return null;
  const n = typeof v === "bigint" ? Number(v) : Number(String(v));
  return isFinite(n) ? n : null;
}

export const VERIFY = "https://verify.wardaprotocol.com";
async function verifierBalance(address: string): Promise<KasBal | null> {
  try {
    const r = await fetch(`${VERIFY}/v1/grant/${encodeURIComponent(address)}`);
    if (!r.ok) return null;
    const g = (await r.json())?.result;
    if (!g) return null;
    if (!g.found) return { total: 0, largest: 0, n: 0, from: "verifier" };
    return { total: parseInt(g.total?.sompi ?? "0", 10), largest: parseInt(g.largest?.sompi ?? "0", 10), n: g.coins ?? 0, from: "verifier" };
  } catch { return null; }
}

/* ---- WalletConnect, loaded the first time someone presses its button ---- */
interface WcState { lib: any; client: any; session: any; chain: string | null; fam: "kaspa" | "evm" | null; app: string | null; attempt: number }
const WC: WcState = { lib: null, client: null, session: null, chain: null, fam: null, app: null, attempt: 0 };
function wcLib(): Promise<any> {
  if (WC.lib) return WC.lib;
  WC.lib = new Promise((ok, no) => {
    const w = window as any;
    if (w.WardaWalletConnect) return ok(w.WardaWalletConnect);
    const s = document.createElement("script");
    s.src = "/walletconnect-browser.js";
    s.onload = () => (w.WardaWalletConnect ? ok(w.WardaWalletConnect) : no(new Error("the WalletConnect client loaded but did not start")));
    s.onerror = () => { WC.lib = null; no(new Error("could not load the WalletConnect client from this site")); };
    document.head.appendChild(s);
  });
  return WC.lib;
}
function wcClient(onGone: () => void, onEvent: () => void): Promise<any> {
  if (WC.client) return WC.client;
  WC.client = wcLib().then((L) => L.SignClient.init({
    projectId: WC_ID,
    metadata: { name: "Warda Console", description: "Reads Warda grants. Asks for your address, and to sign a plain-text sign-in message if you sign in — never a transaction.", url: location.origin, icons: [location.origin + "/assets/mark-200.png"] },
  })).then((c: any) => {
    const gone = () => { WC.session = null; onGone(); };
    c.on("session_delete", gone); c.on("session_expire", gone); c.on("session_event", onEvent);
    return c;
  }, (e: unknown) => { WC.client = null; throw e; });
  return WC.client;
}
const WC_PROPOSAL = {
  kaspa: () => ({ kaspa: { chains: ["kaspa:testnet-10"], methods: ["kaspa_getAccounts", "kaspa_getPublicKey", "kaspa_getNetwork", "kaspa_signPersonal"], events: ["accountsChanged"] } }),
  evm: () => ({ eip155: { chains: [`eip155:${IGRA.chainId}`, "eip155:1"], methods: ["eth_accounts", "eth_chainId", "eth_getBalance", "personal_sign"], events: ["accountsChanged", "chainChanged"] } }),
};
function wcAccounts(s: any): string[] {
  const ns = s.namespaces || {};
  const fam: "kaspa" | "evm" = ns.kaspa && (ns.kaspa.accounts || []).length ? "kaspa" : "evm";
  const want = fam === "kaspa" ? "kaspa:testnet-10" : `eip155:${IGRA.chainId}`;
  // CAIP-10; a Kaspa address has a colon of its own, so it is everything after the second.
  const acc = ((ns[fam === "kaspa" ? "kaspa" : "eip155"] || {}).accounts || []).map((a: string) => {
    const p = String(a).split(":");
    return { chain: p[0] + ":" + p[1], address: p.slice(2).join(":") };
  });
  const pick = acc.find((a: any) => a.chain === want) ?? acc[0];
  WC.fam = fam; WC.chain = pick ? pick.chain : null;
  return pick ? [pick.address] : [];
}
async function wcRequest(method: string, params: unknown) {
  const c = await WC.client;
  if (!c || !WC.session) throw new Error("no WalletConnect session");
  const p = c.request({ topic: WC.session.topic, chainId: WC.chain, request: { method, params } });
  if (PHONE && WC.app) try { window.open(WC.app, "_self"); } catch { /* */ }
  return p;
}
const WC_APPS = {
  evm: [{ name: "MetaMask", base: "https://metamask.app.link/" }, { name: "Trust Wallet", base: "https://link.trustwallet.com/" }, { name: "Rainbow", base: "https://rnbwapp.com/" }, { name: "Coinbase Wallet", base: "https://go.cb-w.com/" }],
  kaspa: [{ name: "Kaspire", base: "https://kaspire.kaslab.space/kaspire/" }],
};

export interface Pairing { fam: "kaspa" | "evm"; svg: string | null; uri: string | null; link: string | null; state: string; apps: { name: string; href: string; base: string }[] }

interface Ctx {
  wallet: Wallet | null;
  busy: boolean;
  error: string | null;
  evm: EvmFound[];
  hasKasware: boolean;
  wcReady: boolean;
  pairing: Pairing | null;
  connect(kind: string, fam?: "kaspa" | "evm"): Promise<void>;
  forget(): void;
  refresh(): void;
  cancelPairing(): void;
  setPairingState(s: string, app?: string): void;
  sign(message: string): Promise<string>;
  /** For an EVM wallet: a raw provider call the wallet shows the person (a transfer they start, a chain switch). */
  rpc(method: string, params: unknown[]): Promise<any>;
  switchChain(id: number): Promise<void>;
  switchKaspa(): Promise<void>;
}
const C = createContext<Ctx | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evm, setEvm] = useState<EvmFound[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const evmRef = useRef<EvmFound[]>([]);
  const kindRef = useRef<string | null>(null);
  const hasKasware = typeof window !== "undefined" && !!(window as any).kasware;
  const wcReady = !!WC_ID && !WC_ID.startsWith("{{");

  const nameOf = (kind: string) => kind === "kasware" ? "KasWare" : kind === "walletconnect" ? (WC.fam === "kaspa" ? "Kaspire" : "WalletConnect") : evmRef.current.find((e) => e.key === kind)?.name ?? "Browser wallet";
  const provOf = (kind: string) => evmRef.current.find((e) => e.key === kind)?.provider;

  const readEvm = useCallback(async (kind: string, address: string): Promise<Wallet> => {
    const p = provOf(kind);
    const req = (m: string, params: unknown[] = []) => kind === "walletconnect" ? wcRequest(m, params) : p!.request({ method: m, params });
    const id = kind === "walletconnect" ? (WC.chain ? Number(WC.chain.split(":")[1]) : null) : await req("eth_chainId").then(Number).catch(() => null);
    const w: Wallet = { kind, name: nameOf(kind), family: "evm", address, key: null, network: id ? chainName(id) : null, chainId: id, bal: null, wei: null, problem: null };
    w.wei = await req("eth_getBalance", [address, "latest"]).then((h: string) => { try { return BigInt(h); } catch { return null; } }).catch(() => null);
    return w;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const read = useCallback(async (kind: string, addresses: string[] | null | undefined): Promise<Wallet | null> => {
    const address = (addresses ?? [])[0];
    if (!address) return null;
    const fam = kind === "walletconnect" ? WC.fam ?? "kaspa" : kind === "kasware" ? "kaspa" : "evm";
    if (fam === "evm") return readEvm(kind, address);
    const k = (window as any).kasware;
    const [pk, net, coins] = kind === "kasware"
      ? await Promise.all([k.getPublicKey().catch(() => null), k.getNetwork().catch(() => null), k.getUtxoEntries([address]).catch(() => null)])
      : await Promise.all([wcRequest("kaspa_getPublicKey", {}).then((r: any) => typeof r === "string" ? r : r?.publicKey ?? r?.pubkey ?? null).catch(() => null),
          Promise.resolve(WC.chain === "kaspa:mainnet" ? "kaspa_mainnet" : WC.chain === "kaspa:testnet-10" ? KASWARE_NET : null), Promise.resolve(null)]);
    const w: Wallet = { kind, name: nameOf(kind), family: "kaspa", address, key: null, network: net, chainId: null, bal: null, wei: null, problem: null };
    const d = decodeAddress(address);
    if (!d) w.problem = "The address the wallet gave does not decode.";
    else if (d.version !== 0) w.problem = "This is not a Schnorr (version 0) address. A Warda grant names a 32-byte Schnorr key, so this account cannot be the principal of one.";
    else {
      w.key = toHex(d.payload);
      const rep = String(pk ?? "").toLowerCase();
      if (rep && rep.slice(-64) !== w.key) { w.problem = "The wallet's public key and its address do not describe the same key. Nothing here will use either until they agree."; w.key = null; }
    }
    const elsewhere = !!(w.network && w.network !== KASWARE_NET);
    if (elsewhere) { w.problem = `Your wallet is on ${w.network!.replace(/_/g, "-")} and this console reads ${NET}. Addresses on one are not coins on the other.`; w.bal = "elsewhere"; return w; }
    if (Array.isArray(coins)) {
      const raw = coins.map(coinValue);
      if (raw.some((v) => v == null)) w.bal = "unreadable";
      else { const vals = raw as number[]; w.bal = { total: vals.reduce((a, v) => a + v, 0), largest: vals.reduce((m, v) => (v > m ? v : m), 0), n: vals.length, from: "wallet" }; }
      return w;
    }
    w.bal = await verifierBalance(address);
    return w;
  }, [readEvm]); // eslint-disable-line react-hooks/exhaustive-deps

  const restore = useCallback(async () => {
    const kind = store.get();
    kindRef.current = kind;
    if (!kind) { setWallet(null); return; }
    try {
      let addrs: string[] = [];
      if (kind === "kasware") { if (!(window as any).kasware) return; addrs = await (window as any).kasware.getAccounts(); }
      else if (kind === "walletconnect") {
        if (!wcReady) return;
        const c = await wcClient(() => { if (kindRef.current === "walletconnect") forget(); }, () => restore());
        const all = c.session.getAll().filter((s: any) => s.expiry * 1000 > Date.now());
        WC.session = all[all.length - 1] ?? null;
        addrs = WC.session ? wcAccounts(WC.session) : [];
      } else {
        const p = provOf(kind);
        if (!p) return; // not announced yet; a later announcement retries
        addrs = await p.request({ method: "eth_accounts" });
      }
      const w = await read(kind, addrs);
      if (!w) store.set(null);
      setWallet(w);
    } catch { setWallet(null); }
  }, [read, wcReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const forget = useCallback(() => {
    if (kindRef.current === "walletconnect" && WC.session) {
      WC.client?.then((c: any) => c.disconnect({ topic: WC.session.topic, reason: { code: 6000, message: "disconnected in the console" } }).catch(() => {}));
      WC.session = null;
    }
    store.set(null); kindRef.current = null; setWallet(null); setError(null);
  }, []);

  // EIP-6963 discovery: every extension announces itself, so MetaMask and Rabby side by side are two buttons.
  useEffect(() => {
    const add = (f: EvmFound) => {
      if (evmRef.current.some((e) => e.key === f.key)) return;
      evmRef.current = [...evmRef.current, f]; setEvm(evmRef.current);
      f.provider.on?.("accountsChanged", () => { if (kindRef.current === f.key) restore(); });
      f.provider.on?.("chainChanged", () => { if (kindRef.current === f.key) restore(); });
      if (store.get() === f.key && kindRef.current !== f.key) restore();
    };
    const on = (e: any) => { const d = e.detail || {}; if (d.info && d.provider) add({ key: "evm:" + (d.info.rdns || d.info.name || "injected"), name: d.info.name, icon: /^data:image\//.test(d.info.icon ?? "") ? d.info.icon : undefined, provider: d.provider }); };
    addEventListener("eip6963:announceProvider", on);
    dispatchEvent(new Event("eip6963:requestProvider"));
    const t = setTimeout(() => {
      const eth = (window as any).ethereum as Eip1193 | undefined;
      if (!evmRef.current.length && eth && !eth.isKasware)
        add({ key: "evm:injected", name: eth.isMetaMask ? "MetaMask" : eth.isRabby ? "Rabby" : eth.isCoinbaseWallet ? "Coinbase Wallet" : "Browser wallet", provider: eth });
    }, 300);
    const k = (window as any).kasware;
    if (k?.on) { k.on("accountsChanged", () => { if (kindRef.current === "kasware") restore(); }); k.on("networkChanged", () => { if (kindRef.current === "kasware") restore(); }); }
    restore();
    return () => { removeEventListener("eip6963:announceProvider", on); clearTimeout(t); };
  }, [restore]);

  const wcConnect = useCallback((fam: "kaspa" | "evm"): Promise<string[]> => {
    const attempt = ++WC.attempt;
    const dead = () => WC.attempt !== attempt;
    setPairing({ fam, svg: null, uri: null, link: null, state: "Preparing a pairing…", apps: [] });
    return new Promise((ok, no) => {
      (WC as any).reject = no;
      wcClient(() => { if (kindRef.current === "walletconnect") forget(); }, () => restore()).then(async (c: any) => {
        const r = await c.connect({ optionalNamespaces: WC_PROPOSAL[fam]() });
        if (dead()) return;
        const kaspire = "https://kaspire.kaslab.space/kaspire/wc?uri=" + encodeURIComponent(r.uri);
        const L = await wcLib();
        const svg = await L.qrSvg(fam === "kaspa" ? kaspire : r.uri);
        if (dead()) return;
        setPairing({ fam, svg, uri: r.uri, link: fam === "kaspa" ? kaspire : null,
          state: PHONE ? "Waiting for your wallet…" : "Waiting for your wallet… the pairing lasts about five minutes.",
          apps: PHONE ? WC_APPS[fam].map((a) => ({ name: a.name, base: a.base, href: a.base + "wc?uri=" + encodeURIComponent(r.uri) })) : [] });
        const session = await r.approval();
        if (dead() || !session) return;
        WC.session = session;
        setPairing(null);
        ok(wcAccounts(session));
      }).catch((e: unknown) => { if (!dead()) { setPairing(null); no(e); } });
    });
  }, [forget, restore]);

  const connect = useCallback(async (kind: string, fam?: "kaspa" | "evm") => {
    setError(null); setBusy(true);
    try {
      let addrs: string[];
      if (kind === "kasware") {
        const k = (window as any).kasware;
        if (!k) throw new Error("__absent");
        addrs = await k.requestAccounts();
      } else if (kind === "walletconnect") {
        if (!wcReady) throw new Error("WalletConnect is not set up on this site yet: it needs a project id from Reown.");
        addrs = await wcConnect(fam ?? "kaspa");
      } else {
        const p = provOf(kind);
        if (!p) throw new Error("__absent");
        addrs = await p.request({ method: "eth_requestAccounts" });
      }
      const w = await read(kind, addrs);
      if (!w) { setError("The wallet returned no address."); return; }
      store.set(kind); kindRef.current = kind; setWallet(w);
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setError(m === "__absent" ? "That wallet is not installed in this browser."
        : /reject|denied|cancel|declin/i.test(m) || e?.code === 4001 ? "Not connected — you declined, which is always fine."
        : /expire/i.test(m) ? "The pairing expired before a wallet answered. Try again when your phone is ready."
        : m.startsWith("WalletConnect is not") ? m : `The wallet did not connect: ${m}`);
    } finally { setBusy(false); }
  }, [read, wcConnect, wcReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const sign = useCallback(async (message: string): Promise<string> => {
    const w = wallet; if (!w) throw new Error("No wallet connected.");
    if (w.kind === "kasware") { const k = (window as any).kasware; return k.signMessage(message, { type: "schnorr" }).catch(() => k.signMessage(message)); }
    if (w.kind === "walletconnect") return w.family === "kaspa"
      ? wcRequest("kaspa_signPersonal", { address: w.address, message }).then((r: any) => typeof r === "string" ? r : r?.signature ?? r?.sig)
      : wcRequest("personal_sign", [utf8Hex(message), w.address]);
    return provOf(w.kind)!.request({ method: "personal_sign", params: [utf8Hex(message), w.address] });
  }, [wallet]);

  const rpc = useCallback((method: string, params: unknown[]) => {
    const w = wallet; if (!w || w.family !== "evm") return Promise.reject(new Error("No Ethereum-style wallet connected."));
    return w.kind === "walletconnect" ? wcRequest(method, params) : provOf(w.kind)!.request({ method, params });
  }, [wallet]);

  const switchChain = useCallback(async (id: number) => {
    const hex = "0x" + id.toString(16);
    try { await rpc("wallet_switchEthereumChain", [{ chainId: hex }]); }
    catch (e: any) {
      if (e?.code !== 4902 || id !== IGRA.chainId) throw e;
      await rpc("wallet_addEthereumChain", [{ chainId: hex, chainName: IGRA.name, nativeCurrency: { name: "iKAS", symbol: "iKAS", decimals: 18 }, rpcUrls: [IGRA.rpcUrl], blockExplorerUrls: [IGRA.explorer] }]);
    }
    await restore();
  }, [rpc, restore]);

  const switchKaspa = useCallback(async () => { await (window as any).kasware.switchNetwork(KASWARE_NET); await restore(); }, [restore]);

  const cancelPairing = useCallback(() => { WC.attempt++; setPairing(null); (WC as any).reject?.(new Error("cancelled")); }, []);
  const setPairingState = useCallback((s: string, app?: string) => { if (app) WC.app = app; setPairing((p) => p && { ...p, state: s }); }, []);

  const value = useMemo<Ctx>(() => ({ wallet, busy, error, evm, hasKasware, wcReady, pairing, connect, forget, refresh: restore, cancelPairing, setPairingState, sign, rpc, switchChain, switchKaspa }),
    [wallet, busy, error, evm, hasKasware, wcReady, pairing, connect, forget, restore, cancelPairing, setPairingState, sign, rpc, switchChain, switchKaspa]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useWallet(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

/** 18-decimal wei → two places, by string so a large balance is not rounded in a double first. */
export function weiKas(w: bigint | null): string | null {
  if (w == null) return null;
  const s = w.toString().padStart(19, "0"), whole = s.slice(0, -18), frac = s.slice(-18, -16);
  return Number(whole).toLocaleString("en-US") + (frac !== "00" ? "." + frac.replace(/0$/, "") : "");
}
