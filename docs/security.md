# Security assumptions and residual risks

Only synthetic data is permitted in this release. TLS is mandatory for managed
Postgres; production object storage must use workload identity, customer-approved
regional encryption keys, private networking, retention, and malware scanning.
The local AES key and `CLEAN` fixture scanner are development substitutes, not
production controls. Browser code has no database or Supabase service secret.

Forced RLS is defence in depth; application tenant headers must be derived from
verified workforce identity at the edge before production. Operator/support
access, break-glass audit, key rotation, deletion, evidence anchoring, backup
restore, dependency/container scans, DAST, penetration testing, and signed
execution grants remain release gates. The deterministic extractor is not a
clinical model. Urgent/clinical fixtures stop automation and open human safety
work. No autonomous merge or clinical triage exists.

## Runtime database boundary

The migration owner applies schema and provisioning but is never configured on
a runtime service. `access_request` and `access_worker` are distinct LOGIN roles,
are `NOINHERIT`, `NOSUPERUSER`, `NOBYPASSRLS`, own no application tables, and
receive separate URLs. Forced RLS uses transaction-local `app.tenant_id` for the
same direct-login execution model tested in PostgreSQL. Startup verifies role
identity and dangerous attributes without logging connection strings.

Browser-provided tenant context is available only when
`ALLOW_SYNTHETIC_TENANT_CONTEXT=true`. This is a conspicuous synthetic staging
bridge, not authentication; non-synthetic environments fail closed until signed
workforce claims are implemented.
