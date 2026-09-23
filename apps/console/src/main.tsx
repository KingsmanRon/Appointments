import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type View = {
  referral: {
    id: string;
    state: string;
    version: number;
    identity_status?: string;
    external_id?: string;
  };
  events: Array<{
    sequence: number;
    event_type: string;
    created_at: string;
    correlation_id: string;
  }>;
  work_items: Array<{
    id: string;
    kind: string;
    status: string;
    reason: string;
  }>;
  executions: Array<{
    id: string;
    status: string;
    attempts: number;
    external_id?: string;
    last_error?: string;
  }>;
};
function App() {
  const [tenant, setTenant] = useState("11111111-1111-4111-8111-111111111111");
  const [id, setId] = useState("");
  const [data, setData] = useState<View>();
  const [error, setError] = useState("");
  async function load() {
    setError("");
    const r = await fetch(
      `${import.meta.env.VITE_CORE_API_URL ?? "http://localhost:3001"}/v1/referrals/${id}`,
      { headers: { "x-tenant-id": tenant } },
    );
    if (!r.ok) {
      setError(`Unable to load referral (${r.status})`);
      return;
    }
    setData(await r.json());
  }
  return (
    <main>
      <header>
        <p className="eyebrow">ACCESS · STAFF CONSOLE</p>
        <h1>Referral operations</h1>
        <p>Administrative workflow evidence and exception recovery.</p>
      </header>
      <section className="search">
        <label>
          Tenant ID
          <input value={tenant} onChange={(e) => setTenant(e.target.value)} />
        </label>
        <label>
          Referral ID
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="UUID"
          />
        </label>
        <button onClick={load}>Open referral</button>
      </section>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <section className="hero">
            <div>
              <span className={`badge ${data.referral.state.toLowerCase()}`}>
                {data.referral.state}
              </span>
              <h2>{data.referral.id}</h2>
              <p>
                Version {data.referral.version} · Identity{" "}
                {data.referral.identity_status ?? "pending"}
              </p>
            </div>
            <strong>
              {data.referral.external_id ?? "No external record yet"}
            </strong>
          </section>
          <div className="grid">
            <Panel title="Exceptions">
              {data.work_items.length ? (
                data.work_items.map((w) => (
                  <article key={w.id}>
                    <b>
                      {w.kind} · {w.status}
                    </b>
                    <p>{w.reason}</p>
                  </article>
                ))
              ) : (
                <p>No exceptions.</p>
              )}
            </Panel>
            <Panel title="Execution & reconciliation">
              {data.executions.length ? (
                data.executions.map((x) => (
                  <article key={x.id}>
                    <b>{x.status}</b>
                    <p>{x.id}</p>
                    <small>
                      Attempts {x.attempts}{" "}
                      {x.last_error && `· ${x.last_error}`}
                    </small>
                  </article>
                ))
              ) : (
                <p>Action not dispatched.</p>
              )}
            </Panel>
          </div>
          <Panel title="Evidence chain">
            {data.events.map((e) => (
              <article className="event" key={e.sequence}>
                <b>
                  #{e.sequence} {e.event_type}
                </b>
                <time>{new Date(e.created_at).toLocaleString()}</time>
                <small>Correlation {e.correlation_id}</small>
              </article>
            ))}
          </Panel>
        </>
      )}
    </main>
  );
}
function Panel(p: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h3>{p.title}</h3>
      {p.children}
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
