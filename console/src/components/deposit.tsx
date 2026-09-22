import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Copy as CopyIcon, ExternalLink, Loader2, QrCode, Send, Sparkles, Undo2 } from "lucide-react";
import { api, type RunnerConfig } from "@/lib/runner";
import { explorerTx } from "@/lib/kaspa";
import { hasKasware, kaswareSend, qrSvg } from "@/lib/wallet";
import { Button, Card, LinkButton } from "./ui";
import { cn } from "@/lib/cn";

export interface Funding {
  status: string; address: string; amountKas: string; uri: string;
  seenKas?: string; note?: string; genesisTxid?: string;
}

/** A deposit address the runner turns into a grant, watched until it does. */
export function DepositPanel({ runner, agent, initial, onFunded, kind = "create" }: {
  runner: RunnerConfig; agent: string; initial: Funding; onFunded?: (f: Funding) => void; kind?: "create" | "topup";
}) {
  const [f, setF] = useState<Funding>(initial);
  const [svg, setSvg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ bad?: boolean; text: string } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const done = useRef(false);
  const test = f.address.startsWith("kaspatest:");

  useEffect(() => { qrSvg(f.uri).then(setSvg).catch(() => setSvg(null)); }, [f.uri]);

  useEffect(() => {
    if (f.status === "funded" || f.status === "refunded") return;
    const t = setInterval(async () => {
      try {
        const a = await api<{ funding: Funding | null }>(runner, "GET", `/v1/agents/${encodeURIComponent(agent)}`);
        if (!a.funding) return;
        setF(a.funding);
        if (a.funding.status === "funded" && !done.current) { done.current = true; onFunded?.(a.funding); }
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(t);
  }, [agent, runner, f.status, onFunded]);

  const send = async () => {
    setSending(true); setMsg(null);
    try {
      const tx = await kaswareSend(f.address, f.amountKas);
      setMsg({ text: tx ? `Sent. Waiting for the network (${tx.slice(0, 10)}…).` : "Sent. Waiting for the network." });
    } catch (e) {
      setMsg({ bad: true, text: (e as Error).message || "KasWare did not send it." });
    } finally { setSending(false); }
  };

  const cancel = async () => {
    if (!confirmCancel) { setConfirmCancel(true); return; }
    try {
      await api(runner, "POST", `/v1/agents/${encodeURIComponent(agent)}/refund`, {});
      setF({ ...f, status: "refunded" });
    } catch (e) {
      const m = (e as Error).message;
      setMsg({ bad: !/nothing to refund/.test(m), text: /nothing to refund/.test(m) ? "Nothing has been sent to it — just don't send. It stays unused." : m });
    }
    setConfirmCancel(false);
  };

  if (f.status === "funded") {
    return (
      <Card className="relative overflow-hidden p-8 text-center">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-48 w-96 rounded-full bg-accent/15 blur-3xl" />
        <div className="relative mx-auto grid size-14 place-items-center rounded-2xl bg-accent/15 ring-1 ring-accent/30"><Sparkles className="size-6 text-accent" /></div>
        <h2 className="relative mt-5 text-[22px] font-semibold tracking-[-0.02em]">{kind === "topup" ? "Topped up" : `${agent} is live`}</h2>
        <p className="relative mx-auto mt-2 max-w-md text-[14px] leading-relaxed text-fg-2">
          {kind === "topup" ? "The agent has moved to its new grant. Same jobs, same payees." : "The grant exists on Kaspa, and every limit you set is now enforced by the network."}
        </p>
        {f.genesisTxid && <a href={explorerTx(f.genesisTxid, test ? "testnet-10" : "mainnet")} target="_blank" rel="noopener" className="relative mt-4 inline-flex items-center gap-1 text-[13px] text-fg-3 hover:text-accent">The transaction that created it <ExternalLink className="size-3.5" /></a>}
      </Card>
    );
  }
  if (f.status === "refunded") {
    return <Card className="p-6"><div className="flex items-center gap-2 text-[15px] font-semibold"><Undo2 className="size-4 text-fg-2" /> Cancelled</div><p className="mt-2 text-[13.5px] text-fg-2">Anything sent was returned to your key. Nothing was created.</p></Card>;
  }

  const arrived = f.status === "submitting";
  const seen = f.seenKas && f.seenKas !== "0" ? f.seenKas : null;
  return (
    <Card className="overflow-hidden">
      <div className="grid gap-0 md:grid-cols-[1fr_260px]">
        <div className="p-6">
          <div className="text-[13px] text-fg-3">Send exactly</div>
          <div className="num mt-1 text-[40px] font-semibold leading-none tracking-[-0.04em]">{f.amountKas}<span className="ml-2 text-[16px] font-medium text-fg-3">KAS</span></div>
          <p className="mt-2 text-[13px] text-fg-3">In one payment. It covers the budget and the network fees its payments will need.</p>

          <div className="mt-6 text-[12px] text-fg-3">To this deposit address</div>
          <div className="mt-1.5 flex items-center gap-2 rounded-xl border border-line-strong bg-bg px-3 py-2.5">
            <span className="num min-w-0 flex-1 break-all text-[12.5px] leading-relaxed text-fg">{f.address}</span>
            <button className="grid size-8 shrink-0 place-items-center rounded-lg text-fg-3 hover:bg-raised hover:text-fg" aria-label="Copy address"
              onClick={() => navigator.clipboard?.writeText(f.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })}>
              {copied ? <Check className="size-4 text-ok" /> : <CopyIcon className="size-4" />}
            </button>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {hasKasware() && <Button variant="primary" onClick={send} disabled={sending || arrived}>{sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send with KasWare</Button>}
            <LinkButton href={f.uri} variant={hasKasware() ? "secondary" : "primary"}>Open in wallet</LinkButton>
            {test && <LinkButton href="https://faucet-tn10.kaspanet.io/" target="_blank" rel="noopener" variant="ghost">Get testnet KAS <ExternalLink className="size-3.5" /></LinkButton>}
          </div>

          <div className={cn("mt-6 flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px]", msg?.bad ? "bg-bad/10 text-bad" : "bg-raised text-fg-2")}>
            {msg?.bad ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-accent" />}
            <span>{msg?.text ?? (arrived ? "Payment arrived. Creating the grant…" : `${seen ? `Seen ${seen} KAS so far. ` : ""}${f.note && seen ? f.note : "Waiting for your payment…"}`)}</span>
          </div>
          {test && <p className="mt-3 text-[12px] text-fg-3">This runner is on testnet-10, so this is test KAS. USDC and USDT funding opens on mainnet.</p>}
        </div>
        <div className="flex flex-col items-center justify-center gap-3 border-t border-line bg-bg/40 p-6 md:border-l md:border-t-0">
          {svg ? <div className="rounded-xl bg-white p-3 [&_svg]:size-[184px]" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="grid size-[208px] place-items-center rounded-xl border border-dashed border-line-strong text-fg-3"><QrCode className="size-8" /></div>}
          <span className="text-[12px] text-fg-3">Scan with a Kaspa wallet</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-3.5 text-[12.5px] text-fg-3">
        <span>No grant exists until it arrives. Cancel sends back anything already received.</span>
        <button onClick={cancel} className={cn("shrink-0 transition hover:text-fg", confirmCancel && "text-bad hover:text-bad")}>{confirmCancel ? "Press again to cancel" : "Cancel"}</button>
      </div>
    </Card>
  );
}
