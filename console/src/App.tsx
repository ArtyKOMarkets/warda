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
import { Receipt } from "@/pages/Receipt";
import { CreateGrant } from "@/pages/CreateGrant";

export function App() {
  const [page = "overview", a, b, ...more] = useRoute();
  const view = (() => {
    switch (page) {
      case "agents": return a ? <AgentDetail key={a} id={a} tab={b} /> : <Agents />;
      case "activity": return <Activity key={a ?? "all"} filter={a} />;
      case "grants": return <Grants />;
      case "analytics": return <Analytics />;
      case "services": return <Services />;
      case "account": return <Account key={a ?? ""} tab={a} />;
      case "new": return <NewAgent />;
      case "create": return <CreateGrant />;
      case "fund": return <Fund key={a ?? ""} agent={a} rest={[b, ...more].filter((x): x is string => !!x)} />;
      case "alerts": return <Alerts key={a ?? ""} tab={a} arg={b} />;
      case "r": return a ? <Receipt key={a} id={a} /> : <Overview />;
      default: return <Overview />;
    }
  })();
  return <Shell active={page === "create" ? "new" : page === "r" ? "" : page}><div key={page + (a ?? "")} className="rise">{view}</div></Shell>;
}
