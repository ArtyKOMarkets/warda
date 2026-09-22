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
import { Fund } from "@/pages/Fund";
import { Alerts } from "@/pages/Alerts";

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
      case "fund": return <Fund key={a ?? ""} agent={a} />;
      case "alerts": return <Alerts />;
      default: return <Overview />;
    }
  })();
  return <Shell active={page === "agents" && a ? "agents" : page}><div key={page + (a ?? "")} className="rise">{view}</div></Shell>;
}
