import { Store, ExternalLink } from "lucide-react";
import { useData } from "@/lib/data";
import { kas, short } from "@/lib/format";
import { Badge, Card, Copy, Empty, External, PageHeader, Skeleton } from "@/components/ui";
import { allPayments } from "./shared";

export function Services() {
  const { services, agents, loading } = useData();
  const paid = allPayments(agents).filter((r) => r.p.outcome === "paid" || r.p.outcome === "paid-not-served");
  return (
    <>
      <PageHeader title="Services" sub="Paid APIs your agents can buy from. Each listing is its operator's own claim; what they've actually been paid is on-chain."
        actions={<External href="/network.html" className="text-[13px]">Full registry</External>} />
      {loading && !services.length ? <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Card key={i} className="h-44 p-5"><Skeleton className="w-40" /></Card>)}</div> : !services.length ? (
        <Card><Empty icon={<Store className="size-5" />} title="The registry is empty" /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {services.map((s) => {
            const mine = paid.filter((r) => r.p.payTo && r.p.payTo === s.address);
            const total = mine.reduce((x, r) => x + (r.p.amount ?? 0), 0);
            return (
              <Card key={s.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold">{s.name}</div>
                    <div className="mt-0.5 text-[12.5px] text-fg-3">by {s.operator ?? "unknown operator"}</div>
                  </div>
                  {s.price && <Badge tone="accent">{s.price}</Badge>}
                </div>
                {s.endpoint && <div className="num mt-4 truncate rounded-lg border border-line bg-bg/60 px-3 py-2 text-[12px] text-fg-2">{s.endpoint}</div>}
                <div className="mt-auto flex items-center justify-between gap-3 pt-5 text-[12.5px]">
                  <span className="text-fg-3">{mine.length ? <>Paid <span className="num text-fg">{kas(total)} KAS</span> in {mine.length} payment{mine.length === 1 ? "" : "s"}</> : "No payments from these agents yet"}</span>
                  {s.address && <span className="flex items-center text-fg-3"><span className="num hidden sm:inline">{short(s.address, 10, 4)}</span><Copy text={s.address} label="Copy payee address" /></span>}
                </div>
                <a href="/app#/registry" className="mt-4 inline-flex items-center gap-1 text-[13px] text-fg-2 hover:text-accent">Add as a job <ExternalLink className="size-3.5" /></a>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
