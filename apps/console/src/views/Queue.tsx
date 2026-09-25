import React, { useEffect, useState } from "react";
import { api } from "../api";
import { duration, STATE_LABELS, stateClass } from "../format";
import { useSession } from "../session";

const FILTERS: [string, string][] = [
  ["needs_attention", "Needs attention"],
  ["identity_pending", "Identity pending"],
  ["information_missing", "Information missing"],
  ["ready", "Ready"],
  ["ready_for_booking", "Ready for booking"],
  ["waiting", "Waiting"],
  ["booked", "Booked"],
  ["closed", "Closed"],
  ["exceptions", "Exceptions"],
  ["all", "All"],
];
interface Item {
  case_id: string;
  display_ref: string;
  state: string;
  age_seconds: number;
  owner: string | null;
  exception_reason: string | null;
  next_action: string;
  destination_status: string;
  outcome_status: string;
  open_work_items: string[];
}

export function Queue({ open }: { open: (caseId: string) => void }) {
  const session = useSession();
  const [filter, setFilter] = useState(
    () => sessionStorage.getItem("queue-filter") ?? "needs_attention",
  );
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    sessionStorage.setItem("queue-filter", filter);
    setItems(null);
    api<{ items: Item[] }>(
      session.headers,
      `/v1/cases?filter=${filter}&limit=200`,
    )
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  }, [filter, session.headers]);
  return (
    <section>
      <nav className="filters" aria-label="Queue filters">
        {FILTERS.map(([value, text]) => (
          <button
            key={value}
            className={value === filter ? "chip active" : "chip"}
            onClick={() => setFilter(value)}
          >
            {text}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {!items ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="panel muted">No cases in this view.</p>
      ) : (
        <div className="table-wrap panel">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>State</th>
                <th>Age</th>
                <th>Owner</th>
                <th>Next required action</th>
                <th>Destination</th>
                <th>Booking / outcome</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr
                  key={i.case_id}
                  onClick={() => open(i.case_id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && open(i.case_id)}
                >
                  <td>
                    <b>{i.display_ref}</b>
                    {i.open_work_items.length > 0 && (
                      <small className="muted">
                        {" "}
                        · {i.open_work_items.join(", ").toLowerCase()}
                      </small>
                    )}
                  </td>
                  <td>
                    <span className={stateClass(i.state)}>
                      {STATE_LABELS[i.state] ?? i.state}
                    </span>
                    {i.exception_reason && (
                      <small className="muted block">
                        {i.exception_reason}
                      </small>
                    )}
                  </td>
                  <td>{duration(i.age_seconds)}</td>
                  <td>{i.owner ?? "—"}</td>
                  <td>{i.next_action}</td>
                  <td>{i.destination_status}</td>
                  <td>{i.outcome_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
