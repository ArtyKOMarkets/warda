import { useState } from "react";
import { Activity as Icon } from "lucide-react";
import { useData } from "@/lib/data";
import { ActivityList } from "@/components/agent";
import { Card, Empty, PageHeader, Skeleton, Tabs } from "@/components/ui";
import { allPayments } from "./shared";

type F = "all" | "paid" | "blocked" | "issues";

export function Activity({ filter }: { filter?: string }) {
  const { agents, loading } = useData();
  const [f, setF] = useState<F>((["paid", "blocked", "issues"].includes(filter ?? "") ? filter : "all") as F);
  const rows = allPayments(agents);
  const pick = (x: F) => rows.filter(({ p }) => x === "all" || (x === "paid" && p.outcome === "paid") || (x === "blocked" && p.outcome === "blocked") || (x === "issues" && (p.outcome === "failed" || p.outcome === "paid-not-served")));
  const shown = pick(f);
  return (
    <>
      <PageHeader title="Activity" sub="Every payment your agents made or tried, with the transaction that proves it." />
      <Tabs className="mb-5" value={f} onChange={(v) => { setF(v); history.replaceState(null, "", `#/activity/${v}`); }} items={[
        { value: "all", label: "All", count: rows.length },
        { value: "paid", label: "Paid", count: pick("paid").length },
        { value: "blocked", label: "Blocked", count: pick("blocked").length },
        { value: "issues", label: "Needs a look", count: pick("issues").length },
      ]} />
      <Card>
        {loading && !agents.length ? <div className="space-y-3 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div> :
          <ActivityList rows={shown} showAgent empty={<Empty icon={<Icon className="size-5" />} title="Nothing here yet">{f === "blocked" ? "No attempt has fallen outside a grant." : "Payments appear here as agents make them."}</Empty>} />}
      </Card>
    </>
  );
}
