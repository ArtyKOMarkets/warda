import { useState } from "react";
import { Eye, EyeOff, CircleCheck, CircleAlert, ExternalLink, Server } from "lucide-react";
import { useData } from "@/lib/data";
import { api, DEFAULT_RUNNER } from "@/lib/runner";
import { Button, Card, CardHeader, Copy, LinkButton, PageHeader } from "@/components/ui";

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

  const [code, setCode] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const redeem = async () => {
    setBusy(true); setMsg(null);
    try {
      const c = { ...runner, url: url.trim() || DEFAULT_RUNNER, key: "" };
      const r = await api<{ apiKey: string }>(c, "POST", "/v1/accounts", { code: code.trim() });
      setRunner({ ...c, key: r.apiKey }); setKey(r.apiKey); setFresh(r.apiKey); setCode("");
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
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
        <div className="space-y-4">
        {!runner.key || fresh ? (
          <Card className="p-5">
            <div className="text-[15px] font-semibold">New here?</div>
            {fresh ? (
              <div className="rise">
                <p className="mt-2 text-[13px] text-ok">Account created, and you're signed in.</p>
                <p className="mt-2 text-[12.5px] text-fg-2">This is your account key. It is shown once — keep a copy somewhere safe.</p>
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-line-strong bg-bg px-3 py-2"><span className="num min-w-0 flex-1 break-all text-[12px]">{fresh}</span><Copy text={fresh} label="Copy key" /></div>
              </div>
            ) : (
              <>
                <p className="mt-2 text-[13px] text-fg-2">Redeem an invite code to make an account.</p>
                <div className="mt-3 flex gap-2">
                  <input className={input} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Invite code" autoCapitalize="off" spellCheck={false} />
                  <Button disabled={!code.trim() || busy} onClick={redeem}>Redeem</Button>
                </div>
              </>
            )}
          </Card>
        ) : null}
        <Card className="p-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold"><Server className="size-4 text-accent" /> Your wallet</div>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-2">Connecting a wallet to see its balances is still in the classic console. Telegram is under <a className="text-fg hover:text-accent" href="#/alerts">Alerts</a>.</p>
          <LinkButton className="mt-4" href="/app-classic#/account">Open account settings <ExternalLink className="size-4" /></LinkButton>
        </Card>
        </div>
      </div>
    </>
  );
}
