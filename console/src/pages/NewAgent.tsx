import { Bot, KeyRound, ArrowRight, Check } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";

const PATHS = [
  {
    icon: Bot, title: "Hosted agent", tag: "Recommended", to: "/app#/hosted",
    body: "Warda runs the agent for you. Give it a job, a budget and a list of who it may pay, then fund it.",
    points: ["Runs on a schedule, or when you ask", "Ask-me-first approvals on Telegram", "Top up, pause or return money any time"],
  },
  {
    icon: KeyRound, title: "Your own grant", tag: "Developers", to: "/app#/create",
    body: "Your software holds the agent key. You get a grant file and plug it into the SDK, CLI or MCP.",
    points: ["You run the agent anywhere", "Same on-chain limits", "Works with x402 services"],
  },
];

export function NewAgent() {
  return (
    <>
      <PageHeader title="New agent" sub="Every agent gets its own grant: money it can spend, and rules the network enforces on every payment." />
      <div className="grid gap-4 md:grid-cols-2">
        {PATHS.map((p, i) => (
          <a key={p.title} href={p.to} className="group block">
            <Card interactive className={`relative h-full overflow-hidden p-6 ${i === 0 ? "border-accent/30" : ""}`}>
              {i === 0 && <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-accent/10 blur-3xl" />}
              <div className="relative flex items-center justify-between">
                <div className="grid size-11 place-items-center rounded-xl border border-line-strong bg-raised"><p.icon className="size-5 text-accent" /></div>
                <span className="text-[12px] font-medium text-fg-3">{p.tag}</span>
              </div>
              <h2 className="relative mt-5 text-[19px] font-semibold tracking-[-0.02em]">{p.title}</h2>
              <p className="relative mt-2 text-[13.5px] leading-relaxed text-fg-2">{p.body}</p>
              <ul className="relative mt-5 space-y-2">
                {p.points.map((x) => <li key={x} className="flex items-center gap-2 text-[13px] text-fg-2"><Check className="size-4 text-accent" />{x}</li>)}
              </ul>
              <div className="relative mt-6 flex items-center gap-1.5 text-[13.5px] font-medium text-fg transition group-hover:text-accent">Start <ArrowRight className="size-4 transition group-hover:translate-x-0.5" /></div>
            </Card>
          </a>
        ))}
      </div>
      <p className="mt-5 text-[12.5px] text-fg-3">Both open the setup in the classic console while this flow is rebuilt.</p>
    </>
  );
}
