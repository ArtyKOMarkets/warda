import { useCallback, useEffect, useState } from "react";
import { ask, type NodeStatus, type Status } from "../../src/messages.ts";

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
        <span className="wordmark">Warda Console</span>
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

function Console({ status, onChange }: { status: Status; onChange: () => void }) {
  const [node, setNode] = useState<NodeStatus | null>(null);

  useEffect(() => {
    ask<NodeStatus>({ kind: "nodeStatus" }).then(setNode).catch(() => setNode(null));
  }, []);

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
            {node === null ? "asking…" : node.reachable ? "reachable" : "unreachable"}
          </span>
        </div>
        {node ? (
          <>
            <div className="row"><span className="k">Url</span><span className="v">{node.url}</span></div>
            <div className="row"><span className="k">State</span><span className="v">{node.detail}</span></div>
            {node.daaScore ? (
              <div className="row"><span className="k">DAA</span><span className="v">{node.daaScore}</span></div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="card">
        <div className="row">
          <span className="k">Grants</span>
          <span className="v">none yet</span>
        </div>
        <p className="tight" style={{ marginTop: 8 }}>
          Issuing and revoking land next. This build proves the key, the vault and the node.
        </p>
      </div>

      <div className="foot">
        <button className="link" onClick={() => { void ask({ kind: "lock" }).then(onChange); }}>Lock now</button>
        <span className="k">auto-locks in {status.settings.lockMinutes}m</span>
      </div>
    </div>
  );
}
