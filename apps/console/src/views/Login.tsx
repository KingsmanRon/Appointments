import React, { useState } from "react";
import { AUTH_MODE, supabaseClient, useSession, type Me } from "../session";

export function Login() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [tenant, setTenant] = useState("11111111-1111-4111-8111-111111111111");
  const [role, setRole] = useState<Me["role"]>("REFERRAL_COORDINATOR");
  const [user, setUser] = useState("coordinator");

  if (AUTH_MODE === "synthetic")
    return (
      <section className="panel narrow">
        <p className="warning">
          Synthetic development mode. Tenant and role are asserted by the
          browser and are refused by client-pilot and production deployments.
          Use synthetic data only.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            session.signInSynthetic({ tenant, role, user });
          }}
        >
          <label>
            Organisation (tenant) ID
            <input value={tenant} onChange={(e) => setTenant(e.target.value)} />
          </label>
          <label>
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Me["role"])}
            >
              <option>REFERRAL_COORDINATOR</option>
              <option>PRACTICE_MANAGER</option>
              <option>ADMIN</option>
              <option>READ_ONLY</option>
            </select>
          </label>
          <label>
            Staff name (synthetic)
            <input value={user} onChange={(e) => setUser(e.target.value)} />
          </label>
          <button>Enter console</button>
        </form>
        {session.error && <p role="alert">{session.error}</p>}
      </section>
    );

  return (
    <section className="panel narrow">
      <h2>Staff sign in</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage("");
          const { error } = await supabaseClient().auth.signInWithPassword({
            email,
            password,
          });
          if (error)
            setMessage("Sign-in failed. Check your email and password.");
          else await session.refresh();
        }}
      >
        <label>
          Work email
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <div className="row">
          <button>Sign in</button>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              const { error } = await supabaseClient().auth.signInWithOtp({
                email,
                options: { shouldCreateUser: false },
              });
              setMessage(
                error
                  ? "Could not send a sign-in link."
                  : "Check your email for a sign-in link.",
              );
            }}
          >
            Email me a sign-in link
          </button>
        </div>
      </form>
      {message && <p role="status">{message}</p>}
      {session.error === "TENANT_SELECTION_REQUIRED" && <TenantPicker />}
      {session.error && session.error !== "TENANT_SELECTION_REQUIRED" && (
        <p role="alert">{session.error}</p>
      )}
    </section>
  );
}

function TenantPicker() {
  const session = useSession();
  const [value, setValue] = useState("");
  return (
    <form
      className="tenant-picker"
      onSubmit={(e) => {
        e.preventDefault();
        session.selectTenant(value.trim());
      }}
    >
      <p>
        You belong to more than one organisation. Enter the organisation ID to
        work in.
      </p>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Organisation ID"
      />
      <button>Continue</button>
    </form>
  );
}
