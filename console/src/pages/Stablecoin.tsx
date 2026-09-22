import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, CircleAlert, Copy as CopyIco, ExternalLink, Loader2, Send, ShieldCheck } from "lucide-react";
import { useWallet, chainName } from "@/lib/connect";
import { useMarket } from "@/lib/account";
import { useRoutes, routeOpen, stale, useHoldings, money, units, word, type Routes, type Source, type Token } from "@/lib/routes";
import { decodeAddress } from "@/lib/kaspa";
import { planIgra, ACTION } from "@/lib/router-plan";
import { href } from "@/lib/router";
import { ago, short } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge, Button, Card, CardHeader, LinkButton, type Tone } from "@/components/ui";
import { Field, Select, inputCls } from "@/components/form";

/* Pay with the stablecoin you hold; it becomes native KAS at a Kaspa address.
   ChangeNOW is the one route that runs today: it holds the money for the
   minutes of the swap, is named as the custodian, and needs a tick to say so.
   /api/swap holds only its API key and stores nothing. This page signs
   nothing: the deposit is a transfer your wallet shows you. */

const CN_KEY = "warda.console.swap";
export const FOR_KEY = "warda.next.fundfor";
interface Swap { id: string; chain: string; chainId: number; token: Token; network: string; amount: string; payin: string; extraId: string | null; to: string; toAmount: string | null; tokenContract: string | null; created: string; usd: string; last?: string; sentTx?: string }
interface Quote { ok: true; amount: string | null; min: number | null; max: number | null; toAmount: number | null; speed: string | null; warning: string | null; partnerFeePct: string | null; says: string }
type QuoteRes = Quote | { ok: false; message: string };
interface Status { ok: true; status: string; says: string; from: { hash: string | null }; to: { sent: number | null; hash: string | null; address: string }; refundHash: string | null; updatedAt: string }
export interface FundFor { agent: string; address: string; kas: number }

const loadSwap = (): Swap | null => { try { return JSON.parse(localStorage.getItem(CN_KEY) || "null"); } catch { return null; } };
const saveSwap = (s: Swap | null) => { try { s ? localStorage.setItem(CN_KEY, JSON.stringify(s)) : localStorage.removeItem(CN_KEY); } catch { /* */ } };
const unpaid = (s: Swap | null) => !!s && (!s.last || ["new", "waiting", "expired"].includes(s.last));
const TERMINAL = ["finished", "failed", "refunded"];
const EVM_TX: Record<string, string> = { base: "https://basescan.org/tx/", eth: "https://etherscan.io/tx/", arbitrum: "https://arbiscan.io/tx/", op: "https://optimistic.etherscan.io/tx/", matic: "https://polygonscan.com/tx/", avaxc: "https://snowtrace.io/tx/", bsc: "https://bscscan.com/tx/" };
const STEPS: [string, string][] = [["waiting", "Waiting for your deposit"], ["confirming", "Deposit seen — waiting for confirmations"], ["exchanging", "Swapping"], ["sending", "Sending KAS to your address"], ["finished", "KAS delivered"]];

function mainnetCheck(addr: string): string {
  const a = addr.trim();
  if (!a) return "Enter the Kaspa address the KAS should land at.";
  const d = decodeAddress(a);
  if (!d) return "That Kaspa address doesn't check out — its checksum fails.";
  return d.prefix === "kaspa" ? "" : `The swap delivers mainnet KAS, so the address must start kaspa: — this one is ${d.prefix}:.`;
}

export function Stablecoin({ chain: chain0, token: token0, usd: usd0 }: { chain?: string; token?: string; usd?: string }) {
  const routes = useRoutes();
  if (routes === null) return <Card className="p-6"><Loader2 className="size-4 animate-spin text-fg-3" /> </Card>;
  if (routes === false) return <Card className="p-6 text-[13px] text-fg-3">The route table didn't load, so no route is shown — that isn't the same as there being none.</Card>;
  return <Funder routes={routes} chain0={chain0} token0={token0} usd0={usd0} />;
}

function Funder({ routes, chain0, token0, usd0 }: { routes: Routes; chain0?: string; token0?: string; usd0?: string }) {
  const main = routes.networks.mainnet;
  const { wallet, rpc, switchChain } = useWallet();
  const mk = useMarket();
  const rate = mk && "rate" in mk ? mk.rate : null;
  const fundFor = useMemo<FundFor | null>(() => { try { return JSON.parse(sessionStorage.getItem(FOR_KEY) || "null"); } catch { return null; } }, []);

  const [swap, setSwapState] = useState<Swap | null>(loadSwap);
  const setSwap = (s: Swap | null) => { saveSwap(s); setSwapState(s); };
  const [chainI, setChainI] = useState(() => {
    const want = swap?.chain ?? chain0 ?? (wallet?.chainId ? main.sources.find((s) => s.chainId === wallet.chainId)?.chain : undefined);
    return Math.max(0, main.sources.findIndex((s) => s.chain === want));
  });
  const src: Source = main.sources[chainI] ?? main.sources[0]!;
  const [tok, setTok] = useState<Token>((swap?.token ?? token0 ?? "USDC") as Token);
  const token: Token = src.tokens.includes(tok) ? tok : src.tokens[0]!;
  const [usd, setUsd] = useState(() => swap?.usd ?? usd0 ?? (fundFor && rate ? String(Math.ceil(fundFor.kas * rate * 1.06 + 1)) : "100"));
  const [to, setTo] = useState(swap?.to ?? fundFor?.address ?? "");
  const [refund, setRefund] = useState(wallet?.family === "evm" ? wallet.address : "");
  const [ack, setAck] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const [q, setQ] = useState<QuoteRes | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [aside, setAside] = useState<Swap | null>(null);

  // A hosted deposit's amount needs the price; set it once the price arrives.
  const sized = useRef(false);
  useEffect(() => { if (fundFor && rate && !swap && !sized.current && !usd0) { sized.current = true; setUsd(String(Math.ceil(fundFor.kas * rate * 1.06 + 1))); } }, [rate, fundFor, swap, usd0]);
  useEffect(() => { if (!refund && wallet?.family === "evm") setRefund(wallet.address); }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Changing what you pay sets an unpaid swap aside rather than silently reusing it.
  const changed = () => { setCreateErr(null); if (swap && unpaid(swap)) { setAside(swap); setSwap(null); } };

  const only = src.tokenRoutes?.[token];
  const ids = src.routes.filter((r) => !only || only.includes(r));
  const best = ids.find((r) => routeOpen(routes, r) && main.routes[r]!.custody === "none") ?? ids.find((r) => routeOpen(routes, r)) ?? ids[0]!;
  const rid = swap ? "changenow" : pick && ids.includes(pick) ? pick : best;
  const route = main.routes[rid]!;
  const isCn = rid === "changenow";

  // ChangeNOW's own quote, debounced; stale replies dropped.
  const qAt = useRef(0);
  useEffect(() => {
    if (!isCn || swap) return;
    const at = ++qAt.current;
    setQ(null);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/swap?op=quote&chain=${encodeURIComponent(src.chain)}&token=${token}&amount=${encodeURIComponent(usd.trim())}`);
        const j = await r.json().catch(() => ({ ok: false, message: `The swap service answered ${r.status}.` }));
        if (at === qAt.current) setQ(j);
      } catch { if (at === qAt.current) setQ({ ok: false, message: "The swap service did not answer. That is no quote, not a bad one." }); }
    }, 450);
    return () => clearTimeout(t);
  }, [isCn, swap, src.chain, token, usd]);

  const quote = q && q.ok ? q : null;
  const usdN = parseFloat(usd);
  const cnKas = isCn && quote?.toAmount != null && String(quote.amount) === usd.trim() ? Number(quote.toAmount) : null;
  const kasN = cnKas ?? (usdN > 0 && rate ? usdN / rate : null);
  const below = quote && quote.min != null && usdN < quote.min;

  const addrErr = mainnetCheck(to);
  const why: string[] = [];
  if (!swap) {
    if (!stale(routes)) for (const l of route.legs) { const g = main.legs[l]!; if (g.status !== "live") why.push(`${g.via} is ${g.status}${g.since ? ` since ${g.since}` : ""}.`); }
    else why.push("The route status hasn't been checked in over two weeks.");
    const exit = route.legs.map((l) => main.legs[l]!).find((g) => g.minKas);
    if (exit && kasN != null && kasN < exit.minKas!) why.push(`≈ ${Math.floor(kasN).toLocaleString("en-US")} KAS is below the exit bridge's ${exit.minKas!.toLocaleString("en-US")} KAS minimum — this route starts at about $${rate ? Math.ceil(exit.minKas! * rate).toLocaleString("en-US") : "—"}. The instant swap has no such floor.`);
    if (!isCn && !why.length) why.push("This route isn't runnable from the console yet: the swap venue and bridge it needs have no verified, published deployment to point at.");
    if (route.custody !== "none" && !ack) why.push("Tick the box below: this route has a custodian.");
    if (isCn) {
      if (addrErr) why.push(addrErr);
      if (!q) why.push("Waiting for ChangeNOW's quote.");
      else if (!q.ok) why.push(q.message || "No quote from ChangeNOW.");
      else if (below) why.push(`Below ChangeNOW's minimum, ${quote!.min} ${token}.`);
      else if (quote!.partnerFeePct == null) why.push("This site hasn't stated what it earns on a swap, so it won't create one.");
    }
    if (createErr) why.unshift(`ChangeNOW did not create the swap: ${createErr}`);
  }
  const canGo = isCn && (why.length === 0 || (!!createErr && why.length === 1));

  const holdings = useHoldings(wallet?.family === "evm" ? wallet.address : null);
  const hold = holdings.rows?.find((r) => r.chain === src.chain && r.token === token);

  const create = async () => {
    setBusy(true); setCreateErr(null);
    try {
      const r = await fetch("/api/swap?op=create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain: src.chain, token, amount: usd.trim(), address: to.trim(), ...(refund.trim() ? { refundAddress: refund.trim() } : {}) }) });
      const j = await r.json().catch(() => null);
      if (!j?.ok) { setCreateErr(j?.message || "The swap service did not answer; nothing was created."); return; }
      const cn = src.changenow![token]!;
      setSwap({ id: j.id, chain: src.chain, chainId: src.chainId, token, network: cn.network, amount: String(j.fromAmount), payin: j.payinAddress, extraId: j.payinExtraId ?? null, to: j.payoutAddress, toAmount: j.toAmount != null ? String(j.toAmount) : null, tokenContract: j.tokenContract ?? null, created: new Date().toISOString(), usd: usd.trim() });
      setAside(null);
    } catch (e) { setCreateErr(`The swap service did not answer (${(e as Error).message}); nothing was created.`); }
    finally { setBusy(false); }
  };

  const pillOf = (id: string): [string, Tone] => {
    if (stale(routes)) return ["unchecked", "warn"];
    if (routeOpen(routes, id)) return ["open", "ok"];
    const bad = main.routes[id]!.legs.map((l) => main.legs[l]!).find((g) => g.status !== "live")!;
    return [bad.status, bad.status === "paused" ? "bad" : "warn"];
  };

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {fundFor && to.trim() === fundFor.address && (
          <Card className="border-accent/30 bg-accent/[0.05] p-4 text-[13px] leading-relaxed text-fg-2">
            Paying the deposit for your new agent <b className="text-fg">{fundFor.agent}</b>. At least <b className="num text-fg">{fundFor.kas} KAS</b> must arrive in <b className="text-fg">one</b> payment; the amount has a margin for the rate moving. Anything over goes into the agent's grant, not to anyone else.
          </Card>
        )}
        {aside && !swap && (
          <Card className="p-4 text-[12.5px] leading-relaxed text-fg-2">The earlier swap ({aside.amount} {aside.token} on {aside.chain}, exchange <b className="num">{aside.id}</b>) is set aside. Nothing had arrived at it; if you did send something, quote that id to ChangeNOW's support.</Card>
        )}

        {swap ? <SwapPanel swap={swap} setSwap={setSwap} wallet={wallet} rpc={rpc} switchChain={switchChain} onChange={() => { setAside(swap); setSwap(null); }} fundFor={fundFor} /> : (
          <Card className="overflow-hidden">
            <div className="p-5 sm:p-6">
              <div className="text-[12.5px] font-medium text-fg-3">You pay</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_130px_170px]">
                <span className="relative block"><span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[18px] text-fg-3">$</span>
                  <input inputMode="decimal" aria-label="Amount" className={cn(inputCls, "num h-12 pl-8 text-[20px] font-semibold")} value={usd} onChange={(e) => { setUsd(e.target.value); changed(); }} /></span>
                <Select value={token} onChange={(v) => { setTok(v); changed(); }} options={src.tokens.map((t) => ({ value: t, label: t }))} className="[&>button]:h-12" />
                <Select value={String(chainI)} onChange={(v) => { setChainI(Number(v)); changed(); }} className="[&>button]:h-12"
                  options={main.sources.map((s, i) => { const h = holdings.rows?.filter((r) => r.chain === s.chain && r.raw! > 0n); return { value: String(i), label: s.chain, hint: h?.length ? h.map((r) => `${money(r.amount!)} ${r.token}`).join(" · ") : undefined }; })} />
              </div>
              <p className="mt-2 text-[12px] text-fg-3">
                {wallet?.family === "evm" ? <>from {wallet.name} · {short(wallet.address, 8, 4)}{wallet.chainId && wallet.chainId !== src.chainId ? ` — your wallet is on ${chainName(wallet.chainId)}, not ${src.chain}` : ""}</>
                  : <>from any wallet on {src.chain} — <a className="text-fg-2 hover:text-accent" href={href("account", "wallet")}>connect one</a> to send in one tap</>}
                {holdings.busy ? " · reading what it holds…" : hold ? hold.err ? ` · ${token} here not read (${hold.err})` : hold.raw! > 0n ? <> · you have {money(hold.amount!)} {token} here <button className="text-accent hover:underline" onClick={() => { setUsd(hold.amount!); changed(); }}>use all</button></> : ` · no ${token} on ${src.chain}` : ""}
              </p>

              <div className="my-4 flex items-center gap-3 text-fg-3"><span className="h-px flex-1 bg-line" /><ArrowDown className="size-4" /><span className="h-px flex-1 bg-line" /></div>

              <div className="text-[12.5px] font-medium text-fg-3">You get</div>
              <div className="num mt-1 text-[34px] font-semibold leading-tight tracking-[-0.03em]">{kasN == null ? "—" : `≈ ${Math.floor(kasN).toLocaleString("en-US")}`}<span className="ml-2 text-[15px] font-medium text-fg-3">KAS</span></div>
              <p className="mt-1 text-[12px] text-fg-3">
                {kasN == null ? (usdN > 0 ? "Waiting for the market price. That's no estimate, not a zero." : "Enter an amount above zero.")
                  : cnKas != null ? "ChangeNOW's own quote for this amount, its fee included. What arrives is what it has when your deposit lands."
                  : `At the market price of $${rate} per KAS (CoinGecko). The swap fills at whatever the venue gives.`}
              </p>

              <div className="mt-5">
                <Field label="Where the KAS lands — a Kaspa mainnet address" error={to.trim() && addrErr ? addrErr : undefined}
                  hint={!to.trim() ? "Checked here in full, because a swap service checks only the prefix and the character set." : "Checks out: a kaspa: mainnet address, checksum verified."}>
                  <input className={cn(inputCls, "num text-[13px]")} value={to} onChange={(e) => { setTo(e.target.value); changed(); }} placeholder="kaspa:qq…" spellCheck={false} autoCapitalize="off" />
                </Field>
              </div>
            </div>

            <div className="border-t border-line p-5 sm:p-6">
              <div className="flex items-baseline justify-between gap-3"><div className="text-[14px] font-semibold">How it gets there</div><div className="truncate text-[12px] text-fg-3">{src.chain} → {route.legs.map((l) => main.legs[l]!.via.split(",")[0]).join(" → ")} → Kaspa</div></div>
              <div role="radiogroup" className="mt-3 space-y-2">
                {ids.map((id) => {
                  const r = main.routes[id]!, [pw, pt] = pillOf(id), on = id === rid;
                  return (
                    <button key={id} role="radio" aria-checked={on} onClick={() => { setPick(id); setCreateErr(null); }}
                      className={cn("w-full rounded-xl border p-3.5 text-left transition", on ? "border-accent/50 bg-accent/[0.05]" : "border-line-strong hover:bg-raised/50")}>
                      <div className="flex items-center justify-between gap-2"><span className="text-[13.5px] font-medium">{r.name}</span><Badge tone={pt} dot>{pw}</Badge></div>
                      <div className="mt-1 text-[12px] leading-snug text-fg-3">{r.custody === "none" ? "No custodian. " : `Custodian: ${r.custody}. `}{r.summary}</div>
                    </button>
                  );
                })}
              </div>
              <ul className="mt-3 space-y-1.5">
                {route.legs.map((l) => { const g = main.legs[l]!; return (
                  <li key={l} className="flex items-start gap-2 text-[12px] text-fg-3"><span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", g.status === "live" ? "bg-ok" : g.status === "paused" ? "bg-bad" : "bg-warn")} />
                    <span><span className="text-fg-2">{g.does[0]!.toUpperCase() + g.does.slice(1)}</span> · {g.via}{g.since ? ` · since ${g.since}` : ""}. {g.why}{g.source?.startsWith("https://") && <> <a className="text-fg-2 hover:text-accent" href={g.source} target="_blank" rel="noopener">Source</a></>}</span></li>
                ); })}
              </ul>
              <p className="mt-2 text-[11.5px] text-fg-3">Route status checked {routes.checkedAt}{stale(routes) ? " — more than two weeks ago, so every step shows as unchecked." : "."}</p>
            </div>

            {!isCn && route.legs.includes("exit") && (
              <IgraPlan usd={usd} rate={rate} to={to} />
            )}

            {isCn && (
              <div className="border-t border-line p-5 sm:p-6">
                {quote ? (
                  <div className="rounded-xl bg-raised p-4 text-[12.5px] leading-relaxed text-fg-2">
                    <div>You send {usd.trim()} {token} on {src.chain}, you receive about <b className="num text-fg">{quote.toAmount != null ? `≈ ${Number(quote.toAmount).toLocaleString("en-US", { maximumFractionDigits: 2 })} KAS` : "—"}</b>.</div>
                    <div className="mt-1 text-fg-3">{below ? `Below ChangeNOW's minimum for this pair, ${quote.min} ${token}. ` : `${quote.says} `}{quote.speed ? `Usually ${quote.speed} minutes. ` : ""}Minimum {quote.min} {token}{quote.max ? `, maximum ${quote.max}` : ""}.</div>
                    <div className="mt-1 text-fg-3">ChangeNOW's fee is inside that rate. Warda's share: {quote.partnerFeePct == null ? <b className="text-warn">not stated</b> : <b className="text-fg">{quote.partnerFeePct}%</b>}.</div>
                    {quote.warning && <div className="mt-1 text-warn">{quote.warning}</div>}
                  </div>
                ) : <p className="flex items-center gap-2 text-[12.5px] text-fg-3"><Loader2 className="size-3.5 animate-spin" /> {q && !q.ok ? q.message : "Getting ChangeNOW's quote…"}</p>}
                <div className="mt-4">
                  <Field label="If the swap can't complete, refund to — your address on this chain" hint="Optional, and strongly recommended. Without it, a failed swap is refunded by writing to ChangeNOW's support."
                    error={refund.trim() && !/^0x[0-9a-fA-F]{40}$/.test(refund.trim()) ? "A refund address is 0x followed by 40 hex characters." : undefined}>
                    <input className={cn(inputCls, "num text-[13px]")} value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="0x…" spellCheck={false} autoCapitalize="off" />
                  </Field>
                </div>
              </div>
            )}

            <div className="border-t border-line bg-bg/40 p-5 sm:p-6">
              {route.custody !== "none" && (
                <label className="mb-4 flex cursor-pointer items-start gap-2.5 text-[13px] text-fg-2">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
                  I understand {route.custody} holds the money until the KAS is sent, and that Warda isn't a party to it.
                </label>
              )}
              {why.length > 0 && <ul className="mb-4 space-y-1">{why.map((w, i) => <li key={i} className="flex items-start gap-2 text-[12.5px] text-fg-3"><CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />{w}</li>)}</ul>}
              {!why.length && isCn && <p className="mb-4 text-[12.5px] text-fg-2">Ready. Creating the swap gives you ChangeNOW's deposit address for exactly this amount; nothing moves until you send to it. It delivers mainnet KAS.</p>}
              <Button variant="primary" size="lg" className="w-full sm:w-auto" disabled={!canGo || busy} onClick={create}>{busy ? <><Loader2 className="size-4 animate-spin" /> Creating the swap…</> : <>Create the swap <ArrowRight className="size-4" /></>}</Button>
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck className="size-4 text-accent" /> Warda's part: none</div>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-2">Warda never holds this money, takes nothing on the crossing beyond the share shown on the quote, and isn't a party to the swap — ChangeNOW is, and it's named above.</p>
        </Card>
        <Card className="p-5">
          <div className="text-[14px] font-semibold">This console is on testnet-10</div>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-2">A swap delivers real, mainnet KAS. Grants here are made on testnet today, where KAS is free.</p>
          <LinkButton size="sm" className="mt-3" href="https://faucet-tn10.kaspanet.io/" target="_blank" rel="noopener">Get testnet KAS <ExternalLink className="size-3.5" /></LinkButton>
        </Card>
        <Card className="p-5">
          <div className="text-[14px] font-semibold">Already hold KAS?</div>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-2">Then there's nothing to cross. Fund an agent straight from your own wallet.</p>
          <LinkButton size="sm" className="mt-3" href={href("new")}>New agent</LinkButton>
        </Card>
      </div>
    </div>
  );
}

/* The route through Igra, as steps. The addresses its venue and bridge need
   are configuration, never remembered — so the plan says what it cannot do
   rather than guessing. */
function IgraPlan({ usd, rate, to }: { usd: string; rate: number | null; to: string }) {
  const [slip, setSlip] = useState("0.5");
  const [out, setOut] = useState<{ plan: any } | { error: string } | null>(null);
  useEffect(() => {
    if (!rate || !(Number(usd) > 0)) { setOut(null); return; }
    let live = true;
    planIgra({ usd, rate, slippagePct: slip, payoutAddress: to.trim() || "kaspatest:qq", source: "CoinGecko" }).then((r) => { if (live) setOut(r as any); });
    return () => { live = false; };
  }, [usd, rate, slip, to]);
  return (
    <div className="border-t border-line p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-[14px] font-semibold">The steps you sign</div>
        <label className="flex items-center gap-2 text-[12.5px] text-fg-3">Slippage
          <input inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} className="num h-7 w-16 rounded-md border border-line-strong bg-bg px-2 text-[12.5px] text-fg focus:border-accent/60 focus:outline-none" />%
        </label>
      </div>
      <p className="mt-1.5 text-[12.5px] text-fg-3">Built by the router this site ships. Every step that moves value is handed to you unsigned; this page cannot sign one and has no way to.</p>
      {!out ? <p className="mt-3 text-[12.5px] text-fg-3">{rate ? "Enter an amount above zero." : "Waiting for the market price."}</p>
        : "error" in out ? <p className="mt-3 text-[12.5px] text-warn">No plan: {out.error}</p> : (
        <>
          <ol className="mt-3 space-y-2">
            {(out.plan.steps ?? []).map((st: any, i: number) => (
              <li key={i} className="rounded-xl border border-line-strong p-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[13px]">{i + 1}. {st.describe}</span>
                  <span className="text-[11.5px] text-fg-3">{ACTION[st.action] ?? st.action}{st.hop ? ` · ${st.hop}` : ""}</span>
                </div>
                {st.blockers?.length ? <div className="mt-1 text-[12px] text-warn">{st.blockers.join(" · ")}</div>
                  : st.missing?.length ? <div className="mt-1 text-[12px] text-warn">needs {st.missing.join(", ")}</div>
                  : <div className="mt-1 text-[12px] text-fg-3">{st.counterparty ? `can be made to go wrong by: ${st.counterparty}` : "no counterparty — consensus refuses every alternative"}</div>}
              </li>
            ))}
          </ol>
          {!out.plan.executable && (
            <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
              Not runnable yet, and this is the honest reason: there is no verified, published deployment of a swap venue and the exit bridge to point this at. The router takes those addresses as configuration and never from memory — an address typed from recall sends money somewhere nobody checked. The steps are real; the addresses they need are the gap.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function SwapPanel({ swap, setSwap, wallet, rpc, switchChain, onChange, fundFor }: {
  swap: Swap; setSwap: (s: Swap | null) => void; wallet: ReturnType<typeof useWallet>["wallet"];
  rpc: (m: string, p: unknown[]) => Promise<any>; switchChain: (id: number) => Promise<void>; onChange: () => void; fundFor: FundFor | null;
}) {
  const [st, setSt] = useState<Status | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [sendSay, setSendSay] = useState<{ bad?: boolean; text: React.ReactNode } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [checked, setChecked] = useState<Date | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/swap?op=status&id=${encodeURIComponent(swap.id)}`);
      const j = await r.json();
      if (!j.ok) { setPollErr(`Could not read the exchange just now (${j.message}). Trying again.`); return; }
      setPollErr(null); setSt(j); setChecked(new Date());
      if (j.status !== swap.last) setSwap({ ...swap, last: j.status });
    } catch { setPollErr("Could not reach the swap service just now. Trying again."); }
  }, [swap, setSwap]);
  useEffect(() => {
    poll();
    if (swap.last && TERMINAL.includes(swap.last)) return;
    const t = setInterval(poll, 15_000);
    return () => clearInterval(t);
  }, [swap.id, swap.last]); // eslint-disable-line react-hooks/exhaustive-deps

  const s = st?.status ?? swap.last ?? "waiting";
  const bad = ["failed", "refunded", "verifying"].includes(s);
  const idx = STEPS.findIndex((x) => x[0] === (s === "new" || s === "expired" ? "waiting" : s));
  const deposit = !["exchanging", "sending", "finished", "failed", "refunded"].includes(s);
  const evm = wallet?.family === "evm";
  const sameChain = evm && wallet!.chainId === swap.chainId;

  const send = async () => {
    if (!wallet || !swap.tokenContract) return;
    try {
      setSendSay({ text: "Asking the token contract for its decimals…" });
      const h = await rpc("eth_call", [{ to: swap.tokenContract, data: "0x313ce567" }, "latest"]);
      const dec = Number(BigInt(h));
      if (!(dec >= 0 && dec <= 36)) throw new Error("the token contract did not report its decimals");
      const n = units(dec, swap.amount);
      if (n == null) throw new Error("the amount could not be read");
      setSendSay({ text: `Confirm in ${wallet.name}: ${swap.amount} ${swap.token} to ${short(swap.payin, 8, 6)}.` });
      const tx: string = await rpc("eth_sendTransaction", [{ from: wallet.address, to: swap.tokenContract, value: "0x0", data: "0xa9059cbb" + word(swap.payin) + word(n.toString(16)) }]);
      setSwap({ ...swap, sentTx: tx });
      setSendSay({ text: <>Sent: <a className="text-accent hover:underline" href={(EVM_TX[swap.network] ?? "#") + tx} target="_blank" rel="noopener">{short(tx, 10, 6)}</a>. ChangeNOW starts once it confirms.</> });
      poll();
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setSendSay({ bad: !/reject|denied/i.test(m) && e?.code !== 4001, text: /reject|denied/i.test(m) || e?.code === 4001 ? "Not sent — you declined, which is always fine." : `Not sent: ${m}` });
    }
  };
  const doSwitch = async () => {
    try { await switchChain(swap.chainId); setSendSay(null); }
    catch (e: any) { setSendSay({ bad: true, text: `The wallet did not switch${e?.code === 4902 ? `: it doesn't have ${swap.chain} yet — add it in the wallet and try again.` : `: ${e?.message ?? e}`}` }); }
  };
  const reset = () => {
    if (!TERMINAL.includes(s) && !confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 6000); return; }
    setSwap(null);
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader title="Your swap" sub={<span className="num">exchange {swap.id}</span>}
        action={unpaid(swap) ? <Button size="sm" variant="ghost" onClick={onChange}>Change amount or network</Button> : <Button size="sm" variant={confirm ? "danger" : "ghost"} onClick={reset}>{confirm ? "Press again to forget it" : "Start a new swap"}</Button>} />
      {confirm && <p className="mx-5 mt-2 text-[12px] text-warn">This forgets exchange {swap.id} in this browser. Write the id down first if you have sent anything.</p>}
      <p className="px-5 pt-3 text-[12.5px] text-fg-3">{swap.amount} {swap.token} on {swap.chain} → ≈ {swap.toAmount ? Number(swap.toAmount).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"} KAS to {short(swap.to, 10, 6)}. Created {ago(swap.created)}.</p>

      {deposit && (
        <div className="m-5 rounded-xl border border-line-strong bg-bg p-5">
          <div className="text-[12.5px] text-fg-3">Send exactly</div>
          <div className="num mt-1 text-[26px] font-semibold tracking-[-0.03em]">{swap.amount} <span className="text-[14px] text-fg-3">{swap.token} on {swap.chain}</span></div>
          <div className="mt-4 text-[12.5px] text-fg-3">to ChangeNOW's deposit address</div>
          <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2">
            <span className="num min-w-0 flex-1 break-all text-[12.5px]">{swap.payin}{swap.extraId ? `  ·  memo ${swap.extraId}` : ""}</span>
            <button className="grid size-8 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-raised hover:text-fg" aria-label="Copy the address" onClick={() => navigator.clipboard?.writeText(swap.payin).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })}>{copied ? <Check className="size-4 text-ok" /> : <CopyIco className="size-4" />}</button>
          </div>
          <p className="mt-2 text-[12px] text-fg-3">Only {swap.token} on {swap.chain}, and only this amount. Anything else sent here isn't converted, and getting it back goes through ChangeNOW's support with the exchange id.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {evm && sameChain && swap.tokenContract && !swap.sentTx && <Button variant="primary" onClick={send}><Send className="size-4" /> Send from {wallet!.name}</Button>}
            {evm && !sameChain && <Button onClick={doSwitch}>Switch {wallet!.name} to {swap.chain}</Button>}
            {!evm && <LinkButton href={href("account", "wallet")}>Connect a wallet to send in one tap</LinkButton>}
          </div>
          {sendSay && <p className={cn("mt-3 text-[12.5px]", sendSay.bad ? "text-bad" : "text-fg-2")}>{sendSay.text}</p>}
        </div>
      )}

      <ol className="space-y-0 px-5 pb-2">
        {STEPS.map(([k, label], i) => {
          const done = !bad && (i < idx || s === "finished"), now = !bad && i === idx && s !== "finished", fail = bad && i === 0;
          return (
            <li key={k} className="flex items-center gap-3 py-2">
              <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[11px] ring-1", done ? "bg-accent text-accent-ink ring-accent" : now ? "bg-accent/15 text-accent ring-accent/50" : fail ? "bg-bad/15 text-bad ring-bad/40" : "text-fg-3 ring-line-strong")}>
                {done ? <Check className="size-3.5" strokeWidth={3} /> : now ? <Loader2 className="size-3 animate-spin" /> : i + 1}
              </span>
              <span className={cn("text-[13px]", done || now ? "text-fg" : fail ? "text-bad" : "text-fg-3")}>
                {fail ? st?.says ?? s : label}
                {k === "confirming" && st?.from.hash && EVM_TX[swap.network] && <> · <a className="text-fg-3 hover:text-accent" href={EVM_TX[swap.network] + st.from.hash} target="_blank" rel="noopener">your deposit</a></>}
                {k === "finished" && st?.to.hash && <> · <a className="text-fg-3 hover:text-accent" href={`https://explorer.kaspa.org/txs/${st.to.hash}`} target="_blank" rel="noopener">the KAS payment</a></>}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="border-t border-line px-5 py-3 text-[12px] text-fg-3">
        {pollErr ?? (!st ? "Reading the exchange…" : s === "finished" ? `${st.to.sent != null ? `${Number(st.to.sent).toLocaleString("en-US", { maximumFractionDigits: 4 })} KAS sent to ${short(st.to.address, 10, 6)}. ` : ""}Updated ${ago(st.updatedAt)}.`
          : bad ? `ChangeNOW reports: ${st.says || s}. Quote exchange ${swap.id} to its support.${st.refundHash ? ` Refund transaction ${st.refundHash}.` : ""}`
          : `Checked ${checked?.toLocaleTimeString("en-US") ?? ""} · ChangeNOW says: ${st.says || s}. This page checks every 15 seconds while it's open.`)}
      </p>
      {s === "finished" && (
        <div className="border-t border-line p-5">
          {fundFor && swap.to === fundFor.address
            ? <LinkButton variant="primary" href={href("agents", `h:${fundFor.agent}`)}>Open {fundFor.agent} <ArrowRight className="size-4" /></LinkButton>
            : <LinkButton variant="primary" href="#/create">Create a grant with this KAS <ArrowRight className="size-4" /></LinkButton>}
        </div>
      )}
    </Card>
  );
}
