import { useCallback, useEffect, useState } from "react";
import { ask, type Issued, type LiveGrant, type NodeStatus, type Status } from "../../src/messages.ts";
import { toKas, toSompi } from "../../src/kas.ts";

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await ask<Status>({ kind: "status" }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error && !status) return <Shell><p className="error">{error}</p></Shell>;
  if (!status) return <Shell><p className="tight">…</p></Shell>;

  return (
    <Shell network={status.settings.network}>
      {!status.hasVault ? (
        <Setup onDone={refresh} />
      ) : !status.unlocked ? (
        <Unlock status={status} onDone={refresh} />
      ) : (
        <Console status={status} onChange={refresh} />
      )}
    </Shell>
  );
}

function Shell({ children, network }: { children: React.ReactNode; network?: string }) {
  return (
    <>
      <div className="top">
        <span className="lockup">
          {/* Served from public/, so it is a local file rather than a request. */}
          <img src="/icon/48.png" width={18} height={18} alt="" />
          <span className="wordmark">Warda Console</span>
        </span>
        {network ? <span className="net">{network}</span> : null}
      </div>
      <div className="body">{children}</div>
    </>
  );
}

/**
 * First run.
 *
 * The passphrase is confirmed rather than shown, and there is no "skip". A
 * console that can be set up without one holds the revocation key for every
 * grant it issues behind nothing at all, and the person who wanted to skip is
 * the person who would not find out until it mattered.
 */
function Setup({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [importing, setImporting] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const short = pass.length > 0 && pass.length < 10;
  const mismatch = again.length > 0 && pass !== again;
  const ready = pass.length >= 10 && pass === again && !busy && (!importing || secret.trim().length === 64);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await ask({ kind: "create", passphrase: pass, importSecretHex: importing ? secret : undefined });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div>
        <h1>The key that ends things</h1>
        <p className="tight">
          This console holds one key: the one that issues grants and revokes them. Agent keys are
          handed over when a grant is made and never kept here — the network already bounds those.
        </p>
      </div>

      {importing ? (
        <div>
          <label htmlFor="sk">Principal secret key (64 hex)</label>
          <input id="sk" value={secret} onChange={(e) => setSecret(e.target.value)}
                 placeholder="a1b2c3…" autoComplete="off" spellCheck={false} />
        </div>
      ) : null}

      <div>
        <label htmlFor="p1">Passphrase</label>
        <input id="p1" type="password" value={pass} onChange={(e) => setPass(e.target.value)}
               placeholder="at least 10 characters" autoComplete="new-password" />
      </div>
      <div>
        <label htmlFor="p2">Again</label>
        <input id="p2" type="password" value={again} onChange={(e) => setAgain(e.target.value)}
               autoComplete="new-password" />
      </div>

      {short ? <p className="tight">Ten characters is the floor, not the target.</p> : null}
      {mismatch ? <p className="error">These do not match.</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <button disabled={!ready} onClick={() => void submit()}>
        {importing ? "Import this key" : "Create a principal key"}
      </button>
      <button className="link" onClick={() => setImporting(!importing)}>
        {importing ? "…or generate a new one" : "…or import a key I already have"}
      </button>
    </div>
  );
}

function Unlock({ status, onDone }: { status: Status; onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await ask({ kind: "unlock", passphrase: pass });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div>
        <h1>Locked</h1>
        <p className="tight">Holding the principal key for</p>
        <p className="addr">{status.address}</p>
      </div>
      <div>
        <label htmlFor="u">Passphrase</label>
        <input id="u" type="password" value={pass} autoFocus autoComplete="current-password"
               onChange={(e) => setPass(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && pass) void submit(); }} />
      </div>
      {error ? <p className="error">{error}</p> : null}
      <button disabled={!pass || busy} onClick={() => void submit()}>Unlock</button>
    </div>
  );
}

type View =
  | { screen: "grants" }
  | { screen: "issue" }
  | { screen: "handoff"; issued: Issued };

function Console({ status, onChange }: { status: Status; onChange: () => void }) {
  const [view, setView] = useState<View>({ screen: "grants" });

  if (view.screen === "issue") {
    return <Issue onCancel={() => setView({ screen: "grants" })}
                  onIssued={(issued) => setView({ screen: "handoff", issued })} />;
  }
  if (view.screen === "handoff") {
    return <Handoff issued={view.issued} onDone={() => setView({ screen: "grants" })} />;
  }
  return <Grants status={status} onChange={onChange} onIssue={() => setView({ screen: "issue" })} />;
}

function Grants({ status, onChange, onIssue }:
  { status: Status; onChange: () => void; onIssue: () => void }) {
  const [node, setNode] = useState<NodeStatus | null>(null);
  const [grants, setGrants] = useState<LiveGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    ask<NodeStatus>({ kind: "nodeStatus" }).then(setNode).catch(() => setNode(null));
    ask<LiveGrant[]>({ kind: "grants" })
      .then((g) => { setGrants(g); setError(null); })
      .catch((e) => { setGrants([]); setError((e as Error).message); });
  }, []);

  useEffect(load, [load]);

  return (
    <div className="stack">
      <div>
        <h1>Principal</h1>
        <p className="addr">{status.address}</p>
      </div>

      <div className="card">
        <div className="row">
          <span className="k">Node</span>
          <span className="v">
            <span className={`dot ${node === null ? "wait" : node.reachable ? "up" : "down"}`} />
            {node === null ? "asking…" : node.reachable ? node.detail : "unreachable"}
          </span>
        </div>
      </div>

      <button onClick={onIssue}>Issue a grant</button>

      {error ? <p className="error">{error}</p> : null}

      {grants === null ? (
        <p className="tight">reading the chain…</p>
      ) : grants.length === 0 ? (
        <p className="tight">
          No grants yet. A grant is a budget an agent can spend without being trusted not to —
          the limits are in the address, and consensus refuses anything outside them.
        </p>
      ) : (
        grants.map((g) => <GrantCard key={g.record.id} grant={g} onChange={() => { load(); onChange(); }} />)
      )}

      <div className="foot">
        <button className="link" onClick={() => { void ask({ kind: "lock" }).then(onChange); }}>Lock now</button>
        <span className="k">auto-locks in {status.settings.lockMinutes}m</span>
      </div>
    </div>
  );
}

function GrantCard({ grant, onChange }: { grant: LiveGrant; onChange: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { record } = grant;
  const ended = record.endedBy !== null;

  async function doRevoke() {
    setBusy(true);
    setError(null);
    try {
      await ask({ kind: "revoke", id: record.id, feeSompi: "1500000" });
      onChange();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setConfirming(false);
    }
  }

  /* Two numbers, and they are not the same thing. `held` is the coin sitting
     at the grant's address right now. `spent` is what the COVENANT has counted
     against the budget — which only becomes real once the grant has been
     placed, because it lives in the state that derives the address. Before
     that it is zero because nothing has been observed, not because nothing has
     happened, and the bar says which by being hatched. */
  const granted = BigInt(record.grantValue);
  const spent = BigInt(grant.spentSompi);
  const held = grant.balanceSompi === null ? null : BigInt(grant.balanceSompi);
  const pct = held === null || granted === 0n ? 0 : Number((held * 1000n) / granted) / 10;

  return (
    <div className="card">
      <div className="row">
        <span className="gname">{record.label}</span>
        <span className={`gsum${ended || held === null ? " gone" : ""}`}>
          {ended ? "ended" : held === null ? "—" : `${toKas(held, 3)} KAS left`}
        </span>
      </div>

      <div className={`bar${held === null ? " unknown" : ""}`} title={`${pct}% of the grant still here`}>
        <i style={held === null ? undefined : { width: `${Math.max(pct, 1)}%` }} />
      </div>

      <div className="row"><span className="k">Granted</span><span className="v">{toKas(granted, 3)} KAS</span></div>
      {spent > 0n ? (
        <div className="row"><span className="k">Spent</span><span className="v">{toKas(spent, 3)} KAS</span></div>
      ) : null}
      <div className="row"><span className="k">Per spend</span><span className="v">max {toKas(record.state.maxPerSpend, 3)} KAS</span></div>
      <div className="row"><span className="k">May pay</span><span className="v">{record.recipients.length} address{record.recipients.length === 1 ? "" : "es"}, fixed</span></div>
      <div className="row"><span className="k">At</span><span className="v">{grant.address.slice(0, 20)}…</span></div>

      {held === null && !ended ? (
        <p className="tight" style={{ marginTop: 8 }}>{grant.detail}</p>
      ) : grant.caughtUp > 0 ? (
        <p className="note">{grant.detail}</p>
      ) : null}

      {error ? <p className="error" style={{ marginTop: 8 }}>{error}</p> : null}

      {ended ? null : confirming ? (
        <div className="stack" style={{ marginTop: 10 }}>
          <p className="tight">
            This ends the grant now and returns what is left to you. The agent cannot spend
            afterwards, and this cannot be undone.
          </p>
          <button disabled={busy} onClick={() => void doRevoke()}>{busy ? "Broadcasting…" : "Yes, end it"}</button>
          <button className="ghost" disabled={busy} onClick={() => setConfirming(false)}>Keep it</button>
        </div>
      ) : (
        <button className="ghost" style={{ marginTop: 10 }} onClick={() => setConfirming(true)}>Revoke</button>
      )}
    </div>
  );
}

/**
 * The terms, in KAS.
 *
 * Every one of these is fixed at genesis and unchangeable afterwards — not by
 * the agent, not by this console, not by everyone colluding. The only way to
 * give an agent different authority is to issue a different grant. The form
 * says so once rather than qualifying each field.
 */
function Issue({ onCancel, onIssued }: { onCancel: () => void; onIssued: (i: Issued) => void }) {
  const [label, setLabel] = useState("");
  const [recipients, setRecipients] = useState("");
  const [budget, setBudget] = useState("2");
  const [perSpend, setPerSpend] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const b = toSompi(budget);
      const m = toSompi(perSpend);
      if (m > b) throw new Error("a per-spend cap above the whole budget is not a cap");
      onIssued(
        await ask<Issued>({
          kind: "issue",
          terms: {
            label,
            recipients,
            budgetSompi: b.toString(),
            maxPerSpendSompi: m.toString(),
            // An epoch cap of a quarter of the budget over ~1000 DAA is the
            // CLI's default and the reason to keep it is that a rate limit is
            // the difference between a bad day and a drained grant.
            epochLimitSompi: (b / 4n === 0n ? b : b / 4n).toString(),
            epochLengthDaa: "1000",
            // ~30 days at ten blocks a second. A grant that never expires is
            // an authority nobody has to remember to end.
            windowDaa: "25920000",
            feeSompi: "1500000",
          },
        }),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const ready = !busy && recipients.trim().length > 0 && budget.trim().length > 0;

  return (
    <div className="stack">
      <div>
        <h1>New grant</h1>
        <p className="tight">
          Fixed at genesis and unchangeable afterwards — by anyone, including you. To change an
          agent's authority you issue a different grant and end this one.
        </p>
      </div>

      <div>
        <label htmlFor="l">Name it</label>
        <input id="l" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="research agent" />
      </div>
      <div>
        <label htmlFor="r">May pay — addresses or x-only keys</label>
        <input id="r" value={recipients} onChange={(e) => setRecipients(e.target.value)}
               placeholder="kaspatest:qq… , kaspatest:qr…" spellCheck={false} />
      </div>
      <div>
        <label htmlFor="b">Budget (KAS)</label>
        <input id="b" value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" />
      </div>
      <div>
        <label htmlFor="m">Most it may spend at once (KAS)</label>
        <input id="m" value={perSpend} onChange={(e) => setPerSpend(e.target.value)} inputMode="decimal" />
      </div>

      {error ? <p className="error">{error}</p> : null}

      <button disabled={!ready} onClick={() => void submit()}>
        {busy ? "Funding and broadcasting…" : "Create it"}
      </button>
      <button className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  );
}

/**
 * The agent key, once.
 *
 * This is the only secret that ever leaves the worker, and it leaves because
 * it has to reach the machine that will spend. It is not stored here. Losing
 * it leaves a grant that can still be revoked — that right is the principal's
 * and it is safe in this console — but never spent, and the screen says so
 * before it can be dismissed.
 */
function Handoff({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="stack">
      <div>
        <h1>Take the agent key now</h1>
        <p className="tight">
          It is not stored here. Move it to wherever the agent runs. Without it the grant can
          still be revoked, but never spent.
        </p>
      </div>

      <div className="card">
        <div className="row"><span className="k">Agent secret</span></div>
        <p className="addr" style={{ marginTop: 6 }}>{issued.agentSecretHex}</p>
      </div>

      <button className="ghost" onClick={() => {
        void navigator.clipboard.writeText(issued.agentSecretHex).then(() => setCopied(true));
      }}>{copied ? "Copied" : "Copy the key"}</button>

      <div className="card">
        <div className="row"><span className="k">Grant</span><span className="v">{issued.address.slice(0, 22)}…</span></div>
        <div className="row"><span className="k">Genesis</span><span className="v">{issued.txid.slice(0, 22)}…</span></div>
      </div>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
        <input type="checkbox" style={{ width: "auto", marginTop: 2 }}
               checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <span>I have saved it somewhere the agent can read.</span>
      </label>

      <button disabled={!acknowledged} onClick={onDone}>Done</button>
    </div>
  );
}
