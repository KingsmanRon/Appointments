import React, { useEffect, useState } from "react";
import { api } from "../api";
import {
  duration,
  label,
  percent,
  RESOLUTION_LABELS,
  STATE_LABELS,
} from "../format";
import { useSession } from "../session";

interface Measure {
  value: number | null;
  provenance: "OBSERVED" | "DERIVED" | "ESTIMATED" | "UNKNOWN";
  basis: string;
  inputs?: Record<string, unknown>;
}
/* eslint-disable @typescript-eslint/no-explicit-any -- dashboard renders an API document */
type Cohort = Record<string, any>;

const PERIODS: [string, number][] = [
  ["Last 7 days", 7],
  ["Last 30 days", 30],
  ["Last 90 days", 90],
];

export function Dashboard() {
  const session = useSession();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Cohort | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const to = new Date(Date.now() + 60_000);
    const from = new Date(to.getTime() - days * 86_400_000);
    setData(null);
    api<Cohort>(
      session.headers,
      `/v1/metrics/cohort?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    )
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [days, session.headers]);
  if (error) return <p role="alert">{error}</p>;
  return (
    <section>
      <div className="row">
        {PERIODS.map(([text, d]) => (
          <button
            key={d}
            className={d === days ? "chip active" : "chip"}
            onClick={() => setDays(d)}
          >
            {text}
          </button>
        ))}
      </div>
      <p className="muted small">
        Cohort: referrals received in the period. Every figure is computed from
        recorded facts and labelled: <b>observed</b> (counted from records),{" "}
        <b>derived</b> (calculated from recorded timestamps), <b>estimated</b>{" "}
        (self-reported), <b>unknown</b> (not enough data — never shown as zero).
      </p>
      {!data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="cards">
            <Card title="Referrals received" m={data.referrals_received} />
            <Card title="Verified (patient resolved)" m={data.verified} />
            <Card title="Ready for booking" m={data.ready_for_booking} />
            <Card title="Booked" m={data.booked} />
            <Card
              title="Closed without booking"
              m={data.closed_without_booking}
            />
            <Card
              title="Closed, outcome unknown"
              m={data.closed_unknown_outcome}
            />
            <Card title="Still open" m={data.still_open} />
            <Card
              title="Booking conversion (known outcomes)"
              m={data.booking_conversion_rate}
              format={percent}
            />
            <Card
              title="Booked of all received (to date)"
              m={data.cohort_booking_rate}
              format={percent}
            />
            <Card
              title="Median time to ready for booking"
              m={data.median_received_to_ready_seconds}
              format={duration}
            />
            <Card
              title="95th percentile time to ready"
              m={data.p95_received_to_ready_seconds}
              format={duration}
            />
            <Card
              title="Median time to booked"
              m={data.median_received_to_booked_seconds}
              format={duration}
            />
            <Card
              title="Exception rate"
              m={data.exception_rate}
              format={percent}
            />
            <Card
              title="Status enquiries per referral"
              m={data.status_contacts_per_referral}
              format={(v) => (v === null ? "Unknown" : v.toFixed(2))}
            />
            <Card
              title="Human touches per referral"
              m={data.human_touches_per_referral}
              format={(v) => (v === null ? "Unknown" : v.toFixed(2))}
            />
            <Card
              title="Staff time per referral"
              m={data.staff_seconds_per_referral}
              format={duration}
            />
            <Card
              title="Outcomes awaiting review"
              m={data.outcomes_awaiting_review}
            />
          </div>
          <div className="grid">
            <List
              title="Top closure reasons"
              rows={data.top_closure_reasons.map((r: any) => [
                RESOLUTION_LABELS[r.code] ?? r.code,
                r.count,
              ])}
            />
            <List
              title="Top exception reasons"
              rows={data.top_exception_reasons.map((r: any) => [
                label(r.kind),
                r.count,
              ])}
            />
            <List
              title="Still open by stage"
              rows={data.open_by_state.map((r: any) => [
                STATE_LABELS[r.state] ?? r.state,
                r.count,
              ])}
            />
            <List
              title="Where referrals wait (median time in stage)"
              rows={data.median_seconds_in_state.map((r: any) => [
                STATE_LABELS[r.state] ?? r.state,
                `${duration(r.median_seconds)} (n=${r.samples})`,
              ])}
            />
          </div>
        </>
      )}
    </section>
  );
}

function Card({
  title,
  m,
  format,
}: {
  title: string;
  m: Measure;
  format?: (v: number | null) => string;
}) {
  const value = format
    ? format(m.value)
    : m.value === null
      ? "Unknown"
      : String(m.value);
  return (
    <div className="card" title={m.basis}>
      <small>{title}</small>
      <strong>{value}</strong>
      <span className={`provenance ${m.provenance.toLowerCase()}`}>
        {m.provenance}
      </span>
    </div>
  );
}
function List({
  title,
  rows,
}: {
  title: string;
  rows: [string, string | number][];
}) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">No data in this period.</p>
      ) : (
        <table>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="num">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
