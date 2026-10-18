import React, { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { Icon } from "../components/Icon";
import { PageHeader } from "../layout/PageHeader";
import {
  addDays,
  CANCEL_REASONS,
  CHANNEL_LABELS,
  clock,
  dayTitle,
  isLive,
  localDate,
  localMinutes,
  patientName,
  STATUS_CLASS,
  STATUS_LABELS,
  type CalendarView,
  type Channel,
  type Practitioner,
  type ScheduledAppointment,
} from "../schedule";
import { useSession } from "../session";
import type { QueueItem } from "../types";

interface Slot {
  starts_at: string;
  ends_at: string;
}
const EMPTY_PATIENT = {
  given_name: "",
  family_name: "",
  date_of_birth: "",
  phone: "",
  identifier: "",
};
const DURATIONS = [15, 30, 45, 60];

/** A failure whose outcome is unknown: the same command can be sent again. */
const unclear = (e: unknown) => !(e instanceof ApiError) || e.status >= 500;

/**
 * Reception: book telephone calls, walk-ins and ready referrals into a
 * practitioner's own diary, and run the day (check in, did not attend, move,
 * cancel). Free times come from ACCESS; the database refuses double booking
 * even when two receptionists pick the same time.
 */
export function Reception() {
  const session = useSession();
  const headers = session.headers;
  const [practitioners, setPractitioners] = useState<Practitioner[] | null>(
    null,
  );
  const [pid, setPid] = useState("");
  const p = practitioners?.find((x) => x.id === pid) ?? null;
  const [date, setDate] = useState("");
  const [channel, setChannel] = useState<Channel>("TELEPHONE");
  const [duration, setDuration] = useState(15);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [patient, setPatient] = useState(EMPTY_PATIENT);
  const [referrals, setReferrals] = useState<QueueItem[] | null>(null);
  const [referral, setReferral] = useState("");
  const [reason, setReason] = useState("");
  const [day, setDay] = useState<CalendarView | null>(null);
  const [moving, setMoving] = useState<ScheduledAppointment | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("PATIENT_REQUEST");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // One command per attempt: resending after an unclear failure replays it
  // instead of booking twice. A new attempt starts when the inputs change.
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    api<Practitioner[]>(headers, "/v1/schedule/practitioners")
      .then((list) => {
        setPractitioners(list);
        const first = list.find((x) => x.active) ?? list[0];
        if (first) setPid(first.id);
      })
      .catch((e) => setError((e as Error).message));
    api<{ items: QueueItem[] }>(
      headers,
      "/v1/cases?filter=ready_for_booking&limit=100",
    )
      .then((r) =>
        setReferrals(r.items.filter((i) => i.case_type === "REFERRAL")),
      )
      .catch(() => setReferrals([]));
  }, [headers]);

  useEffect(() => {
    if (!p) return;
    setDate((d) => d || localDate(new Date(), p.timezone));
    setDuration(p.default_duration_minutes);
  }, [p]);

  const load = useCallback(async () => {
    if (!p || !date) return;
    const [free, cal] = await Promise.all([
      api<{ slots: Slot[] }>(
        headers,
        `/v1/schedule/practitioners/${p.id}/availability?from=${date}&to=${date}&duration_minutes=${moving?.duration_minutes ?? duration}`,
      ),
      api<CalendarView>(
        headers,
        `/v1/schedule/calendar?practitioner_id=${p.id}&from=${date}&to=${date}`,
      ),
    ]);
    setSlots(free.slots);
    setDay(cal);
  }, [p, date, duration, moving, headers]);
  useEffect(() => {
    setSlot(null);
    load().catch((e) => setError((e as Error).message));
  }, [load]);
  useEffect(
    () => setCommandId(crypto.randomUUID()),
    [pid, date, channel, duration, slot, patient, referral, reason],
  );

  const morning = useMemo(
    () =>
      (slots ?? []).filter(
        (s) => p && localMinutes(new Date(s.starts_at), p.timezone) < 720,
      ),
    [slots, p],
  );
  const afternoon = useMemo(
    () => (slots ?? []).filter((s) => !morning.includes(s)),
    [slots, morning],
  );

  const ready =
    !!p &&
    !!slot &&
    (channel === "REFERRAL"
      ? !!referral
      : patient.given_name.trim() !== "" &&
        patient.family_name.trim() !== "" &&
        (channel !== "TELEPHONE" || patient.phone.trim() !== ""));

  const book = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || !p || !slot) return;
    setBusy(true);
    setError("");
    setNotice("");
    const optional = (v: string) => (v.trim() ? v.trim() : undefined);
    const body =
      channel === "REFERRAL"
        ? {
            channel,
            referral_case_id: referral,
            phone: optional(patient.phone),
          }
        : {
            channel,
            patient: {
              given_name: patient.given_name.trim(),
              family_name: patient.family_name.trim(),
              date_of_birth: optional(patient.date_of_birth),
              phone: optional(patient.phone),
              identifier: optional(patient.identifier),
            },
          };
    try {
      const res = await api<{
        appointment: ScheduledAppointment;
        deduplicated: boolean;
      }>(headers, "/v1/schedule/appointments", {
        method: "POST",
        body: {
          ...body,
          command_id: commandId,
          practitioner_id: p.id,
          starts_at: slot,
          duration_minutes: duration,
          reason: optional(reason),
        },
      });
      setNotice(
        `Booked ${patientName(res.appointment)} with ${p.display_name}, ${dayTitle(date, "short")} at ${clock(res.appointment.starts_at, p.timezone)}.`,
      );
      setPatient(EMPTY_PATIENT);
      setReferral("");
      setReason("");
      setSlot(null);
      setCommandId(crypto.randomUUID());
      if (channel === "REFERRAL")
        setReferrals(
          (list) => list?.filter((r) => r.case_id !== referral) ?? null,
        );
      await load();
    } catch (err) {
      setError(
        unclear(err)
          ? "We could not confirm the booking. Press Book again: it will not book twice."
          : (err as Error).message,
      );
      if (err instanceof ApiError && err.code === "SLOT_UNAVAILABLE") {
        setSlot(null);
        await load().catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  };

  const change = async (
    a: ScheduledAppointment,
    body: Record<string, unknown>,
    done: string,
  ) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(headers, `/v1/schedule/appointments/${a.id}/actions`, {
        method: "POST",
        body: {
          command_id: crypto.randomUUID(),
          expected_version: a.version,
          ...body,
        },
      });
      setNotice(done);
      setMoving(null);
      setCancelling(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const pick = (s: Slot) => {
    if (moving && p)
      void change(
        moving,
        { action: "reschedule", starts_at: s.starts_at },
        `Moved ${patientName(moving)} to ${clock(s.starts_at, p.timezone)}.`,
      );
    else setSlot(s.starts_at);
  };
  const nextFree = () => {
    const now = Date.now();
    const first = (slots ?? []).find(
      (s) => new Date(s.ends_at).getTime() > now,
    );
    if (first) setSlot(first.starts_at);
  };
  const today = p ? localDate(new Date(), p.timezone) : "";
  const live = (day?.appointments ?? []).filter(
    (a) => a.status !== "RESCHEDULED",
  );

  if (practitioners && practitioners.length === 0)
    return (
      <>
        <PageHeader title="Reception" />
        <div className="panel empty">
          <strong>No practitioner is set up yet.</strong>
          <span>
            A practice manager adds the doctor and their working hours first.
          </span>
        </div>
      </>
    );

  return (
    <>
      <PageHeader
        title="Reception"
        context="Book telephone calls, walk-ins and referrals into the doctor's own diary."
        actions={
          practitioners && practitioners.length > 1 ? (
            <div className="field field--inline">
              <label htmlFor="practitioner">Doctor</label>
              <select
                id="practitioner"
                value={pid}
                onChange={(e) => setPid(e.target.value)}
              >
                {practitioners.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.display_name}
                  </option>
                ))}
              </select>
            </div>
          ) : null
        }
      />
      {error && (
        <p className="alert" role="alert">
          <Icon name="alert" />
          {error}
        </p>
      )}
      {notice && (
        <p className="note sched-notice" role="status">
          <Icon name="check" />
          {notice}
        </p>
      )}
      <div className="reception">
        <form
          className="panel reception__book"
          onSubmit={book}
          aria-labelledby="book-title"
        >
          <div className="panel__head">
            <h2 className="section-title" id="book-title">
              {moving ? `Move ${patientName(moving)}` : "New appointment"}
            </h2>
            {p && <span className="muted small">{p.display_name}</span>}
          </div>
          <div className="panel__body reception__fields">
            {moving ? (
              <p className="note">
                Choose a new time below. {patientName(moving)} keeps their place
                until the new time is confirmed.{" "}
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => setMoving(null)}
                >
                  Keep the current time
                </button>
              </p>
            ) : (
              <fieldset className="seg" aria-label="How the patient reached us">
                {(Object.keys(CHANNEL_LABELS) as Channel[]).map((c) => (
                  <label
                    key={c}
                    className={`seg__option${channel === c ? " is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="channel"
                      value={c}
                      checked={channel === c}
                      onChange={() => setChannel(c)}
                    />
                    {CHANNEL_LABELS[c]}
                  </label>
                ))}
              </fieldset>
            )}

            <div className="reception__when">
              <div className="field">
                <label htmlFor="book-date">Day</label>
                <div className="day-step">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    aria-label="Previous day"
                    onClick={() => setDate(addDays(date, -1))}
                    disabled={!date || date <= today}
                  >
                    <Icon name="back" />
                  </button>
                  <input
                    id="book-date"
                    type="date"
                    value={date}
                    min={today}
                    onChange={(e) => e.target.value && setDate(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary day-step__next"
                    aria-label="Next day"
                    onClick={() => setDate(addDays(date, 1))}
                    disabled={!date}
                  >
                    <Icon name="back" />
                  </button>
                </div>
              </div>
              {!moving && (
                <div className="field">
                  <label htmlFor="book-duration">Length</label>
                  <select
                    id="book-duration"
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                  >
                    {DURATIONS.map((d) => (
                      <option key={d} value={d}>
                        {d} minutes
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="field">
              <div className="slots__head">
                <span className="caps" id="slots-label">
                  Free times {date && `· ${dayTitle(date, "short")}`}
                </span>
                {channel === "WALK_IN" && !moving && date === today && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={nextFree}
                  >
                    Next free time
                  </button>
                )}
              </div>
              {slots === null ? (
                <p className="muted small">Loading free times…</p>
              ) : slots.length === 0 ? (
                <p className="muted small">
                  No free time on this day. Try another day.
                </p>
              ) : (
                <div
                  className="slots"
                  role="group"
                  aria-labelledby="slots-label"
                >
                  {[morning, afternoon].map((group, i) =>
                    group.length ? (
                      <div key={i} className="slots__group">
                        <span className="slots__part">
                          {i === 0 ? "Morning" : "Afternoon"}
                        </span>
                        <div className="slots__grid">
                          {group.map((s) => (
                            <button
                              key={s.starts_at}
                              type="button"
                              className={`slot${slot === s.starts_at ? " is-on" : ""}`}
                              aria-pressed={slot === s.starts_at}
                              onClick={() => pick(s)}
                              disabled={busy}
                            >
                              {p && clock(s.starts_at, p.timezone)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null,
                  )}
                </div>
              )}
            </div>

            {!moving && channel === "REFERRAL" && (
              <div className="field">
                <label htmlFor="book-referral">
                  Referral ready for booking
                </label>
                <select
                  id="book-referral"
                  value={referral}
                  onChange={(e) => setReferral(e.target.value)}
                >
                  <option value="">Choose a referral…</option>
                  {(referrals ?? []).map((r) => (
                    <option key={r.case_id} value={r.case_id}>
                      {r.display_ref}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  The patient's details come from the referral. No referral is
                  needed for a call or a walk-in.
                </span>
              </div>
            )}
            {!moving && channel !== "REFERRAL" && (
              <div className="reception__patient">
                <div className="field">
                  <label htmlFor="p-given">First name</label>
                  <input
                    id="p-given"
                    autoComplete="off"
                    value={patient.given_name}
                    onChange={(e) =>
                      setPatient({ ...patient, given_name: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="p-family">Surname</label>
                  <input
                    id="p-family"
                    autoComplete="off"
                    value={patient.family_name}
                    onChange={(e) =>
                      setPatient({ ...patient, family_name: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="p-dob">
                    Date of birth <span className="optional">optional</span>
                  </label>
                  <input
                    id="p-dob"
                    type="date"
                    value={patient.date_of_birth}
                    onChange={(e) =>
                      setPatient({ ...patient, date_of_birth: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="p-phone">
                    Phone{" "}
                    {channel !== "TELEPHONE" && (
                      <span className="optional">optional</span>
                    )}
                  </label>
                  <input
                    id="p-phone"
                    type="tel"
                    autoComplete="off"
                    value={patient.phone}
                    onChange={(e) =>
                      setPatient({ ...patient, phone: e.target.value })
                    }
                  />
                </div>
                <div className="field">
                  <label htmlFor="p-id">
                    ID or passport <span className="optional">optional</span>
                  </label>
                  <input
                    id="p-id"
                    autoComplete="off"
                    value={patient.identifier}
                    onChange={(e) =>
                      setPatient({ ...patient, identifier: e.target.value })
                    }
                  />
                </div>
              </div>
            )}
            {!moving && channel === "REFERRAL" && (
              <div className="field">
                <label htmlFor="p-phone-ref">
                  Phone <span className="optional">optional</span>
                </label>
                <input
                  id="p-phone-ref"
                  type="tel"
                  value={patient.phone}
                  onChange={(e) =>
                    setPatient({ ...patient, phone: e.target.value })
                  }
                />
              </div>
            )}
            {!moving && (
              <div className="field">
                <label htmlFor="book-reason">
                  Reason for the visit{" "}
                  <span className="optional">optional</span>
                </label>
                <input
                  id="book-reason"
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            )}
            {!moving && (
              <div className="reception__submit">
                <button className="btn btn-lg" disabled={!ready || busy}>
                  {busy
                    ? "Booking…"
                    : slot && p
                      ? `Book ${clock(slot, p.timezone)}`
                      : "Book"}
                </button>
                {!slot && (
                  <span className="muted small">Choose a free time.</span>
                )}
              </div>
            )}
          </div>
        </form>

        <section className="panel reception__day" aria-labelledby="day-title">
          <div className="panel__head">
            <h2 className="section-title" id="day-title">
              {p ? p.display_name : "Diary"} · {date ? dayTitle(date) : ""}
            </h2>
            <a className="btn btn-quiet" href="#/calendar">
              Calendar
            </a>
          </div>
          <div className="panel__body">
            {live.length === 0 ? (
              <p className="muted">Nobody is booked on this day yet.</p>
            ) : (
              <ol className="day-list">
                {live.map((a) => {
                  const due = Date.now() >= new Date(a.starts_at).getTime();
                  return (
                    <li
                      key={a.id}
                      className={`day-list__item status-${a.status.toLowerCase()}`}
                    >
                      <span className="day-list__time mono">
                        {p && clock(a.starts_at, p.timezone)}
                      </span>
                      <div className="day-list__who">
                        <strong>{patientName(a)}</strong>
                        <span className="muted small">
                          {CHANNEL_LABELS[a.channel]} · {a.duration_minutes} min
                          {a.patient?.phone ? ` · ${a.patient.phone}` : ""}
                        </span>
                      </div>
                      <span className={`state ${STATUS_CLASS[a.status]}`}>
                        {STATUS_LABELS[a.status]}
                      </span>
                      {cancelling === a.id ? (
                        <div className="day-list__actions">
                          <label className="sr-only" htmlFor={`cancel-${a.id}`}>
                            Reason
                          </label>
                          <select
                            id={`cancel-${a.id}`}
                            value={cancelReason}
                            onChange={(e) => setCancelReason(e.target.value)}
                          >
                            {CANCEL_REASONS.map(([code, text]) => (
                              <option key={code} value={code}>
                                {text}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn-danger"
                            disabled={busy}
                            onClick={() =>
                              change(
                                a,
                                { action: "cancel", reason_code: cancelReason },
                                `Cancelled ${patientName(a)}.`,
                              )
                            }
                          >
                            Cancel appointment
                          </button>
                          <button
                            type="button"
                            className="btn btn-quiet"
                            onClick={() => setCancelling(null)}
                          >
                            Keep
                          </button>
                        </div>
                      ) : (
                        isLive(a.status) && (
                          <div className="day-list__actions">
                            {a.status === "BOOKED" && (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                disabled={busy}
                                onClick={() =>
                                  change(
                                    a,
                                    { action: "check_in" },
                                    `${patientName(a)} has arrived.`,
                                  )
                                }
                              >
                                Check in
                              </button>
                            )}
                            {a.status === "BOOKED" && due && (
                              <button
                                type="button"
                                className="btn btn-quiet"
                                disabled={busy}
                                onClick={() =>
                                  change(
                                    a,
                                    { action: "no_show" },
                                    `${patientName(a)} did not attend.`,
                                  )
                                }
                              >
                                Did not attend
                              </button>
                            )}
                            {a.status === "BOOKED" && (
                              <button
                                type="button"
                                className="btn btn-quiet"
                                disabled={busy}
                                onClick={() => setMoving(a)}
                              >
                                Move
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-quiet"
                              disabled={busy}
                              onClick={() => setCancelling(a.id)}
                            >
                              Cancel
                            </button>
                          </div>
                        )
                      )}
                      {a.status === "NO_SHOW" && (
                        <div className="day-list__actions">
                          <button
                            type="button"
                            className="btn btn-quiet"
                            disabled={busy}
                            onClick={() =>
                              change(
                                a,
                                { action: "check_in" },
                                `${patientName(a)} arrived late.`,
                              )
                            }
                          >
                            Arrived late
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
