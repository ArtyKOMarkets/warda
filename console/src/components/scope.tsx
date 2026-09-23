import { AlertTriangle, ArrowRight, Eye, Ban, Clock, Receipt, Wallet } from "lucide-react";
import { useData } from "@/lib/data";
import { spendable, type AgentView } from "@/lib/model";
import { useWallet } from "@/lib/connect";
import { href } from "@/lib/router";
import { kas, ago } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button, Card, LinkButton } from "./ui";

/* Whose agents you are looking at. Warda's own agents are public examples,
   and looking at them is a visit rather than a setting: it is not remembered,
   and the counts and totals everywhere else are yours. */
export function ScopeBanner() {
  const { scope, yours, setScope, agents } = useData();
  const { wallet } = useWallet();
  const { runner } = useData();
  if (scope !== "warda") return null;
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-[var(--radius-card)] border border-info/25 bg-info/[0.06] p-4 sm:flex-row sm:items-center">
      <Eye className="size-4 shrink-0 text-info" />
      <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-fg-2">
        {yours ? <>Showing Warda's own agents — public examples, not yours.</>
          : <>These {agents.length} agents are Warda's own, published as public examples. {wallet ? "No published grant names your key yet." : "Connect your wallet"}{!wallet && " to see the grants it holds"}{runner.key ? "" : ", or sign in to the runner for agents it hosts for you"}.</>}
      </p>
      <div className="flex shrink-0 gap-2">
        {yours ? <Button size="sm" onClick={() => setScope("mine")}>Back to yours</Button> : (
          <>
            {!wallet && <LinkButton size="sm" variant="primary" href={href("account", "wallet")}><Wallet className="size-3.5" /> Connect a wallet</LinkButton>}
            {!runner.key && <LinkButton size="sm" href={href("account", "runner")}>Sign in to the runner</LinkButton>}
          </>
        )}
      </div>
    </div>
  );
}

export function ScopeSwitch({ className }: { className?: string }) {
  const { scope, yours, setScope } = useData();
  if (!yours) return null;
  return (
    <div className={cn("flex rounded-lg border border-line-strong bg-surface p-0.5", className)}>
      {([["mine", "Yours"], ["warda", "Warda's agents"]] as const).map(([v, l]) => (
        <button key={v} onClick={() => setScope(v)} className={cn("h-7 rounded-md px-2.5 text-[12.5px] font-medium transition", scope === v ? "bg-raised text-fg" : "text-fg-3 hover:text-fg-2")}>{l}</button>
      ))}
    </div>
  );
}

/* Warnings nobody has to look for, each derived from a reading. */
export interface Notice { tone: "warn" | "bad"; icon: typeof Ban; title: string; say: string; to?: string }
export function noticesOf(agents: AgentView[], readAt: string | null, missing: number): Notice[] {
  const out: Notice[] = [];
  for (const a of agents) {
    if (a.status === "ended") continue;
    const can = spendable(a), name = a.source === "hosted" ? a.label : `Agent ${a.label}`;
    if (a.expired && (a.remaining ?? 0) > 0)
      out.push({ tone: "warn", icon: Clock, title: `${name}'s term is over`, say: `${kas(a.remaining)} KAS is still in it. Only its principal key can reclaim that.`, to: href("agents", a.key) });
    else if (can !== null && a.maxPerPayment !== null && can <= a.maxPerPayment)
      out.push({ tone: "warn", icon: Ban, title: `${name} cannot make a full payment`, say: `It can pay ${kas(can)} KAS and its cap is ${kas(a.maxPerPayment)} KAS. Top it up, or it stops mid-job.`, to: href("agents", a.key) });
    else if (!a.expired && /^(\d+(\.\d+)?)\s*(hour|hours|day|days)$/.test(a.expiresIn ?? "") && /hour|^1 day|^2 days/.test(a.expiresIn!))
      out.push({ tone: "warn", icon: Clock, title: `${name}'s term ends in ${a.expiresIn}`, say: "After that it refuses every spend, whatever its budget says.", to: href("agents", a.key) });
    if (a.reconciliation?.unrecorded && a.reconciliation.unrecorded > 0)
      out.push({ tone: "warn", icon: Receipt, title: `${name} has spending with no receipt`, say: `The covenant says ${kas(a.reconciliation.spent)} KAS was spent; its own log names ${kas(a.reconciliation.logged)} KAS.`, to: href("agents", a.key, "payments") });
    if (a.paidOutside && a.paidOutside > 0)
      out.push({ tone: "bad", icon: AlertTriangle, title: `${name} paid outside its allowlist`, say: `${kas(a.paidOutside)} KAS. That should not be possible — read it before anything else.`, to: href("agents", a.key, "proof") });
  }
  if (missing) out.push({ tone: "bad", icon: AlertTriangle, title: `${missing} reading${missing === 1 ? "" : "s"} did not load`, say: "What is missing is not the same as nothing there. Refresh, or come back." });
  else if (readAt && Date.now() - new Date(readAt).getTime() > 2 * 86_400_000)
    out.push({ tone: "warn", icon: Clock, title: "These readings are stale", say: `The chain was last read ${ago(readAt)}.` });
  return out;
}

export function Notices({ className }: { className?: string }) {
  const { agents, readAt, missing } = useData();
  const list = noticesOf(agents, readAt, missing);
  if (!list.length) return null;
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", className)}>
      {list.slice(0, 4).map((n, i) => (
        <Card key={i} className={cn("p-4", n.tone === "bad" ? "border-bad/30 bg-bad/[0.05]" : "border-warn/25 bg-warn/[0.04]")}>
          <div className="flex items-start gap-2.5">
            <n.icon className={cn("mt-0.5 size-4 shrink-0", n.tone === "bad" ? "text-bad" : "text-warn")} />
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium">{n.title}</div>
              <div className="mt-0.5 text-[12.5px] leading-snug text-fg-3">{n.say}</div>
              {n.to && <a href={n.to} className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] text-fg-2 hover:text-accent">Look <ArrowRight className="size-3.5" /></a>}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
