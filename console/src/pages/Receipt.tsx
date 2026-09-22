import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { useData } from "@/lib/data";
import { fromReading, type AgentView } from "@/lib/model";
import { AgentMark, ActivityList, AuthorityBlock, BlockedCard } from "@/components/agent";
import { Badge, Card, CardHeader, Empty, Skeleton, StatusBadge } from "@/components/ui";

/** #/r/<agent>: a hosted agent its owner chose to share. Read-only, no sign-in. */
export function Receipt({ id }: { id: string }) {
  const { runner, services } = useData();
  const [a, setA] = useState<AgentView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const labels = new Map(services.filter((s) => s.address).map((s) => [s.address!, s.name]));
    fetch(`${runner.url.replace(/\/+$/, "")}/v1/public/agents/${encodeURIComponent(id)}/reading`)
      .then(async (r) => { if (!r.ok) throw new Error("This receipt is not shared, or no longer is."); return r.json(); })
      .then((j) => setA(fromReading(j, "hosted", id, labels)))
      .catch((e) => setErr(e instanceof TypeError ? "The runner did not answer." : (e as Error).message));
  }, [id, runner.url, services]);

  if (err) return <Card><Empty icon={<Globe className="size-5" />} title="Not available">{err}</Empty></Card>;
  if (!a) return <div><Skeleton className="h-8 w-48" /><Skeleton className="mt-8 h-64 w-full rounded-[14px]" /></div>;
  const blocked = a.payments.filter((p) => p.outcome === "blocked");
  return (
    <>
      <div className="mb-8 flex items-start gap-4">
        <AgentMark agent={a} size={52} className="rounded-[14px]" />
        <div>
          <div className="flex flex-wrap items-center gap-2.5"><h1 className="text-[26px] font-semibold tracking-[-0.025em]">{a.label}</h1><StatusBadge status={a.status} /><Badge tone="info">Public receipt</Badge></div>
          <p className="mt-1.5 max-w-2xl text-[14px] text-fg-2">{a.mission ?? "Shared by its owner. Everything here is read from the Kaspa network."}</p>
        </div>
      </div>
      <AuthorityBlock a={a} />
      <div className="mt-6 grid items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card><CardHeader title="Payments" /><div className="mt-3"><ActivityList rows={a.payments.filter((p) => p.outcome !== "blocked").map((p) => ({ p, a }))} empty={<Empty title="No payments yet" className="py-10" />} /></div></Card>
        <Card><CardHeader title="Blocked" sub="Attempts outside the grant" /><div className="space-y-3 p-5">{blocked.length ? blocked.map((p, i) => <BlockedCard key={i} p={p} a={a} />) : <p className="text-[13px] text-fg-3">Nothing refused so far.</p>}</div></Card>
      </div>
    </>
  );
}
