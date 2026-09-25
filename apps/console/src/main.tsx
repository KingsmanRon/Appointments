import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { SessionProvider, useSession } from "./session";
import { CaseDetail } from "./views/CaseDetail";
import { Dashboard } from "./views/Dashboard";
import { Login } from "./views/Login";
import { NewReferral } from "./views/NewReferral";
import { Queue } from "./views/Queue";
import { Rules } from "./views/Rules";

type Route =
  | { page: "queue" | "dashboard" | "new" | "rules" }
  | { page: "case"; id: string };
function parse(hash: string): Route {
  const [page, id] = hash.replace(/^#\/?/, "").split("/");
  if (page === "case" && id) return { page: "case", id };
  if (page === "dashboard" || page === "new" || page === "rules")
    return { page };
  return { page: "queue" };
}

function Shell() {
  const session = useSession();
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (hash: string) => {
    location.hash = hash;
  };
  const me = session.me;
  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">ACCESS · REFERRAL OPERATIONS</p>
          <h1>Patient access console</h1>
        </div>
        {me && (
          <div className="whoami">
            <span
              className={
                me.data_mode === "REAL" ? "badge state-exception" : "badge"
              }
            >
              {me.data_mode === "REAL" ? "Real patient data" : "Synthetic data"}
            </span>
            <small>
              {me.role.replace(/_/g, " ").toLowerCase()} · {me.profile}
            </small>
            <button
              className="secondary"
              onClick={() => void session.signOut()}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      {!me ? (
        <Login />
      ) : (
        <>
          <nav className="tabs">
            {[
              ["#/queue", "Queue"],
              ["#/dashboard", "Dashboard"],
              ...(me.role !== "READ_ONLY" ? [["#/new", "New referral"]] : []),
              ["#/rules", "Rules"],
            ].map(([hash, text]) => (
              <a
                key={hash}
                href={hash}
                className={
                  location.hash.startsWith(hash!) ||
                  (hash === "#/queue" && route.page === "queue")
                    ? "active"
                    : ""
                }
              >
                {text}
              </a>
            ))}
          </nav>
          {route.page === "queue" && (
            <Queue open={(id) => go(`#/case/${id}`)} />
          )}
          {route.page === "case" && (
            <CaseDetail
              key={route.id}
              caseId={route.id}
              back={() => go("#/queue")}
            />
          )}
          {route.page === "dashboard" && <Dashboard />}
          {route.page === "new" && (
            <NewReferral open={(id) => go(`#/case/${id}`)} />
          )}
          {route.page === "rules" && <Rules />}
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <SessionProvider>
    <Shell />
  </SessionProvider>,
);
