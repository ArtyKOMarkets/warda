/* The one browser wallet the new console talks to directly: KasWare. It is
   asked for a public key (to name you as the grant's owner) and, when you
   press Send, for one payment you approve in its own window. Nothing else. */
declare global {
  interface Window {
    kasware?: {
      requestAccounts(): Promise<string[]>;
      getAccounts(): Promise<string[]>;
      getPublicKey(): Promise<string>;
      getNetwork(): Promise<string>;
      switchNetwork(n: string): Promise<unknown>;
      sendKaspa(to: string, sompi: number, opts?: Record<string, unknown>): Promise<string>;
    };
    WardaWalletConnect?: { qrSvg(uri: string): string | Promise<string> };
  }
}

export const hasKasware = () => typeof window !== "undefined" && !!window.kasware;

export async function kaswareOwner(): Promise<{ address: string; key: string }> {
  const k = window.kasware;
  if (!k) throw new Error("KasWare is not installed in this browser.");
  const [address] = await k.requestAccounts();
  const key = await k.getPublicKey();
  if (!address || !key) throw new Error("KasWare did not share an account.");
  return { address, key };
}

/** Send one payment through KasWare, on the network the address belongs to. */
export async function kaswareSend(to: string, kas: string): Promise<string> {
  const k = window.kasware;
  if (!k) throw new Error("KasWare is not installed in this browser.");
  await k.requestAccounts();
  const want = to.startsWith("kaspatest:") ? "kaspa_testnet_10" : "kaspa_mainnet";
  const net = await k.getNetwork().catch(() => null);
  if (net && net !== want) await k.switchNetwork(want);
  const [whole, frac = ""] = kas.split(".");
  const sompi = Number(BigInt(whole || "0") * 100_000_000n + BigInt((frac + "00000000").slice(0, 8)));
  const r: any = await k.sendKaspa(to, sompi);
  return typeof r === "string" ? r : r?.txid ?? r?.id ?? "";
}

let qr: Promise<Window["WardaWalletConnect"]> | null = null;
/** The QR code generator the site already ships, loaded on first use. */
export function qrSvg(uri: string): Promise<string> {
  qr ??= new Promise((ok, no) => {
    if (window.WardaWalletConnect) return ok(window.WardaWalletConnect);
    const s = document.createElement("script");
    s.src = "/walletconnect-browser.js";
    s.onload = () => (window.WardaWalletConnect ? ok(window.WardaWalletConnect) : no(new Error("no QR")));
    s.onerror = () => { qr = null; no(new Error("no QR")); };
    document.head.appendChild(s);
  });
  return qr.then((L) => Promise.resolve(L!.qrSvg(uri)));
}
