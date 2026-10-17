import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { PageHeader } from "../layout/PageHeader";
import {
  addDays,
  CHANNEL_LABELS,
  clock,
  dayTitle,
  isoWeekday,
  localDate,
  localMinutes,
  minutesLabel,
  patientName,
  STATUS_CLASS,
  STATUS_LABELS,
  stampIn,
  weekStart,
  type AppointmentDetail,
  type CalendarView,
  type Practitioner,
  type ScheduledAppointment,
} from "../schedule";
import { useSession } from "../session";

type Mode = "day" | "week";
/** Height of one minute in the time grid, in pixels. */
const PPM = 1.6;
const BLOCK_LABELS: Record<string, string> = {
  LEAVE: "Leave",
  ADMIN: "Admin time",
  MEETING: "Meeting",
  BREAK: "Break",
  PERSONAL: "Personal",
  PUBLIC_HOLIDAY: "Public holiday",
  OTHER: "Unavailable",
};
function storedMode(): Mode {
  try {
    return localStorage.getItem("access-calendar-mode") === "day"
      ? "day"
      : "week";
  } catch {
    return "week";
  }
}
function age(dob: string | null, on: string): string {
  if (!dob) return "";
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = on.split("-").map(Number);
  const years = ty! - y! - (tm! < m! || (tm === m && td! < d!) ? 1 : 0);
  return `${years} years`;
}

/**
 * A practitioner's calendar, drawn from ACCESS's own appointment records. A
 * doctor signed in as PRACTITIONER sees only their own; the server and the
 * database enforce that, this page only follows.
 */
export function ScheduleCalendar() {
  const session = useSession();
  const headers = session.headers;
  const doctor = session.me?.role === "PRACTITIONER";
  const [practitioners, setPractitioners] = useState<Practitioner[] | null>(
    null,
  );
  const [pid, setPid] = useState("");
  const p = practitioners?.find((x) => x.id === pid) ?? null;
  const [mode, setModeState] = useState<Mode>(storedMode);
  const [anchor, setAnchor] = useState("");
  const [view, setView] = useState<CalendarView | null>(null);
  const [selected, setSelected] = useState<AppointmentDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem("access-calendar-mode", m);
    } catch {
      // per-viewer convenience only
    }
  };

  useEffect(() => {
    api<Practitioner[]>(headers, "/v1/schedule/practitioners")
      .then((list) => {
        setPractitioners(list);
        if (list[0]) setPid(list[0].id);
      })
      .catch((e) => setError((e as Error).message));
  }, [headers]);
  useEffect(() => {
    if (p && !anchor) setAnchor(localDate(new Date(), p.timezone));
  }, [p, anchor]);

  const range = useMemo(() => {
    if (!anchor) return null;
    if (mode === "day") return { from: anchor, to: anchor };
    const from = weekStart(anchor);
    return { from, to: addDays(from, 6) };
  }, [anchor, mode]);

  const load = useCallback(async () => {
    if (!p || !range) return;
    const query = `from=${range.from}&to=${range.to}${doctor ? "" : `&practitioner_id=${p.id}`}`;
    setView(await api<CalendarView>(headers, `/v1/schedule/calendar?${query}`));
  }, [p, range, doctor, headers]);
  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  const open = async (a: ScheduledAppointment) => {
    try {
      setSelected(
        await api<AppointmentDetail>(
          headers,
          `/v1/schedule/appointments/${a.id}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const complete = async (a: ScheduledAppointment) => {
    setBusy(true);
    setError("");
    try {
      await api(headers, `/v1/schedule/appointments/${a.id}/actions`, {
        method: "POST",
        body: {
          action: "complete",
          command_id: crypto.randomUUID(),
          expected_version: a.version,
        },
      });
      await load();
      setSelected(
        await api<AppointmentDetail>(
          headers,
          `/v1/schedule/appointments/${a.id}`,
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tz = p?.timezone ?? "UTC";
  const today = p ? localDate(new Date(), tz) : "";
  const days = useMemo(() => {
    if (!range || !view) return [];
    const all = Array.from({ length: mode === "day" ? 1 : 7 }, (_, i) =>
      addDays(range.from, i),
    );
    if (mode === "day") return all;
    // Weekends appear only when someone works or is booked on them.
    return all.filter((d) => {
      const wd = isoWeekday(d);
      return (
        wd <= 5 ||
        view.working_hours.some((h) => h.weekday === wd) ||
        view.appointments.some(
          (a) => localDate(new Date(a.starts_at), tz) === d,
        )
      );
    });
  }, [range, view, mode, tz]);

  // The grid spans working hours and anything booked outside them.
  const [top, bottom] = useMemo(() => {
    if (!view) return [480, 1020];
    const starts = [
      ...view.working_hours.map((h) => h.start_minute),
      ...view.appointments.map((a) => localMinutes(new Date(a.starts_at), tz)),
    ];
    const ends = [
      ...view.working_hours.map((h) => h.end_minute),
      ...view.appointments.map(
        (a) => localMinutes(new Date(a.starts_at), tz) + a.duration_minutes,
      ),
    ];
    const lo = starts.length ? Math.min(...starts) : 480;
    const hi = ends.length ? Math.max(...ends) : 1020;
    return [Math.floor(lo / 60) * 60, Math.min(1440, Math.ceil(hi / 60) * 60)];
  }, [view, tz]);
  const hours = Array.from(
    { length: (bottom - top) / 60 + 1 },
    (_, i) => top + i * 60,
  );

  const onDay = (d: string) =>
    (view?.appointments ?? []).filter(
      (a) => localDate(new Date(a.starts_at), tz) === d,
    );
  const blocksOn = (d: string) =>
    (view?.blocks ?? []).filter(
      (b) =>
        localDate(new Date(b.starts_at), tz) <= d &&
        localDate(new Date(b.ends_at), tz) >= d,
    );
  const step = (n: number) =>
    setAnchor(addDays(anchor, mode === "day" ? n : 7 * n));
  const title = range
    ? mode === "day"
      ? dayTitle(range.from)
      : `${dayTitle(range.from, "short")} – ${dayTitle(range.to, "short")}`
    : "";
  const counts = (view?.appointments ?? []).filter(
    (a) => a.status !== "CANCELLED",
  );

  if (practitioners && practitioners.length === 0)
    return (
      <>
        <PageHeader title="Calendar" />
        <div className="panel empty">
          <strong>
            {doctor
              ? "Your calendar is not set up yet."
              : "No practitioner is set up yet."}
          </strong>
          <span>
            {doctor
              ? "Ask the practice manager to link your sign-in to your practitioner record."
              : "A practice manager adds the doctor and their working hours first."}
          </span>
        </div>
      </>
    );

  return (
    <>
      <PageHeader
        title={doctor && p ? `${p.display_name}'s calendar` : "Calendar"}
        context={
          view
            ? `${counts.length} appointment${counts.length === 1 ? "" : "s"} · times in ${tz.replace("_", " ")}`
            : "Loading…"
        }
        actions={
          <div className="cal-controls">
            {!doctor && practitioners && practitioners.length > 1 && (
              <select
                aria-label="Practitioner"
                value={pid}
                onChange={(e) => setPid(e.target.value)}
              >
                {practitioners.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name}
                  </option>
                ))}
              </select>
            )}
            <div className="seg seg--compact" role="group" aria-label="View">
              {(["day", "week"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`seg__option${mode === m ? " is-on" : ""}`}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                >
                  {m === "day" ? "Day" : "Week"}
                </button>
              ))}
            </div>
            <div className="cal-step">
              <button
                type="button"
                className="btn btn-secondary"
                aria-label={`Previous ${mode}`}
                onClick={() => step(-1)}
              >
                <Icon name="back" />
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setAnchor(today)}
                disabled={!today}
              >
                Today
              </button>
              <button
                type="button"
                className="btn btn-secondary day-step__next"
                aria-label={`Next ${mode}`}
                onClick={() => step(1)}
              >
                <Icon name="back" />
              </button>
            </div>
          </div>
        }
      />
      {error && (
        <p className="alert" role="alert">
          <Icon name="alert" />
          {error}
        </p>
      )}
      <h2 className="cal-title">{title}</h2>
      <div className={`cal-layout${selected ? " has-detail" : ""}`}>
        <div className={`panel cal cal--${mode}`}>
          {/* Time grid (tablet and desktop) */}
          <div
            className="cal-grid"
            style={{ "--cols": days.length } as React.CSSProperties}
            aria-hidden={false}
          >
            <div className="cal-grid__corner" />
            {days.map((d) => (
              <div
                key={d}
                className={`cal-grid__day${d === today ? " is-today" : ""}`}
              >
                {mode === "day" ? dayTitle(d) : dayTitle(d, "short")}
              </div>
            ))}
            <div
              className="cal-grid__times"
              style={{ height: (bottom - top) * PPM }}
            >
              {hours.map((m) => (
                <span key={m} style={{ top: (m - top) * PPM }}>
                  {minutesLabel(m)}
                </span>
              ))}
            </div>
            {days.map((d) => {
              const wd = isoWeekday(d);
              return (
                <div
                  key={d}
                  className="cal-col"
                  style={{ height: (bottom - top) * PPM }}
                  data-day={d}
                >
                  {hours.map((m) => (
                    <div
                      key={m}
                      className="cal-col__hour"
                      style={{ top: (m - top) * PPM }}
                    />
                  ))}
                  {(view?.working_hours ?? [])
                    .filter((h) => h.weekday === wd)
                    .map((h) => (
                      <div
                        key={h.start_minute}
                        className="cal-col__open"
                        style={{
                          top: (h.start_minute - top) * PPM,
                          height: (h.end_minute - h.start_minute) * PPM,
                        }}
                      />
                    ))}
                  {blocksOn(d).map((b) => {
                    const s =
                      localDate(new Date(b.starts_at), tz) < d
                        ? top
                        : localMinutes(new Date(b.starts_at), tz);
                    const e =
                      localDate(new Date(b.ends_at), tz) > d
                        ? bottom
                        : localMinutes(new Date(b.ends_at), tz);
                    return (
                      <div
                        key={b.id}
                        className="cal-block"
                        style={{
                          top: (Math.max(s, top) - top) * PPM,
                          height:
                            Math.max(
                              0,
                              Math.min(e, bottom) - Math.max(s, top),
                            ) * PPM,
                        }}
                      >
                        <span>
                          {BLOCK_LABELS[b.reason_code] ?? "Unavailable"}
                        </span>
                      </div>
                    );
                  })}
                  {d === today &&
                    (() => {
                      const now = localMinutes(new Date(), tz);
                      return now >= top && now <= bottom ? (
                        <div
                          className="cal-now"
                          style={{ top: (now - top) * PPM }}
                          aria-hidden
                        />
                      ) : null;
                    })()}
                  {onDay(d).map((a) => {
                    const s = localMinutes(new Date(a.starts_at), tz);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className={`cal-appt status-${a.status.toLowerCase()}${selected?.appointment.id === a.id ? " is-selected" : ""}`}
                        style={{
                          top: (s - top) * PPM + 1,
                          height: Math.max(a.duration_minutes * PPM - 2, 18),
                        }}
                        onClick={() => open(a)}
                        aria-label={`${clock(a.starts_at, tz)}, ${patientName(a)}, ${STATUS_LABELS[a.status]}`}
                      >
                        <span className="cal-appt__time mono">
                          {clock(a.starts_at, tz)}
                        </span>
                        <span className="cal-appt__who">{patientName(a)}</span>
                        {a.duration_minutes >= 30 && (
                          <span className="cal-appt__meta">
                            {CHANNEL_LABELS[a.channel]} ·{" "}
                            {STATUS_LABELS[a.status]}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Agenda (phones) */}
          <div className="cal-agenda">
            {days.map((d) => (
              <section key={d} className="cal-agenda__day">
                <h3 className={d === today ? "is-today" : undefined}>
                  {dayTitle(d)}
                </h3>
                {onDay(d).length === 0 ? (
                  <p className="muted small">Nothing booked.</p>
                ) : (
                  <ol>
                    {onDay(d).map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          className={`cal-agenda__item status-${a.status.toLowerCase()}`}
                          onClick={() => open(a)}
                        >
                          <span className="mono">{clock(a.starts_at, tz)}</span>
                          <span className="cal-agenda__who">
                            {patientName(a)}
                          </span>
                          <span className={`state ${STATUS_CLASS[a.status]}`}>
                            {STATUS_LABELS[a.status]}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            ))}
          </div>
        </div>

        {selected && (
          <aside className="panel cal-detail" aria-labelledby="appt-title">
            <div className="panel__head">
              <h2 className="section-title" id="appt-title">
                {patientName(selected.appointment)}
              </h2>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setSelected(null)}
                aria-label="Close details"
              >
                Close
              </button>
            </div>
            <div className="panel__body">
              <p>
                <span
                  className={`state state--lg ${STATUS_CLASS[selected.appointment.status]}`}
                >
                  {STATUS_LABELS[selected.appointment.status]}
                </span>
              </p>
              <dl className="facts">
                <dt>When</dt>
                <dd>
                  {dayTitle(
                    localDate(new Date(selected.appointment.starts_at), tz),
                    "short",
                  )}
                  , {clock(selected.appointment.starts_at, tz)}–
                  {clock(selected.appointment.ends_at, tz)}
                </dd>
                <dt>Booked by</dt>
                <dd>{CHANNEL_LABELS[selected.appointment.channel]}</dd>
                {selected.appointment.patient?.date_of_birth && (
                  <>
                    <dt>Date of birth</dt>
                    <dd>
                      {selected.appointment.patient.date_of_birth}{" "}
                      <span className="muted">
                        (
                        {age(selected.appointment.patient.date_of_birth, today)}
                        )
                      </span>
                    </dd>
                  </>
                )}
                {selected.appointment.patient?.phone && (
                  <>
                    <dt>Phone</dt>
                    <dd>{selected.appointment.patient.phone}</dd>
                  </>
                )}
                {selected.appointment.reason && (
                  <>
                    <dt>Reason</dt>
                    <dd>{selected.appointment.reason}</dd>
                  </>
                )}
                {selected.appointment.referral_case_id && (
                  <>
                    <dt>Referral</dt>
                    <dd>
                      Booked from an ACCESS referral. The patient record is in
                      DTM.
                    </dd>
                  </>
                )}
              </dl>
              {selected.appointment.status === "CHECKED_IN" && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => complete(selected.appointment)}
                >
                  <Icon name="check" />
                  Mark seen
                </button>
              )}
              <h3 className="caps cal-detail__history">History</h3>
              <ol className="events">
                {selected.history.map((h, i) => (
                  <li key={i}>
                    <span>
                      {STATUS_LABELS[
                        h.to_status as keyof typeof STATUS_LABELS
                      ] ?? h.to_status}
                      {h.event_type === "RESCHEDULED"
                        ? " (moved to a new time)"
                        : ""}
                    </span>
                    <small>{stampIn(h.occurred_at, tz)}</small>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
