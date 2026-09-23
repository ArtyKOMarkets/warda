import { useState } from "react";
import { FileKey2 } from "lucide-react";
import { useData, agentHit } from "@/lib/data";
import { useAccount, ownKey } from "@/lib/account";
import { kas, short } from "@/lib/format";
import { explorerAddress } from "@/lib/kaspa";
import { href, go } from "@/lib/router";
import { hasGrant, shortOfCoin } from "@/lib/model";
import { AgentMark } from "@/components/agent";
import { Badge, Card, Copy, Empty, Kas, LinkButton, PageHeader, Skeleton, StatusBadge, Tabs } from "@/components/ui";
import { ScopeBanner } from "@/components/scope";
import { cn } from "@/lib/cn";
import { agentName } from "./shared";

export function Grants() {
  const { agents, loading, filter } = useData();
  const { own, readings } = useAccount();
  const [f, setF] = useState<"live" | "ended" | "all">("live");
  const isLive = (s: string) => s !== "ended" && s !== "expired";
  /* The base the tabs describe: agents that HAVE a grant and match the
     filter. The tab counts used to be taken from `agents` itself, so on any
     filter — or any agent without a grant — the labels counted a larger set
     than the rows beneath them. */
  const held = agents.filter((a) => hasGrant(a) && agentHit(a, filter));
  const list = held.filter((a) => f === "all" || (f === "live") === isLive(a.status));

  return (
    <>
      <ScopeBanner />
      <PageHeader title="Grants" sub="A grant is the on-chain contract that holds an agent's money and its rules. Its terms can't be edited — only ended."
        actions={<LinkButton href={href("create")}>Create a grant</LinkButton>} />

      <Tabs className="mb-5" value={f} onChange={setF} items={[
        { value: "live", label: "Live", count: held.filter((a) => isLive(a.status)).length },
        { value: "ended", label: "Ended", count: held.filter((a) => !isLive(a.status)).length },
        { value: "all", label: "All", count: held.length },
      ]} />

      <Card className="overflow-hidden">
        {loading && !agents.length ? <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div> : !list.length ? (
          <Empty icon={<FileKey2 className="size-5" />} title={filter ? "No grant matches" : "No grants here"}>{filter ? "Clear the filter to see them all." : "Create an agent and its grant is made for you."}</Empty>
        ) : (<>
          {/* One card per grant on a phone: the same figures, stacked. */}
          <ul className="divide-y divide-line lg:hidden">
            {list.map((a) => (
              <li key={a.key}>
                <a href={href("agents", a.key, "proof")} className="block px-4 py-4 transition active:bg-raised/60">
                  <div className="flex items-start gap-3">
                    <AgentMark agent={a} size={28} className="rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium">{agentName(a)}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <div className="num mt-1 truncate text-[12px] text-fg-3">{a.grantAddress ? short(a.grantAddress, 14, 6) : "Not funded yet"}</div>
                    </div>
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-y-3 text-[12px]">
                    <div><dt className="text-fg-3">Budget</dt><dd className="num mt-0.5 text-[13.5px] text-fg">{kas(a.budget)}</dd></div>
                    <div><dt className="text-fg-3">Spent</dt><dd className="num mt-0.5 text-[13.5px] text-fg-2">{kas(a.spent)}</dd></div>
                    <div><dt className="text-fg-3">Left</dt><dd className="num mt-0.5 text-[13.5px] text-fg">{kas(a.status === "ended" ? 0 : a.remaining)}</dd></div>
                    <div><dt className="text-fg-3">In its account</dt><dd className={cn("num mt-0.5 text-[13.5px]", shortOfCoin(a) ? "text-warn" : "text-fg-2")}>{kas(a.onChain)}</dd></div>
                    <div><dt className="text-fg-3">Per payment</dt><dd className="num mt-0.5 text-[13.5px] text-fg-2">{kas(a.maxPerPayment)}</dd></div>
                    <div><dt className="text-fg-3">Term</dt><dd className="mt-0.5 text-[13.5px] text-fg-2">{a.status === "ended" || a.expired ? "Ended" : a.expiresIn ? `${a.expiresIn} left` : "—"}</dd></div>
                  </dl>
                </a>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[980px] text-left text-[13.5px]">
              <thead className="border-b border-line text-[12px] text-fg-3">
                <tr>{["Grant", "Agent", "State", "Budget", "Spent", "Left", "In its account", "Per payment", "Helpers", "Term"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((a) => (
                  <tr key={a.key} className="cursor-pointer transition hover:bg-raised/50" onClick={() => go("agents", a.key, "proof")}>
                    <td className="px-4 py-3.5">
                      {a.grantAddress ? (
                        <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <a className="num text-[12.5px] text-fg-2 hover:text-accent" href={explorerAddress(a.grantAddress, a.network)} target="_blank" rel="noopener">{short(a.grantAddress, 12, 4)}</a>
                          <Copy text={a.grantAddress} />
                        </span>
                      ) : <span className="text-fg-3">Not funded yet</span>}
                    </td>
                    <td className="px-4"><a href={href("agents", a.key)} onClick={(e) => e.stopPropagation()} className="flex items-center gap-2.5"><AgentMark agent={a} size={24} className="rounded-md" />{agentName(a)}</a></td>
                    <td className="px-4"><StatusBadge status={a.status} /></td>
                    <td className="px-4"><Kas value={kas(a.budget)} unit={false} /></td>
                    <td className="num px-4 text-fg-2">{kas(a.spent)}</td>
                    <td className="num px-4">{kas(a.status === "ended" ? 0 : a.remaining)}</td>
                    <td className={cn("num px-4", shortOfCoin(a) ? "text-warn" : "text-fg-2")}>{kas(a.onChain)}</td>
                    <td className="num px-4 text-fg-2">{kas(a.maxPerPayment)}</td>
                    <td className="num px-4 text-fg-2">{a.delegationDepth === null ? "—" : a.delegationDepth === 0 ? "none" : `${a.delegationDepth} deep`}</td>
                    <td className="px-4 text-fg-2">{a.status === "ended" || a.expired ? "Ended" : a.expiresIn ? `${a.expiresIn} left` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>)}
        <p className="border-t border-line px-5 py-3 text-[12px] leading-relaxed text-fg-3">
          Two numbers can end an agent: what its authority still allows, and the coin actually at its address. The smaller one is the answer — that is what "can still pay" means everywhere else.
          {list.some(shortOfCoin) && " Amber means the coin is below the authority."}
        </p>
      </Card>

      {own.length > 0 && (
        <Card className="mt-4 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-5 pt-5">
            <div><h3 className="text-[15px] font-semibold">Grants you track</h3><p className="mt-1 text-[13px] text-fg-3">Not published by this site. Read by the verifier, kept in this browser.</p></div>
            <a href={href("account", "grants")} className="text-[13px] text-fg-3 hover:text-fg">Manage</a>
          </div>
          <ul className="mt-3 divide-y divide-line">
            {own.map((x) => {
              const k = ownKey(x.m), rd = readings[k];
              const r = rd?.st === "read" && rd.r.found ? rd.r : null;
              const K = (s: any) => (s?.sompi != null ? kas(Number(s.sompi) / 1e8, { max: 2 }) : "—");
              return (
                <li key={k} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-[13px]">
                  <span className="num min-w-[9rem] font-medium">{x.m.covenant_id ? String(x.m.covenant_id).slice(0, 10) + "…" : short(x.m.principal)}</span>
                  <Badge tone={!rd || rd.st === "reading" ? "muted" : rd.st !== "read" ? "bad" : r ? (r.agrees ? "ok" : "bad") : "warn"}>
                    {!rd || rd.st === "reading" ? "reading…" : rd.st !== "read" ? "no reading" : r ? (r.agrees ? "live" : "disagrees") : "not at this state"}
                  </Badge>
                  <span className="text-fg-3">budget <span className="num text-fg-2">{kas(Number(x.m.budget) / 1e8, { max: 2 })}</span> KAS</span>
                  <span className="text-fg-3">cap <span className="num text-fg-2">{kas(Number(x.m.max_per_spend) / 1e8, { max: 2 })}</span> KAS</span>
                  <span className="flex-1" />
                  <span className="num">{K(r?.remaining)} <span className="text-[11.5px] text-fg-3">KAS left</span></span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
