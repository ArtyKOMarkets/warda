import { FileKey2, ExternalLink } from "lucide-react";
import { useData } from "@/lib/data";
import { kas, short } from "@/lib/format";
import { explorerAddress } from "@/lib/kaspa";
import { href, go } from "@/lib/router";
import { AgentMark } from "@/components/agent";
import { Card, Copy, Empty, Kas, LinkButton, PageHeader, Skeleton, StatusBadge } from "@/components/ui";
import { agentName } from "./shared";

export function Grants() {
  const { agents, loading } = useData();
  const list = agents.filter((a) => a.grantAddress || a.budget !== null);
  return (
    <>
      <PageHeader title="Grants" sub="A grant is the on-chain contract that holds an agent's money and its rules. Its terms can't be edited — only ended." 
        actions={<LinkButton href="/app-classic#/create">Create a grant <ExternalLink className="size-4" /></LinkButton>} />
      <Card className="overflow-hidden">
        {loading && !agents.length ? <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div> : !list.length ? (
          <Empty icon={<FileKey2 className="size-5" />} title="No grants yet">Create an agent and its grant is made for you.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-[13.5px]">
              <thead className="border-b border-line text-[12px] text-fg-3">
                <tr>{["Grant", "Agent", "Status", "Budget", "Per payment", "Per period", "Payees", "Term"].map((h) => <th key={h} className="px-5 py-3 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((a) => (
                  <tr key={a.key} className="cursor-pointer transition hover:bg-raised/50" onClick={() => go("agents", a.key, "proof")}>
                    <td className="px-5 py-3.5">
                      {a.grantAddress ? (
                        <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <a className="num text-[12.5px] text-fg-2 hover:text-accent" href={explorerAddress(a.grantAddress, a.network)} target="_blank" rel="noopener">{short(a.grantAddress, 14, 6)}</a>
                          <Copy text={a.grantAddress} />
                        </span>
                      ) : <span className="text-fg-3">Not funded yet</span>}
                    </td>
                    <td className="px-5"><a href={href("agents", a.key)} onClick={(e) => e.stopPropagation()} className="flex items-center gap-2.5"><AgentMark agent={a} size={24} className="rounded-md" />{agentName(a)}</a></td>
                    <td className="px-5"><StatusBadge status={a.status} /></td>
                    <td className="px-5"><Kas value={kas(a.budget)} /></td>
                    <td className="num px-5 text-fg-2">{kas(a.maxPerPayment)}</td>
                    <td className="num px-5 text-fg-2">{kas(a.periodLimit)}</td>
                    <td className="num px-5 text-fg-2">{a.payees.length || "—"}</td>
                    <td className="px-5 text-fg-2">{a.status === "ended" || a.expired ? "Ended" : a.expiresIn ? `${a.expiresIn} left` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
