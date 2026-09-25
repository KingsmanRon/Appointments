import React, { useCallback, useEffect, useState } from "react";
import { api, fileToBase64, newIds } from "../api";
import {
  duration,
  label,
  RESOLUTION_LABELS,
  STATE_LABELS,
  stateClass,
  when,
} from "../format";
import { useSession } from "../session";

/* eslint-disable @typescript-eslint/no-explicit-any -- the case view renders an API document */
type View = any;
const DOCUMENTS = [
  "referral_letter",
  "insurance",
  "demographics",
  "medical_aid_card",
  "identity_document",
  "consent_form",
  "prior_results",
];
const CLOSE_CODES = [
  "PATIENT_UNREACHABLE",
  "PATIENT_DECLINED",
  "PROVIDER_DECLINED",
  "DUPLICATE_REFERRAL",
  "INVALID_REFERRAL",
  "MISSING_INFORMATION",
  "REFERRED_ELSEWHERE",
  "CANCELLED",
  "UNKNOWN",
];

export function CaseDetail({
  caseId,
  back,
}: {
  caseId: string;
  back: () => void;
}) {
  const session = useSession();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      api<View>(session.headers, `/v1/cases/${caseId}`)
        .then(setView)
        .catch((e: Error) => setError(e.message)),
    [caseId, session.headers],
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (error) return <p role="alert">{error}</p>;
  if (!view) return <p className="muted">Loading…</p>;
  const c = view.case;
  const r = view.referral;
  const openItems = view.work_items.filter((w: any) => w.status === "OPEN");
  return (
    <section>
      <button className="link" onClick={back}>
        ← Back to queue
      </button>
      <header className="case-header panel">
        <div>
          <span className={stateClass(c.current_state)}>
            {STATE_LABELS[c.current_state]}
          </span>
          <h2>{c.display_ref}</h2>
          <p className="muted">
            Opened {when(c.opened_at)} · version {c.version} · owner{" "}
            {c.current_owner ?? "—"} · via {label(c.source_channel)}
          </p>
        </div>
        <div className="next-action">
          <small>Next required action</small>
          <strong>{view.next_action}</strong>
          {c.resolution_code && (
            <p>
              Outcome: <b>{RESOLUTION_LABELS[c.resolution_code]}</b> (
              {label(c.resolution_source)}, {when(c.outcome_at)})
            </p>
          )}
        </div>
      </header>
      <Actions view={view} onDone={load} />
      <div className="grid">
        <Panel title="Referral">
          {r ? (
            <dl>
              <dt>Patient</dt>
              <dd>
                {typeof r.extraction?.patient === "object"
                  ? `${r.extraction.patient.given_name} ${r.extraction.patient.family_name} · ${r.extraction.patient.date_of_birth} · ${r.extraction.patient.external_id ?? "no patient record ID"}`
                  : r.extraction
                    ? "Restricted for your role"
                    : "Not yet captured"}
              </dd>
              <dt>Referring provider</dt>
              <dd>{r.referring_provider ?? "—"}</dd>
              <dt>Requested service</dt>
              <dd>
                {r.requested_service ?? r.rule_decision?.service?.code ?? "—"}
              </dd>
              <dt>Identity</dt>
              <dd>
                {r.identity_status ?? "—"}
                {r.identity_confirmed_by && " (confirmed by staff)"}
              </dd>
              <dt>Completeness</dt>
              <dd>{label(r.completeness_status)}</dd>
              <dt>Documents</dt>
              <dd>
                {[
                  ...new Set([
                    ...(r.extraction?.documents ?? []),
                    ...(r.supplied_documents ?? []),
                  ]),
                ]
                  .map(label)
                  .join(", ") || "—"}
              </dd>
              <dt>Destination</dt>
              <dd>
                {r.destination_reference
                  ? `${r.destination_reference} (${r.destination_reference_source === "MANUAL" ? "manual entry" : "connector"})`
                  : `Not committed (${label(r.destination_mode ?? "unknown")} mode)`}
              </dd>
              {r.extraction?.provenance === "STAFF_ENTERED" && (
                <>
                  <dt>Field provenance</dt>
                  <dd>Entered by staff (human-attested)</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="muted">No referral details.</p>
          )}
        </Panel>
        <Panel title="Administrative rule decision">
          {r?.rule_decision ? (
            <dl>
              <dt>Rule set</dt>
              <dd>
                version {r.rule_set_version} ·{" "}
                <code>{r.rule_decision.definition_hash.slice(0, 12)}</code>
              </dd>
              <dt>Outcome</dt>
              <dd>{label(r.rule_decision.outcome)}</dd>
              <dt>Identity</dt>
              <dd>{label(r.rule_decision.identity.reason)}</dd>
              <dt>Missing</dt>
              <dd>
                {[
                  ...r.rule_decision.missing_documents,
                  ...r.rule_decision.missing_fields,
                  ...r.rule_decision.unmet_prerequisites,
                ]
                  .map(label)
                  .join(", ") || "Nothing"}
              </dd>
              <dt>Routing</dt>
              <dd>
                {r.rule_decision.routing
                  ? `${r.rule_decision.routing.destination_queue} ${r.rule_decision.routing.location ?? ""}`
                  : "Default"}
              </dd>
              <dt>Decision hash</dt>
              <dd>
                <code>{r.rule_decision.decision_hash.slice(0, 16)}</code>
              </dd>
            </dl>
          ) : (
            <p className="muted">
              No rule decision (held for review before evaluation).
            </p>
          )}
        </Panel>
        <Panel title={`Work items (${openItems.length} open)`}>
          {view.work_items.length === 0 && <p className="muted">None.</p>}
          {view.work_items.map((w: any) => (
            <article key={w.id}>
              <b>
                {label(w.kind)} · {w.status.toLowerCase()}
              </b>
              <p>{w.reason}</p>
              <small className="muted">
                owner {w.owner_role ?? "—"} · opened {when(w.created_at)}
                {w.resolved_at &&
                  ` · resolved ${when(w.resolved_at)} by ${w.resolved_by}`}
              </small>
            </article>
          ))}
        </Panel>
        <Panel title="Destination execution & reconciliation">
          {view.executions.length === 0 && (
            <p className="muted">No automated destination action.</p>
          )}
          {view.executions.map((x: any) => (
            <article key={x.id}>
              <b>
                {x.operation} · {x.status}
                {x.escalated_at && " (escalated to staff)"}
                {x.superseded_at &&
                  ` (settled by staff: ${label(x.superseded_reason)})`}
              </b>
              <p className="muted">
                execution {x.id.slice(0, 8)} · attempts {x.attempts} ·
                reconciliations {x.reconcile_attempts}
                {x.last_error && ` · ${x.last_error}`}
              </p>
            </article>
          ))}
        </Panel>
      </div>
      <Panel title="Business measures">
        <div className="measures">
          {Object.entries(view.metrics)
            .filter(([k]) => k !== "case_id")
            .map(([k, m]: [string, any]) => (
              <div key={k} className="measure">
                <small>{label(k)}</small>
                <strong>
                  {k.endsWith("_seconds")
                    ? duration(m.value)
                    : m.value === null
                      ? "Unknown"
                      : String(m.value)}
                </strong>
                <span className={`provenance ${m.provenance.toLowerCase()}`}>
                  {m.provenance}
                </span>
              </div>
            ))}
        </div>
      </Panel>
      <Timeline view={view} />
      <Panel
        title={`Evidence chain · ${view.evidence.verification.valid ? "verified" : "VERIFICATION FAILED"} · ${view.evidence.verification.events} events`}
      >
        {view.evidence.events.map((e: any) => (
          <article className="event" key={e.sequence}>
            <b>
              #{e.sequence} {label(e.event_type)}
            </b>
            <time>{when(e.created_at)}</time>
            <small>
              {e.actor_type ? `${label(e.actor_type)} ${e.actor_id}` : "legacy"}{" "}
              · v{e.aggregate_version} · <code>{e.hash.slice(0, 12)}</code>
            </small>
          </article>
        ))}
      </Panel>
    </section>
  );
}

function Timeline({ view }: { view: View }) {
  const entries = [
    ...view.interactions.map((i: any) => ({
      at: i.received_at,
      kind: "Interaction",
      text: `${label(i.intent)} via ${label(i.channel)} (${label(i.actor_type)})`,
    })),
    ...view.observations.map((o: any) => ({
      at: o.occurred_at,
      kind: "Observation",
      text: `${label(o.observation_type)} · ${label(o.source_type)} · ${o.verification_level.replace("_", "-").toLowerCase()} · ${o.disposition.toLowerCase()}${o.disposition_reason ? ` (${label(o.disposition_reason)})` : ""}`,
    })),
    ...view.transitions.map((t: any) => ({
      at: t.occurred_at,
      kind: "State",
      text: `${t.from_state ? STATE_LABELS[t.from_state] : "—"} → ${STATE_LABELS[t.to_state]} (${label(t.reason)}) by ${t.actor_id}`,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return (
    <Panel title="Timeline">
      {entries.map((e, i) => (
        <article className="event" key={i}>
          <b>
            {e.kind}: {e.text}
          </b>
          <time>{when(e.at)}</time>
        </article>
      ))}
    </Panel>
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

/** Staff actions available for the case's state and the user's role. */
function Actions({ view, onDone }: { view: View; onDone: () => void }) {
  const session = useSession();
  const role = session.me?.role ?? "READ_ONLY";
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [seconds, setSeconds] = useState("");
  const [extra, setExtra] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (role === "READ_ONLY")
    return (
      <p className="muted panel">Read-only access: no actions available.</p>
    );
  const c = view.case;
  const state: string = c.current_state;
  const items = view.work_items.filter((w: any) => w.status === "OPEN");
  const kinds = new Set(items.map((w: any) => w.kind));
  const reviewObservations = view.observations.filter(
    (o: any) => o.disposition === "REVIEW",
  );
  const available: [string, string][] = [];
  if (
    state === "IDENTITY_PENDING" ||
    (state === "EXCEPTION" && kinds.has("IDENTITY"))
  )
    available.push(["confirm_identity", "Confirm identity"]);
  if (
    ["IDENTITY_PENDING", "INFORMATION_MISSING", "EXCEPTION"].includes(state)
  ) {
    available.push(["provide_information", "Provide / confirm information"]);
    available.push(["upload", "Upload supplementary document"]);
  }
  if (
    (state === "READY" && view.referral?.destination_mode !== "CONNECTOR") ||
    (state === "EXCEPTION" &&
      (kinds.has("CONNECTOR") || kinds.has("MANUAL_DESTINATION")))
  )
    available.push([
      "record_destination_reference",
      "Record destination entry",
    ]);
  if (
    items.some(
      (w: any) =>
        w.kind !== "IDENTITY" &&
        w.kind !== "COMPLETENESS" &&
        w.kind !== "MANUAL_DESTINATION",
    )
  )
    available.push(["resolve_exception", "Resolve work item"]);
  if (["READY_FOR_BOOKING", "WAITING"].includes(state)) {
    available.push(["record_booking", "Record booking"]);
    available.push(["record_follow_up", "Record follow-up attempt"]);
    available.push(["record_patient_unreachable", "Patient unreachable"]);
    available.push(["record_patient_declined", "Patient declined"]);
    available.push(["record_provider_declined", "Provider declined"]);
  }
  if (
    ![
      "BOOKED",
      "CLOSED",
      "REJECTED",
      "DESTINATION_PENDING",
      "RECEIVED",
    ].includes(state)
  )
    available.push(["close", "Close with reason"]);
  if (["IDENTITY_PENDING", "INFORMATION_MISSING", "EXCEPTION"].includes(state))
    available.push(["reject", "Reject referral"]);
  if (
    ["BOOKED", "CLOSED"].includes(state) &&
    reviewObservations.length &&
    ["PRACTICE_MANAGER", "ADMIN"].includes(role)
  )
    available.push(["correct_outcome", "Correct outcome"]);
  available.push(["status_contact", "Record status enquiry"]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const base = {
        ...newIds(),
        note,
        ...(seconds ? { staff_seconds: Number(seconds) } : {}),
      };
      if (open === "status_contact")
        await api(session.headers, `/v1/cases/${c.id}/interactions`, {
          method: "POST",
          body: {
            ...newIds(),
            intent: "STATUS_ENQUIRY",
            actor_type: extra.actor_type ?? "PATIENT",
            note,
            ...(seconds ? { staff_seconds: Number(seconds) } : {}),
          },
        });
      else if (open === "upload") {
        const file: File | undefined = extra.file;
        if (!file) throw new Error("Choose a file");
        await api(session.headers, `/v1/cases/${c.id}/interactions`, {
          method: "POST",
          body: {
            ...newIds(),
            intent: "MISSING_INFORMATION",
            actor_type: extra.actor_type ?? "STAFF",
            expected_version: c.version,
            note,
            ...(seconds ? { staff_seconds: Number(seconds) } : {}),
            artifact: {
              filename: file.name
                .replace(/[^a-zA-Z0-9_.-]/g, "_")
                .slice(0, 120),
              media_type:
                file.type === "application/pdf"
                  ? "application/pdf"
                  : "text/plain",
              content_base64: await fileToBase64(file),
              document_types: extra.documents ?? [],
            },
          },
        });
      } else {
        const body: Record<string, unknown> = {
          action: open,
          ...base,
          expected_version: c.version,
        };
        if (open === "provide_information") {
          body.documents = extra.documents ?? [];
          const fields: Record<string, unknown> = {};
          if (extra.requested_service)
            fields.requested_service = extra.requested_service;
          if (extra.referral_date) fields.referral_date = extra.referral_date;
          if (extra.patient_external_id)
            fields.patient_external_id = extra.patient_external_id;
          if (Object.keys(fields).length) body.fields = fields;
        }
        if (open === "record_destination_reference")
          body.destination_reference = extra.destination_reference;
        if (open === "record_booking") {
          body.occurred_at = new Date(
            extra.occurred_at ?? Date.now(),
          ).toISOString();
          if (extra.appointment_reference)
            body.appointment_reference = extra.appointment_reference;
        }
        if (open === "close" || open === "reject")
          body.resolution_code = extra.resolution_code;
        if (open === "resolve_exception") {
          body.work_item_id = extra.work_item_id;
          body.resolution = extra.resolution;
          body.attest_not_committed = Boolean(extra.attest_not_committed);
        }
        if (open === "correct_outcome")
          body.observation_id = extra.observation_id;
        await api(session.headers, `/v1/cases/${c.id}/actions`, {
          method: "POST",
          body,
        });
      }
      setOpen(null);
      setNote("");
      setSeconds("");
      setExtra({});
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setExtra({ ...extra, [k]: e.target.value });
  const docs = (
    <fieldset>
      <legend>Documents now held</legend>
      {DOCUMENTS.map((d) => (
        <label key={d} className="check">
          <input
            type="checkbox"
            checked={(extra.documents ?? []).includes(d)}
            onChange={(e) =>
              setExtra({
                ...extra,
                documents: e.target.checked
                  ? [...(extra.documents ?? []), d]
                  : (extra.documents ?? []).filter((x: string) => x !== d),
              })
            }
          />
          {label(d)}
        </label>
      ))}
    </fieldset>
  );
  return (
    <section className="panel actions">
      <h3>Actions</h3>
      <p className="muted small">
        ACCESS records administrative decisions only. Clinical judgements stay
        with clinicians and are never made here.
      </p>
      <div className="row wrap">
        {available.map(([key, text]) => (
          <button
            key={key}
            className={open === key ? "chip active" : "chip"}
            onClick={() => setOpen(open === key ? null : key)}
          >
            {text}
          </button>
        ))}
      </div>
      {open && (
        <form onSubmit={submit} className="action-form">
          {open === "provide_information" && (
            <>
              {docs}
              <label>
                Patient record ID in destination system
                <input
                  value={extra.patient_external_id ?? ""}
                  onChange={set("patient_external_id")}
                />
              </label>
              <label>
                Requested service code
                <input
                  value={extra.requested_service ?? ""}
                  onChange={set("requested_service")}
                  placeholder="e.g. ORTHO_CONSULT"
                />
              </label>
              <label>
                Referral date
                <input
                  type="date"
                  value={extra.referral_date ?? ""}
                  onChange={set("referral_date")}
                />
              </label>
            </>
          )}
          {open === "upload" && (
            <>
              <label>
                File (PDF or text)
                <input
                  type="file"
                  accept="application/pdf,text/plain"
                  onChange={(e) =>
                    setExtra({ ...extra, file: e.target.files?.[0] })
                  }
                />
              </label>
              {docs}
              <label>
                Supplied by
                <select
                  value={extra.actor_type ?? "STAFF"}
                  onChange={set("actor_type")}
                >
                  <option value="STAFF">Staff</option>
                  <option value="PATIENT">Patient</option>
                  <option value="PROVIDER">Referring provider</option>
                </select>
              </label>
            </>
          )}
          {open === "status_contact" && (
            <label>
              Enquiry from
              <select
                value={extra.actor_type ?? "PATIENT"}
                onChange={set("actor_type")}
              >
                <option value="PATIENT">Patient</option>
                <option value="PROVIDER">Referring provider</option>
              </select>
            </label>
          )}
          {open === "record_destination_reference" && (
            <label>
              Reference in the destination system (after you entered the
              referral there)
              <input
                required
                value={extra.destination_reference ?? ""}
                onChange={set("destination_reference")}
              />
            </label>
          )}
          {open === "record_booking" && (
            <>
              <label>
                Appointment booked at (when the booking was made)
                <input
                  type="datetime-local"
                  step={1}
                  required
                  value={extra.occurred_at ?? ""}
                  onChange={set("occurred_at")}
                />
              </label>
              <label>
                Appointment reference (optional)
                <input
                  value={extra.appointment_reference ?? ""}
                  onChange={set("appointment_reference")}
                />
              </label>
            </>
          )}
          {(open === "close" || open === "reject") && (
            <label>
              Resolution code
              <select
                required
                value={extra.resolution_code ?? ""}
                onChange={set("resolution_code")}
              >
                <option value="" disabled>
                  Choose…
                </option>
                {(open === "reject"
                  ? ["INVALID_REFERRAL", "DUPLICATE_REFERRAL"]
                  : CLOSE_CODES
                ).map((code) => (
                  <option key={code} value={code}>
                    {RESOLUTION_LABELS[code]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {open === "resolve_exception" && (
            <>
              <label>
                Work item
                <select
                  required
                  value={extra.work_item_id ?? ""}
                  onChange={set("work_item_id")}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  {items.map((w: any) => (
                    <option key={w.id} value={w.id}>
                      {label(w.kind)}: {w.reason}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Resolution
                <select
                  required
                  value={extra.resolution ?? ""}
                  onChange={set("resolution")}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="safety_reviewed">
                    Safety review completed by clinician (hold released)
                  </option>
                  <option value="file_reviewed">Rejected file reviewed</option>
                  <option value="acknowledge">
                    Acknowledge (review, follow-up, escalation)
                  </option>
                  <option value="retry_destination">
                    Retry automated destination
                  </option>
                </select>
              </label>
              {extra.resolution === "retry_destination" && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(extra.attest_not_committed)}
                    onChange={(e) =>
                      setExtra({
                        ...extra,
                        attest_not_committed: e.target.checked,
                      })
                    }
                  />
                  I checked the destination system and this referral is NOT
                  already there
                </label>
              )}
            </>
          )}
          {open === "correct_outcome" && (
            <label>
              Observation that establishes the correct outcome
              <select
                required
                value={extra.observation_id ?? ""}
                onChange={set("observation_id")}
              >
                <option value="" disabled>
                  Choose…
                </option>
                {reviewObservations.map((o: any) => (
                  <option key={o.id} value={o.id}>
                    {label(o.observation_type)} · {label(o.source_type)} ·{" "}
                    {when(o.occurred_at)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Note (required)
            <textarea
              required
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />
          </label>
          <label>
            Handling time in seconds (optional; left blank it stays unknown)
            <input
              type="number"
              min={1}
              max={86400}
              value={seconds}
              onChange={(e) => setSeconds(e.target.value)}
            />
          </label>
          <button disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </section>
  );
}
