import React, { useState } from "react";
import { api, fileToBase64, newIds } from "../api";
import { label } from "../format";
import { useSession } from "../session";

const DOCUMENTS = [
  "referral_letter",
  "insurance",
  "demographics",
  "medical_aid_card",
  "identity_document",
  "consent_form",
];

/**
 * Staff intake: upload the referral document and key in the administrative
 * fields. Nothing here classifies clinical content; the safety flag routes the
 * case to a person.
 */
export function NewReferral({ open }: { open: (caseId: string) => void }) {
  const session = useSession();
  const synthetic =
    session.me?.data_mode === "SYNTHETIC" &&
    session.me.auth_mode === "synthetic";
  const [file, setFile] = useState<File | null>(null);
  const [fixture, setFixture] = useState("");
  const [f, setF] = useState<Record<string, string>>({});
  const [documents, setDocuments] = useState<string[]>(["referral_letter"]);
  const [safety, setSafety] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return setError("Choose the referral document");
    setBusy(true);
    setError("");
    try {
      const structured = fixture
        ? undefined
        : {
            patient: {
              given_name: f.given_name,
              family_name: f.family_name,
              date_of_birth: f.date_of_birth,
              ...(f.external_id ? { external_id: f.external_id } : {}),
            },
            referrer: { name: f.referrer },
            ...(f.requested_service
              ? { requested_service: f.requested_service }
              : {}),
            ...(f.referral_date ? { referral_date: f.referral_date } : {}),
            ...(f.funding_type
              ? {
                  funding: {
                    type: f.funding_type,
                    ...(f.scheme ? { scheme: f.scheme } : {}),
                  },
                }
              : {}),
            documents,
            safety_flag: safety,
          };
      const result = await api<{ case_id: string }>(
        session.headers,
        "/v1/referrals",
        {
          method: "POST",
          body: {
            ...newIds(),
            referral_id: crypto.randomUUID(),
            expected_version: 0,
            channel: "STAFF_UPLOAD",
            filename: file.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120),
            media_type:
              file.type === "application/pdf"
                ? "application/pdf"
                : "text/plain",
            content_base64: await fileToBase64(file),
            ...(fixture ? { fixture } : { structured }),
          },
        },
      );
      open(result.case_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel intake" onSubmit={submit}>
      <h2>New referral</h2>
      <label>
        Referral document (PDF or text, max 10 MB)
        <input
          type="file"
          accept="application/pdf,text/plain"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {synthetic && (
        <label>
          Synthetic fixture (development only)
          <select value={fixture} onChange={(e) => setFixture(e.target.value)}>
            <option value="">— enter fields below —</option>
            <option value="complete">complete</option>
            <option value="missing-insurance">missing-insurance</option>
            <option value="ambiguous-identity">ambiguous-identity</option>
            <option value="urgent">urgent</option>
          </select>
        </label>
      )}
      {!fixture && (
        <>
          <div className="grid">
            <label>
              Patient given name
              <input
                required
                value={f.given_name ?? ""}
                onChange={set("given_name")}
                autoComplete="off"
              />
            </label>
            <label>
              Patient family name
              <input
                required
                value={f.family_name ?? ""}
                onChange={set("family_name")}
                autoComplete="off"
              />
            </label>
            <label>
              Date of birth
              <input
                required
                type="date"
                value={f.date_of_birth ?? ""}
                onChange={set("date_of_birth")}
              />
            </label>
            <label>
              Patient record ID in the destination system (if matched)
              <input
                value={f.external_id ?? ""}
                onChange={set("external_id")}
                autoComplete="off"
              />
            </label>
            <label>
              Referring provider
              <input
                required
                value={f.referrer ?? ""}
                onChange={set("referrer")}
              />
            </label>
            <label>
              Requested service code
              <input
                value={f.requested_service ?? ""}
                onChange={set("requested_service")}
                placeholder="e.g. ORTHO_CONSULT"
                pattern="[A-Z0-9_]{2,64}"
              />
            </label>
            <label>
              Referral date
              <input
                type="date"
                value={f.referral_date ?? ""}
                onChange={set("referral_date")}
              />
            </label>
            <label>
              Funding
              <select
                value={f.funding_type ?? ""}
                onChange={set("funding_type")}
              >
                <option value="">Not recorded</option>
                <option value="MEDICAL_AID">Medical aid</option>
                <option value="SELF_PAY">Self pay</option>
                <option value="OTHER">Other</option>
              </select>
            </label>
            {f.funding_type === "MEDICAL_AID" && (
              <label>
                Medical aid scheme name
                <input value={f.scheme ?? ""} onChange={set("scheme")} />
              </label>
            )}
          </div>
          <fieldset>
            <legend>Documents received</legend>
            {DOCUMENTS.map((d) => (
              <label key={d} className="check">
                <input
                  type="checkbox"
                  checked={documents.includes(d)}
                  onChange={(e) =>
                    setDocuments(
                      e.target.checked
                        ? [...documents, d]
                        : documents.filter((x) => x !== d),
                    )
                  }
                />
                {label(d)}
              </label>
            ))}
          </fieldset>
          <label className="check warning">
            <input
              type="checkbox"
              checked={safety}
              onChange={(e) => setSafety(e.target.checked)}
            />
            This referral looks urgent or clinically concerning — route it to
            the clinical safety review (ACCESS will not process it)
          </label>
        </>
      )}
      <button disabled={busy}>
        {busy ? "Submitting…" : "Submit referral"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
