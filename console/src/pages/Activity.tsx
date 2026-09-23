import { useState } from "react";
import { Activity as Icon, Download } from "lucide-react";
import { paymentHit, useData } from "@/lib/data";
import { ActivityList } from "@/components/agent";
import { Button, Card, Empty, PageHeader, Skeleton, Tabs } from "@/components/ui";
import { agentName } from "./shared";
import { ScopeBanner } from "@/components/scope";
import { allPayments } from "@/lib/model";

type F = "all" | "paid" | "blocked" | "issues";

export function Activity({ tab }: { tab?: string }) {
  const { agents, loading, filter } = useData();
  const [f, setF] = useState<F>((["paid", "blocked", "issues"].includes(tab ?? "") ? tab : "all") as F);
  /* Overview and Analytics both narrow by the filter box; this view did not,
     which made it the one place where typing in that box changed nothing. */
  const rows = allPayments(agents).filter(({ p, a }) => paymentHit(p, a, filter));
  const pick = (x: F) => rows.filter(({ p }) => x === "all" || (x === "paid" && p.outcome === "paid") || (x === "blocked" && p.outcome === "blocked") || (x === "issues" && (p.outcome === "failed" || p.outcome === "paid-not-served")));
  const shown = pick(f);
  return (
    <>
      <ScopeBanner />
      <PageHeader title="Activity" sub="Every payment these agents made or tried, with the transaction that proves it."
        actions={<Button size="sm" disabled={!shown.length} onClick={() => {
          const rows = [["at", "agent", "outcome", "paid_kas", "host", "pay_to", "txid", "url", "why"],
            ...shown.map(({ p, a }) => [p.at, agentName(a), p.outcome, p.amount ?? "", p.host ?? "", p.payTo ?? "", p.txid ?? "", p.url ?? "", p.why ?? ""])];
          const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
          const el = document.createElement("a");
          el.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
          el.download = `warda-activity-${new Date().toISOString().slice(0, 10)}.csv`; el.click();
        }}><Download className="size-3.5" /> CSV</Button>} />
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
