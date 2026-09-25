import React, { useEffect, useState } from "react";
import { api, newIds } from "../api";
import { when } from "../format";
import { useSession } from "../session";

/* eslint-disable @typescript-eslint/no-explicit-any -- rule sets are typed server-side */
export function Rules() {
  const session = useSession();
  const [sets, setSets] = useState<any[] | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState("");
  const load = () =>
    api<any[]>(session.headers, "/v1/rule-sets")
      .then(setSets)
      .catch((e: Error) => setMessage(e.message));
  useEffect(() => {
    void load();
  }, []);
  const admin = session.me?.role === "ADMIN";
  return (
    <section>
      <p className="muted small">
        Administrative rule sets are versioned and immutable once published.
        Every case records the version and hash it was decided under. Rule sets
        cannot express clinical triage, urgency or diagnosis.
      </p>
      {sets?.map((s) => (
        <details key={s.id} className="panel">
          <summary>
            <b>Version {s.version}</b> · {s.status} · effective{" "}
            {when(s.effective_from)} →{" "}
            {s.effective_to ? when(s.effective_to) : "open"} · published by{" "}
            {s.published_by ?? "—"} ·{" "}
            <code>{s.definition_hash.slice(0, 12)}</code>
            {s.status === "DRAFT" && admin && (
              <button
                className="secondary"
                onClick={async (e) => {
                  e.preventDefault();
                  try {
                    await api(
                      session.headers,
                      `/v1/rule-sets/${s.id}/publish`,
                      {
                        method: "POST",
                        body: { command_id: newIds().command_id },
                      },
                    );
                    await load();
                  } catch (err) {
                    setMessage((err as Error).message);
                  }
                }}
              >
                Publish now
              </button>
            )}
          </summary>
          <pre>{JSON.stringify(s.definition, null, 2)}</pre>
        </details>
      ))}
      {admin && (
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            setMessage("");
            try {
              await api(session.headers, "/v1/rule-sets", {
                method: "POST",
                body: {
                  command_id: newIds().command_id,
                  definition: JSON.parse(draft),
                },
              });
              setDraft("");
              await load();
            } catch (err) {
              setMessage((err as Error).message);
            }
          }}
        >
          <h3>New draft version</h3>
          <textarea
            rows={14}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste an access-rules.v1 definition (JSON)"
          />
          <button>Validate and save draft</button>
        </form>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
