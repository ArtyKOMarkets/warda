import { useEffect, useMemo, useState } from "react";
import { Check, Copy as CopyIco, KeyRound, Terminal, Coins, TrendingDown, Hourglass, Activity } from "lucide-react";
import { useWallet } from "@/lib/connect";
import { accountApi, ownKey, toSompi, kasOfSompi, useAccount, useMarket } from "@/lib/account";
import { isAddress } from "@/lib/kaspa";
import { href } from "@/lib/router";
import { cn } from "@/lib/cn";
import { Button, Card, CardHeader, LinkButton, Row } from "@/components/ui";
import { Field, Select, inputCls } from "@/components/form";
import { RuleList } from "@/components/session-ui";

type Kind = "balance-at-or-above" | "budget-low" | "expiring" | "spending-anomaly";
const KINDS: { k: Kind; title: string; sub: string; icon: typeof Coins }[] = [
  { k: "balance-at-or-above", title: "Money arrived", sub: "an address has received enough to act on", icon: Coins },
  { k: "budget-low", title: "Running out", sub: "a grant is close to the end of its budget", icon: TrendingDown },
  { k: "expiring", title: "Nearly over", sub: "a grant's term is nearly up", icon: Hourglass },
  { k: "spending-anomaly", title: "Spending spike", sub: "a grant spends far faster than usual", icon: Activity },
];
const SAY: Record<Kind, string> = {
  "balance-at-or-above": "Fires when the coins at an address add up to your figure or more. It tells you the takings are worth doing something about, and then you decide what.",
  "budget-low": "Fires when what the grant can still pay drops to your figure — the smaller of the authority left in the covenant and the coin actually there. Either alone can call an agent healthy when it can't pay for anything.",
  expiring: "Fires when the term is nearly up. A grant past it refuses every spend whatever its budget says, so this is the one that ends an agent with money still in it.",
  "spending-anomaly": "Fires when a grant spends much faster in the last 24 hours than it usually does. It doesn't stop anything — the covenant's limits do that — it tells you something changed while it's still small.",
};
const ID0: Record<Kind, string> = { "balance-at-or-above": "earnings-worth-converting", "budget-low": "agent-running-low", expiring: "grant-term-ending", "spending-anomaly": "spending-spike" };
const NOTE0: Record<Kind, string> = { "balance-at-or-above": "Convert, and top the agent back up.", "budget-low": "Issue the successor before it stops: warda topup", expiring: "Reclaim what is left, or issue the successor.", "spending-anomaly": "Check what the agent is buying. Revoke it if that is not what you meant." };

export function AlertRules({ watch }: { watch?: string }) {
  const { wallet } = useWallet();
  const { up, me, own, reload } = useAccount();
  const mk = useMarket();
  const rate = mk && "rate" in mk ? mk.rate : null;
  const [kind, setKind] = useState<Kind>("balance-at-or-above");
  const [id, setId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [addr, setAddr] = useState(watch ?? (wallet?.family === "kaspa" ? wallet.address : ""));
  const [usd, setUsd] = useState("50");
  const [below, setBelow] = useState("2");
  const [days, setDays] = useState("2");
  const [factor, setFactor] = useState("2");
  const [path, setPath] = useState("grant.json");
  const [funder, setFunder] = useState("");
  useEffect(() => { if (!addr && !watch && wallet?.family === "kaspa") setAddr(wallet.address); }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps
  const synced = own.filter((x) => !x.local);
  const [gkey, setGkey] = useState<string>("");
  const gk = synced.some((x) => ownKey(x.m) === gkey) ? gkey : synced[0] ? ownKey(synced[0].m) : "";
  const [say, setSay] = useState<{ bad?: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [local, setLocal] = useState(false);

  const idV = id ?? ID0[kind], noteV = note ?? NOTE0[kind];
  const atOrAbove = toSompi(usd, rate), belowS = toSompi(below, rate);
  const blocks = parseFloat(days) > 0 ? Math.round(parseFloat(days) * 24 * 60 * 60 * 10) : null;
  const addrOk = isAddress(addr.trim(), "kaspatest") || isAddress(addr.trim(), "kaspa");

  // What "Save to my account" sends. The server only checks the kind, so every field is checked here.
  const serverRule = useMemo(() => {
    const r: Record<string, any> = { kind };
    if (noteV.trim()) r.note = noteV.trim();
    if (kind === "balance-at-or-above") {
      if (atOrAbove == null || !addrOk) return null;
      return { ...r, address: addr.trim(), atOrAbove: String(atOrAbove) };
    }
    const x = synced.find((o) => ownKey(o.m) === gk); if (!x) return null;
    r.grantKey = gk; r.network = "testnet-10";
    if (kind === "budget-low") r.below = String(belowS ?? x.m.max_per_spend);
    if (kind === "expiring") { const d = parseFloat(days); if (!(d > 0)) return null; r.days = d; }
    if (kind === "spending-anomaly") { const f = parseFloat(factor); if (!(f > 1)) return null; r.factor = f; }
    return r;
  }, [kind, noteV, atOrAbove, addr, addrOk, gk, synced, belowS, days, factor]);

  // What ops/alerts.json on your own machine reads.
  const localRule = useMemo(() => {
    const r: Record<string, any> = { id: idV.trim() || "unnamed", kind };
    if (kind === "balance-at-or-above") {
      r.address = addr.trim() || "kaspatest:…"; r.atOrAbove = atOrAbove == null ? null : String(atOrAbove);
      if (atOrAbove != null && rate) r.quote = { amount: String(parseFloat(usd)), asset: "USD", perKas: String(rate), source: `CoinGecko, ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}` };
    } else if (kind === "budget-low") { r.grant = path; if (belowS != null) r.below = String(belowS); if (funder.trim()) r.funder = funder.trim(); }
    else if (kind === "expiring") { r.grant = path; if (blocks) r.within = blocks; }
    else r.factor = parseFloat(factor) || 2;
    if (noteV.trim()) r.note = noteV.trim();
    return r;
  }, [idV, kind, addr, atOrAbove, rate, usd, path, belowS, funder, blocks, factor, noteV]);
  const json = JSON.stringify(localRule, null, 2);

  const save = async () => {
    if (!serverRule) return;
    setBusy(true);
    const rid = (idV.trim() || kind).replace(/[^\w.:-]/g, "-").slice(0, 128);
    const j = await accountApi("rule", { id: rid, rule: serverRule });
    setSay(j.ok ? { text: `Saved as "${rid}". The console checks it every 15 minutes and messages you only when it changes.` } : { bad: true, text: j.message || "Not saved." });
    if (j.ok) await reload();
    setBusy(false);
  };

  const missing = kind === "balance-at-or-above"
    ? !addrOk ? "Needs a Kaspa address to watch." : atOrAbove == null ? "Needs the market price to turn dollars into KAS." : null
    : !synced.length ? "Needs a grant you track, synced to your account." : null;

  const against = kind === "balance-at-or-above" ? (atOrAbove != null ? `${kasOfSompi(atOrAbove)} KAS` : "—")
    : kind === "budget-low" ? (belowS != null ? `${kasOfSompi(belowS)} KAS` : "the grant's own per-payment cap")
    : kind === "expiring" ? (blocks ? `${parseFloat(days)} days (${blocks.toLocaleString("en-US")} blocks)` : "—") : `${parseFloat(factor) || 2}× its usual day`;
  const measured = { "balance-at-or-above": "what the address holds", "budget-low": "the smaller of authority left and coin held", expiring: "time left in the term", "spending-anomaly": "KAS spent in the last 24 hours" }[kind];

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card className="p-5">
          <div className="text-[15px] font-semibold">What to watch</div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {KINDS.map((x) => (
              <button key={x.k} type="button" aria-pressed={kind === x.k} onClick={() => { setKind(x.k); setSay(null); }}
                className={cn("flex items-start gap-3 rounded-xl border p-3.5 text-left transition", kind === x.k ? "border-accent/50 bg-accent/[0.06]" : "border-line-strong hover:border-fg-3/50 hover:bg-raised/50")}>
                <x.icon className={cn("mt-0.5 size-4 shrink-0", kind === x.k ? "text-accent" : "text-fg-3")} />
                <span><span className="block text-[13.5px] font-medium">{x.title}</span><span className="block text-[12px] text-fg-3">{x.sub}</span></span>
              </button>
            ))}
          </div>
          <p className="mt-4 text-[12.5px] leading-relaxed text-fg-2">{SAY[kind]}</p>

          <div className="mt-5 grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
            {kind === "balance-at-or-above" ? (
              <>
                <Field label="The address to watch" className="sm:col-span-2" hint="A public address and nothing else — this rule can't spend from it, and what checks it holds no key."
                  error={addr.trim() && !addrOk ? "That isn't a valid Kaspa address." : undefined}>
                  <input className={cn(inputCls, "num text-[13px]")} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="kaspatest:qq…" spellCheck={false} autoCapitalize="off" />
                </Field>
                <Field label="Tell me when it reaches" hint={rate ? `at the market price, $${rate} per KAS` : "Waiting for the market price."}>
                  <span className="relative block"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">$</span><input inputMode="decimal" className={cn(inputCls, "num pl-7")} value={usd} onChange={(e) => setUsd(e.target.value)} /></span>
                </Field>
                <Field label="Which is" hint="the figure stored — the dollars are only a note"><div className={cn(inputCls, "num flex items-center text-fg-2")}>{atOrAbove != null ? `${kasOfSompi(atOrAbove)} KAS` : "—"}</div></Field>
              </>
            ) : (
              <>
                <Field label="The grant" className="sm:col-span-2" hint={synced.length ? "One of your tracked grants, synced to your account." : undefined}>
                  {synced.length ? <Select value={gk} onChange={setGkey} options={synced.map((x) => ({ value: ownKey(x.m), label: `Grant ${String(x.m.covenant_id || ownKey(x.m)).slice(0, 10)}…` }))} />
                    : <div className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-[13px] text-fg-3">No tracked grant yet. <a className="text-fg-2 hover:text-accent" href={href("account", "grants")}>Add its grant.json</a> under Account, signed in.</div>}
                </Field>
                {kind === "budget-low" && <Field label="Warn me below" hint={belowS != null ? `= ${kasOfSompi(belowS)} KAS left` : rate ? "Blank: the grant's own per-payment cap." : "Waiting for the market price."}>
                  <span className="relative block"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">$</span><input inputMode="decimal" className={cn(inputCls, "num pl-7")} value={below} onChange={(e) => setBelow(e.target.value)} /></span></Field>}
                {kind === "expiring" && <Field label="Warn me this long before the end" hint={blocks ? `= ${blocks.toLocaleString("en-US")} blocks, at ten a second` : undefined}>
                  <span className="relative block"><input inputMode="decimal" className={cn(inputCls, "num pr-14")} value={days} onChange={(e) => setDays(e.target.value)} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-fg-3">days</span></span></Field>}
                {kind === "spending-anomaly" && <Field label="When the last 24 hours is this many times the usual day" hint="“Usual” is the grant's own week before, from hourly readings. It needs three days of them and says nothing rather than guess.">
                  <span className="relative block"><input inputMode="decimal" className={cn(inputCls, "num pr-10")} value={factor} onChange={(e) => setFactor(e.target.value)} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-fg-3">×</span></span></Field>}
              </>
            )}
            <Field label="Name it" hint="How the rule is remembered between runs."><input className={cn(inputCls, "num text-[13px]")} value={idV} onChange={(e) => setId(e.target.value)} /></Field>
            <Field label="Remind me to" hint="Sent at the top of the message. Yours, not generated."><input className={inputCls} value={noteV} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>

          <div className="mt-5 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className={cn("text-[12.5px]", say?.bad ? "text-bad" : say ? "text-ok" : "text-fg-3")}>
              {say?.text ?? (up === false ? "Accounts aren't set up on this site, so rules run on your own machine only."
                : !me ? "Sign in under Account and the console runs this rule for you, every 15 minutes."
                : missing ?? "The console checks it every 15 minutes and messages you only when it changes.")}
            </p>
            <div className="flex shrink-0 gap-2">
              {!me && up !== false && <LinkButton size="sm" href={href("account", "console")}><KeyRound className="size-3.5" /> Sign in</LinkButton>}
              <Button variant="primary" disabled={!me || !serverRule || busy} onClick={save}><Check className="size-4" /> Save to my account</Button>
            </div>
          </div>
        </Card>

        <Card>
          <button className="flex w-full items-center justify-between gap-3 p-5 text-left" onClick={() => setLocal(!local)} aria-expanded={local}>
            <span className="flex items-center gap-2 text-[14px] font-semibold"><Terminal className="size-4 text-fg-3" /> Or run it on your own machine</span>
            <span className="text-[12.5px] text-fg-3">{local ? "Hide" : "Show"}</span>
          </button>
          {local && (
            <div className="rise space-y-4 border-t border-line p-5">
              {(kind === "budget-low" || kind === "expiring") && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="The grant's manifest, as your machine sees it" hint="A path, relative to the repository."><input className={cn(inputCls, "num text-[13px]")} value={path} onChange={(e) => setPath(e.target.value)} /></Field>
                  {kind === "budget-low" && <Field label="Your funding address — optional" hint="Then the message also says whether the next grant can be paid for."><input className={cn(inputCls, "num text-[13px]")} value={funder} onChange={(e) => setFunder(e.target.value)} placeholder="kaspatest:qq…" /></Field>}
                </div>
              )}
              {kind === "spending-anomaly" && <p className="rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-warn">Runs in your console account only: it needs the hourly history the account keeps. The script on your machine doesn't evaluate this kind.</p>}
              <div>
                <div className="mb-2 text-[12.5px] text-fg-2">Add this to <span className="num">ops/alerts.json</span> beside your node. That file is gitignored: a published threshold is a number somebody knows to sit just underneath.</div>
                <div className="relative rounded-lg border border-line-strong bg-bg">
                  <pre className="num overflow-x-auto p-3 pr-12 text-[12px] leading-relaxed text-fg-2">{json}</pre>
                  <button className="absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-md text-fg-3 hover:bg-raised hover:text-fg" aria-label="Copy the rule"
                    onClick={() => navigator.clipboard?.writeText(json).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? <Check className="size-4 text-ok" /> : <CopyIco className="size-4" />}</button>
                </div>
              </div>
              <div className="text-[12.5px] leading-relaxed text-fg-2">
                <p>Once, on the machine that runs your node: make a bot with <b>@BotFather</b>, send it any message, put its token and your chat id in <span className="num">ops/alerts.env</span>, then:</p>
                <pre className="num mt-2 overflow-x-auto rounded-lg border border-line-strong bg-bg p-3 text-[12px] text-fg-2">{"cp ops/alerts.env.example ops/alerts.env\nops/alerts.sh --test\nops/alerts.sh --dry-run\nops/install-cron.sh"}</pre>
                <p className="mt-2 text-fg-3">It notifies. It never acts: it holds no key, signs nothing and builds no transaction.</p>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card className="p-5">
          <div className="text-[13px] text-fg-3">What the rule compares</div>
          <dl className="mt-2 divide-y divide-line">
            <Row label="Measured">{measured}</Row>
            <Row label="Against"><span className="num">{against}</span></Row>
            <Row label="Read from">the chain, every 15 min</Row>
          </dl>
          <p className="mt-3 text-[12px] leading-relaxed text-fg-3">
            {kind === "balance-at-or-above" ? `The dollar figure is a note, not a comparison. If KAS moves, it keeps firing at ${atOrAbove != null ? kasOfSompi(atOrAbove) : "that"} KAS.`
              : kind === "expiring" ? "The covenant compares network time, so the rule does too."
              : kind === "budget-low" ? "Left blank, it warns below the grant's own per-payment cap — under that it can't make a payment of the size it was authorised for."
              : "Only changes are sent, including the change back."}
          </p>
          <p className="mt-2 text-[12px] text-fg-3">{mk && "rate" in mk ? `Market price $${mk.rate} per KAS (CoinGecko, ${mk.at}) — nothing is enforced against it.` : mk ? `Market price ${mk.error}` : "Reading the market price…"}</p>
        </Card>
        {me && (
          <Card>
            <CardHeader title="Rules this account runs" sub={me.telegramChatId ? "Messages go to your Telegram" : <>Connect Telegram under <a className="text-fg-2 hover:text-accent" href={href("account", "console")}>Account</a> to get them</>} />
            <div className="p-5 pt-4"><RuleList me={me} reload={reload} empty={<p className="text-[13px] text-fg-3">None yet. Build one here and save it.</p>} /></div>
          </Card>
        )}
      </div>
    </div>
  );
}
