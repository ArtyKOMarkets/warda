import { useState } from "react";
import { ArrowRight, Check, Copy as CopyIco, KeyRound, Loader2, QrCode, RefreshCw, Smartphone, Wallet as WalletIco, X } from "lucide-react";
import { useWallet, chainName, NATIVE, NET, PHONE, weiKas, IGRA } from "@/lib/connect";
import { useHoldings, money, type Holding } from "@/lib/routes";
import { href } from "@/lib/router";
import { kas, short, ago } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge, Button, Card, CardHeader, Copy, LinkButton, Row } from "./ui";

const SOMPI = 1e8;
const FEE = 1_000_000;

export function PairingModal() {
  const { pairing, cancelPairing, setPairingState } = useWallet();
  const [showQr, setShowQr] = useState(false);
  if (!pairing) return null;
  const kaspa = pairing.fam === "kaspa";
  const phoneApps = PHONE && pairing.apps.length && !showQr;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4" role="dialog" aria-modal="true" onKeyDown={(e) => e.key === "Escape" && cancelPairing()}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={cancelPairing} />
      <Card className="rise relative w-full max-w-sm p-6">
        <button onClick={cancelPairing} className="absolute right-3 top-3 grid size-8 place-items-center rounded-lg text-fg-3 hover:bg-raised hover:text-fg" aria-label="Cancel"><X className="size-4" /></button>
        <div className="text-[17px] font-semibold">{kaspa ? "Connect Kaspire" : "Connect a phone wallet"}</div>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-2">
          {PHONE
            ? kaspa ? "Opens Kaspire on this phone. It asks to share your address and public key. Nothing it asks for can move a coin." : "Pick your wallet. It opens, asks to share your address, and you come back here. Nothing it asks for can move a coin."
            : kaspa ? "Scan with your phone's camera. It opens Kaspire, which asks you to approve sharing your address and public key, and signing a plain-text sign-in message if you choose to sign in. Nothing it asks for can move a coin."
              : "Open your wallet app and scan this with its WalletConnect scanner — MetaMask, Trust, Rainbow, Coinbase and most others have one. It asks you to share your address, and to sign a plain-text sign-in message if you choose to sign in. Nothing it asks for can move a coin."}
        </p>
        {phoneApps ? (
          <div className="mt-5 space-y-2">
            {pairing.apps.map((a) => (
              <a key={a.name} href={a.href} rel="noopener" onClick={() => setPairingState(`Approve in ${a.name}, then come back to this page.`, a.base)}
                className="flex items-center justify-between rounded-xl border border-line-strong px-4 py-3 text-[14px] font-medium transition hover:bg-raised">
                {a.name}<span className="flex items-center gap-1 text-[12.5px] text-fg-3">Open app <ArrowRight className="size-3.5" /></span>
              </a>
            ))}
            <button className="text-[12.5px] text-fg-3 hover:text-fg" onClick={() => setShowQr(true)}>Show a QR code instead</button>
          </div>
        ) : (
          <div className="mt-5 grid place-items-center">
            {pairing.svg ? <div className="rounded-xl bg-white p-3 [&_svg]:size-[216px]" dangerouslySetInnerHTML={{ __html: pairing.svg }} />
              : <div className="grid size-[240px] place-items-center rounded-xl border border-dashed border-line-strong text-fg-3"><QrCode className="size-8" /></div>}
          </div>
        )}
        <p className="mt-4 flex items-center gap-2 text-[12.5px] text-fg-3"><Loader2 className="size-3.5 shrink-0 animate-spin text-accent" /> {pairing.state}</p>
        {pairing.uri && (
          <div className="mt-4 flex flex-wrap gap-2">
            {kaspa && !PHONE && pairing.link && <LinkButton size="sm" href={pairing.link} target="_blank" rel="noopener">Open Kaspire</LinkButton>}
            <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(pairing.uri!).then(() => setPairingState("Pairing link copied. Paste it into your wallet's WalletConnect screen."), () => setPairingState(pairing.uri!))}>
              <CopyIco className="size-3.5" /> Copy pairing link
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

function Option({ title, sub, action }: { title: string; sub: string; action: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1"><div className="text-[14px] font-medium">{title}</div><div className="text-[12.5px] text-fg-3">{sub}</div></div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

export function ConnectOptions() {
  const { connect, busy, error, evm, hasKasware, wcReady } = useWallet();
  return (
    <Card>
      <CardHeader title="Connect a wallet" sub="It shares your address and public key. The only thing the console ever asks it to sign is a plain-text sign-in message — never a transaction." />
      <div className="p-5 pt-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">Kaspa wallets — can hold a grant's key</div>
        <div className="divide-y divide-line">
          <Option title="KasWare" sub={hasKasware ? "installed in this browser" : "not installed in this browser"}
            action={hasKasware ? <Button variant="primary" size="sm" disabled={busy} onClick={() => connect("kasware")}>Connect KasWare</Button>
              : <LinkButton size="sm" href="https://chromewebstore.google.com/detail/kasware-wallet/hklhheigdmpoolooomdihmhlpjjdbklf" target="_blank" rel="noopener">Get KasWare</LinkButton>} />
          <Option title="Kaspire" sub={!wcReady ? "WalletConnect is not set up on this site yet" : PHONE ? "opens the Kaspire app on this phone" : "on your phone, by QR code, over WalletConnect"}
            action={<Button size="sm" disabled={!wcReady || busy} onClick={() => connect("walletconnect", "kaspa")}><Smartphone className="size-3.5" /> {PHONE ? "Open Kaspire" : "Connect Kaspire"}</Button>} />
        </div>
        <div className="mt-4 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">Any other wallet — MetaMask, Rabby, Coinbase, Trust…</div>
        <div className="divide-y divide-line">
          <Option title="In this browser" sub={evm.length ? "found in this browser" : PHONE ? "or open this page inside your wallet app's own browser, where it connects directly" : "no Ethereum-style wallet extension found"}
            action={<div className="flex flex-wrap gap-2">{evm.map((e) => (
              <Button key={e.key} size="sm" disabled={busy} onClick={() => connect(e.key)}>{e.icon && <img src={e.icon} alt="" className="size-4 rounded" />}Connect {e.name}</Button>
            ))}{!evm.length && PHONE && <LinkButton size="sm" href={`https://metamask.app.link/dapp/${location.host}${location.pathname}`}>Open in MetaMask's browser</LinkButton>}</div>} />
          <Option title="On your phone" sub={!wcReady ? "WalletConnect is not set up on this site yet" : PHONE ? "MetaMask, Trust, Rainbow, Coinbase — opens the app to approve" : "any WalletConnect wallet, by QR code"}
            action={<Button size="sm" disabled={!wcReady || busy} onClick={() => connect("walletconnect", "evm")}>{PHONE ? "Connect a wallet app" : "Connect with WalletConnect"}</Button>} />
        </div>
        {error && <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{error}</p>}
        <p className="mt-4 text-[12px] leading-relaxed text-fg-3">A grant lives on Kaspa, so the key it names is a Kaspa key. An Ethereum-style wallet signs in here all the same — it keeps an account, tracks grants and pays for a swap with USDC or USDT. It just can't be the key a grant names.</p>
      </div>
    </Card>
  );
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub: React.ReactNode }) {
  return <div className="min-w-0 p-5"><div className="text-[12px] text-fg-3">{label}</div><div className="num mt-1.5 truncate text-[20px] font-semibold tracking-[-0.02em]">{value}</div><div className="mt-1.5 text-[12px] leading-snug text-fg-3">{sub}</div></div>;
}

export function WalletCard() {
  const { wallet: w, forget, switchKaspa, switchChain, hasKasware, evm, connect } = useWallet();
  // KasWare announces an Ethereum-style provider as well as its Kaspa one.
  const kasEvm = evm.find((e) => /kasware/i.test(e.name) || /kasware/i.test(e.key));
  const dual = hasKasware && !!kasEvm && (w?.kind === "kasware" || w?.kind === kasEvm?.key);
  const [err, setErr] = useState<string | null>(null);
  if (!w) return <ConnectOptions />;
  const b = typeof w.bal === "object" ? w.bal : null;
  const k2 = (n: number) => kas(n / SOMPI, { max: 2 });
  const tiles = w.family === "kaspa" ? [
    { label: "Balance", value: b ? <>{k2(b.total)} <span className="text-[12px] text-fg-3">KAS</span></> : "—",
      sub: w.bal === "elsewhere" ? `not shown: those coins are on ${w.network?.replace(/_/g, "-")}` : w.bal === "unreadable" ? "the wallet returned coins this page could not read — not zero" : !b ? "neither the wallet nor the verifier answered — not zero" : `across ${b.n} coin${b.n === 1 ? "" : "s"}${b.from === "verifier" ? " · read by the verifier, not the wallet" : ""}` },
    { label: "Largest single coin", value: b ? <>{k2(b.largest)} <span className="text-[12px] text-fg-3">KAS</span></> : "—", sub: "a grant is funded from one coin, so this — not the balance — bounds it" },
    { label: "Largest grant you can fund now", value: !b ? "—" : b.largest > FEE ? <>{k2(b.largest - FEE)} <span className="text-[12px] text-fg-3">KAS</span></> : "none",
      sub: b && b.total - b.largest > FEE ? "more is possible after consolidating: warda wallet consolidate" : "after the 0.01 KAS network fee" },
  ] : [
    { label: `Balance on ${chainName(w.chainId)}`, value: w.wei == null ? "—" : <>{weiKas(w.wei)} <span className="text-[12px] text-fg-3">{NATIVE[w.chainId ?? 0] ?? "native"}</span></>, sub: w.wei == null ? "the wallet did not report one — not zero" : "the chain's own coin, read through your wallet" },
    { label: "Kaspa key", value: "none", sub: "an Ethereum-style address can't name the Schnorr key a grant commits to" },
    { label: "What it can do here", value: "pay · track", sub: "pay for a swap with USDC or USDT, sign in, and track any grant.json" },
  ];
  const doSwitch = async () => {
    setErr(null);
    try { if (w.family === "kaspa") await switchKaspa(); else await switchChain(IGRA.chainId); }
    catch (e) { setErr(`The wallet did not switch: ${(e as Error).message}`); }
  };
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-line-strong bg-raised">{w.family === "kaspa" ? <KeyRound className="size-5 text-accent" /> : <WalletIco className="size-5 text-fg-2" />}</div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><span className="text-[15px] font-semibold">{w.name}</span>
              {w.problem ? <Badge tone="warn" dot>Check</Badge> : <Badge tone="ok" dot>Connected</Badge>}
              <Badge>{w.family === "kaspa" ? `Kaspa · ${NET}` : chainName(w.chainId)}</Badge></div>
            <div className="mt-0.5 flex items-center gap-1"><span className="num truncate text-[12.5px] text-fg-3">{short(w.address, 16, 8)}</span><Copy text={w.address} label="Copy address" /></div>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {w.problem && w.family === "kaspa" && / is on /.test(w.problem) && w.kind === "kasware" && hasKasware && <Button size="sm" onClick={doSwitch}>Switch to {NET}</Button>}
          <Button size="sm" variant="ghost" onClick={forget}>Disconnect</Button>
        </div>
      </div>
      {dual && (
        <div className="mx-5 mb-4 rounded-xl border border-line-strong p-3.5">
          <div className="text-[13px] font-medium">This wallet has two accounts</div>
          <div className="mt-2 flex rounded-lg border border-line-strong bg-surface p-0.5">
            {([["kasware", `Kaspa · ${NET}`], [kasEvm!.key, "Igra · 0x account"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => connect(k)} className={cn("h-8 flex-1 rounded-md px-2 text-[12.5px] font-medium transition", w.kind === k ? "bg-raised text-fg" : "text-fg-3 hover:text-fg-2")}>{label}</button>
            ))}
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-fg-3">
            {w.family === "kaspa" ? "You are on its Kaspa account — your KAS, and the key a grant names. Switch to the 0x account to pay with USDC or USDT."
              : `You are on its 0x account — for paying with USDC or USDT. Your ${NET} KAS and the key a grant needs are on its Kaspa account.`}
          </p>
        </div>
      )}
      {w.problem && <p className="mx-5 mb-4 rounded-lg bg-warn/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">{w.problem}</p>}
      {err && <p className="mx-5 mb-4 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{err}</p>}
      <div className="grid grid-cols-[minmax(0,1fr)] border-t border-line sm:grid-cols-3 [&>*+*]:border-t [&>*+*]:border-line sm:[&>*+*]:border-l sm:[&>*+*]:border-t-0">
        {tiles.map((t) => <Tile key={t.label} {...t} />)}
      </div>
      {w.family === "kaspa" && (
        <dl className="divide-y divide-line border-t border-line px-5">
          <Row label="Public key"><span className="num break-all text-[12px] text-fg-2">{w.key ?? "—"}</span></Row>
          <Row label="Network">{(w.network ?? "not reported").replace(/_/g, "-")}</Row>
        </dl>
      )}
    </Card>
  );
}

export function UseIt() {
  const { wallet: w } = useWallet();
  if (!w) return null;
  const kaspa = w.family === "kaspa";
  return (
    <Card className="p-5">
      <div className="text-[15px] font-semibold">Use it</div>
      <p className="mt-1 text-[13px] text-fg-3">Each fills in your address and opens the page. Nothing is sent or signed.</p>
      <div className="mt-4 flex flex-col gap-2">
        {kaspa ? <LinkButton href="#/create" className="justify-between">Create a grant from this wallet <ArrowRight className="size-4" /></LinkButton>
          : <Button disabled className="justify-between">Create a grant — needs a Kaspa address</Button>}
        <LinkButton href={href("fund", "stablecoin")} className="justify-between">{kaspa ? "Get KAS for this wallet with USDC" : "Pay for KAS from this wallet"} <ArrowRight className="size-4" /></LinkButton>
        {kaspa ? <LinkButton href={href("alerts", "watch", w.address)} className="justify-between">Get told when it receives <ArrowRight className="size-4" /></LinkButton>
          : <Button disabled className="justify-between">Alerts watch Kaspa addresses</Button>}
      </div>
    </Card>
  );
}

export function Holdings({ onUse }: { onUse?: (h: Holding) => void }) {
  const { wallet: w } = useWallet();
  const addr = w?.family === "evm" ? w.address : null;
  const h = useHoldings(addr);
  if (!addr) return null;
  const held = (h.rows ?? []).filter((r) => !r.err && r.raw! > 0n).sort((a, b) => Number(b.amount) - Number(a.amount));
  const errs = (h.rows ?? []).filter((r) => r.err);
  const chains = new Set((h.rows ?? []).map((r) => r.chain)).size;
  return (
    <Card>
      <CardHeader title="Stablecoins in this wallet" sub={h.busy ? "reading…" : h.at ? `${chains} chains · read ${ago(h.at)}` : "Reading each chain…"}
        action={<Button size="sm" variant="ghost" disabled={h.busy} onClick={h.refresh}><RefreshCw className={cn("size-3.5", h.busy && "animate-spin")} /> Read again</Button>} />
      <ul className="mt-3 divide-y divide-line">
        {h.rows === null ? <li className="px-5 pb-5 text-[13px] text-fg-3">Reading each chain…</li> : held.length ? held.map((r) => (
          <li key={r.chain + r.token} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1"><div className="num text-[15px] font-medium">{money(r.amount!)} <span className="text-[12px] text-fg-3">{r.token}</span></div><div className="text-[12px] text-fg-3">on {r.chain}</div></div>
            <LinkButton size="sm" href={href("fund", "stablecoin", r.chain, r.token, r.amount!)} onClick={onUse ? (e) => { e.preventDefault(); onUse(r); } : undefined}>Use it <ArrowRight className="size-3.5" /></LinkButton>
          </li>
        )) : <li className="px-5 pb-4 text-[13px] text-fg-3">No USDC or USDT on the chains this console pays from{errs.length ? " that answered" : ""}.</li>}
      </ul>
      <p className="border-t border-line px-5 py-3 text-[12px] leading-relaxed text-fg-3">
        {errs.length ? `Not read: ${errs.map((e) => `${e.token} on ${e.chain} (${e.err})`).join(", ")}. Not read is not zero. ` : ""}
        Read from each chain's public node for this address, whichever chain your wallet is on. Only USDC and USDT.
      </p>
    </Card>
  );
}

export function SignedNote() {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-[14px] font-semibold"><Check className="size-4 text-accent" /> What signing in is not</div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-fg-2">Not a transaction. The only thing the console asks a wallet to sign for your account is a plain-text sign-in message, checked by this site's server and used once. If a page here ever asks your wallet to sign anything else for that, don't.</p>
    </Card>
  );
}
