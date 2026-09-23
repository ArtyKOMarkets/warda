import type { AgentView } from "@/lib/model";
import { ExternalLink } from "lucide-react";
import { Card, Empty, LinkButton, PageHeader } from "@/components/ui";

export const agentName = (a: AgentView) => (a.source === "hosted" ? a.label : `Agent ${a.label}`);

/** Screens not rebuilt yet open in the classic console, which still does everything. */
export function Classic({ title, sub, view, icon }: { title: string; sub: string; view: string; icon: React.ReactNode }) {
  return (
    <>
      <PageHeader title={title} sub={sub} />
      <Card>
        <Empty icon={icon} title={`${title} is in the classic console for now`} action={<LinkButton variant="primary" href={`/app-classic#/${view}`}>Open {title} <ExternalLink className="size-4" /></LinkButton>}>
          It works the same there. This screen is being rebuilt next.
        </Empty>
      </Card>
    </>
  );
}
