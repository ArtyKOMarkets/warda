import { useState } from "react";
import { Eye, EyeOff, CircleCheck, CircleAlert, ExternalLink, Server } from "lucide-react";
import { useData } from "@/lib/data";
import { api, DEFAULT_RUNNER } from "@/lib/runner";
import { Button, Card, CardHeader, LinkButton, PageHeader } from "@/components/ui";

export function Account() {
  const { runner, setRunner, errors, agents } = useData();
  const [url, setUrl] = useState(runner.url);
  const [key, setKey] = useState(runner.key);
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const hosted = agents.filter((a) => a.source === "hosted").length;

  const save = async () => {
    setBusy(true); setMsg(null);
    const c = { ...runner, url: url.trim() || DEFAULT_RUNNER, key: key.trim() };
    try {
      const r = await api<{ agents: string[] }>(c, "GET", "/v1/agents");
      setRunner(c);
      setMsg({ ok: true, text: `Signed in. ${r.agents.length} hosted agent${r.agents.length === 1 ? "" : "s"} on this account.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally { setBusy(false); }
  };

  const input = "h-10 w-full rounded-lg border border-line-strong bg-bg px-3 text-[14px] placeholder:text-fg-3 focus:border-accent/60 focus:outline-none";
  return (
    <>
      <PageHeader title="Account" sub="Sign in to the runner to see and manage your hosted agents. Published agents show without signing in." />
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Runner" sub={runner.key ? (errors.hosted ? "Signed in, but the runner did not answer" : `Signed in · ${hosted} hosted agent${hosted === 1 ? "" : "s"}`) : "Not signed in"} />
          <form className="space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label className="block">
              <span className="mb-1.5 block text-[13px] text-fg-2">Runner URL</span>
              <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoCapitalize="off" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] text-fg-2">Account key</span>
              <span className="relative block">
                <input className={input + " num pr-10"} type={show ? "text" : "password"} value={key} onChange={(e) => setKey(e.target.value)} placeholder="wk_…" spellCheck={false} autoCapitalize="off" autoComplete="off" />
                <button type="button" onClick={() => setShow(!show)} className="absolute right-1 top-1 grid size-8 place-items-center rounded-md text-fg-3 hover:text-fg" aria-label={show ? "Hide key" : "Show key"}>{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
              </span>
              <span className="mt-1.5 block text-[12px] text-fg-3">Stored only in this browser. It is shared with the classic console.</span>
            </label>
            {msg && <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-[13px] ${msg.ok ? "bg-ok/10 text-ok" : "bg-bad/10 text-bad"}`}>{msg.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}{msg.text}</div>}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" disabled={busy}>{busy ? "Checking…" : "Save and sign in"}</Button>
              {runner.key && <Button type="button" variant="ghost" onClick={() => { setKey(""); setRunner({ ...runner, key: "" }); setMsg(null); }}>Sign out</Button>}
            </div>
          </form>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold"><Server className="size-4 text-accent" /> Wallet and invite codes</div>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-2">Connecting a wallet and redeeming an invite code are still in the classic console. Telegram is under <a className="text-fg hover:text-accent" href="#/alerts">Alerts</a>.</p>
          <LinkButton className="mt-4" href="/app#/account">Open account settings <ExternalLink className="size-4" /></LinkButton>
        </Card>
      </div>
    </>
  );
}
