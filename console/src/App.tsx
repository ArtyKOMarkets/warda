import { BellRing, Wallet } from "lucide-react";
import { useRoute } from "@/lib/router";
import { Shell } from "@/components/shell";
import { Overview } from "@/pages/Overview";
import { Agents } from "@/pages/Agents";
import { AgentDetail } from "@/pages/AgentDetail";
import { Activity } from "@/pages/Activity";
import { Grants } from "@/pages/Grants";
import { Analytics } from "@/pages/Analytics";
import { Services } from "@/pages/Services";
import { Account } from "@/pages/Account";
import { NewAgent } from "@/pages/NewAgent";
import { Classic } from "@/pages/shared";

export function App() {
  const [page = "overview", a, b] = useRoute();
  const view = (() => {
    switch (page) {
      case "agents": return a ? <AgentDetail key={a} id={a} tab={b} /> : <Agents />;
      case "activity": return <Activity key={a ?? "all"} filter={a} />;
      case "grants": return <Grants />;
      case "analytics": return <Analytics />;
      case "services": return <Services />;
      case "account": return <Account />;
      case "new": return <NewAgent />;
      case "fund": return <Classic title="Fund" view="fund" sub="Move money into a grant from a Kaspa or EVM wallet." icon={<Wallet className="size-5" />} />;
      case "alerts": return <Classic title="Alerts" view="alerts" sub="Get told when an agent runs low, is refused, or stops." icon={<BellRing className="size-5" />} />;
      default: return <Overview />;
    }
  })();
  return <Shell active={page === "agents" && a ? "agents" : page}><div key={page + (a ?? "")} className="rise">{view}</div></Shell>;
}
