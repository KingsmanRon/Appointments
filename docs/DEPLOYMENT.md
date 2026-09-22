# ACCESS v1.1 deployment specification

Status: implementation baseline. This document specifies the target configuration; it does not claim that accounts, credentials, deployments or production controls already exist.

## 1. Platform allocation

1. **Supabase:** managed PostgreSQL, staff authentication and private document Storage. Domain tables live in an unexposed schema. The browser does not query domain tables through the Data API.
2. **Vercel:** the Next.js staff console and Supabase authentication callback/session handling. Domain reads and commands go from the browser to the Railway core API with the Supabase access token in the `Authorization` header.
3. **Railway core API:** a Fastify modular monolith. It verifies identity, checks current organisation membership, authorises commands and commits domain changes plus the outbox in one database transaction.
4. **Railway worker:** the same core image with a separate worker entrypoint. It polls durable PostgreSQL work, processes documents, starts authorised executions and reconciles results. Disable Railway Serverless sleeping for this service.
5. **Railway connector:** an isolated runtime with its own image and narrowly distributed credentials. Implement the DTM connector first, plus a fault injection mock. Manual completion remains a core workflow. The connector receives authenticated execution requests and returns observations; it cannot mutate domain tables.

Do not introduce Redis, Kafka, a second database, Supabase Edge Functions or a remote model dependency for v1. PostgreSQL is the durable work queue. Use bounded polling in the staff console initially; realtime subscriptions are optional later.

Railway private networking isolates project environments and encrypts service traffic. It does not constitute a fine grained egress firewall or per service application authorisation. Only the API gets a public domain; the worker and connector receive no public domain. Authenticate internal calls even over the private network. [Railway private networking](https://docs.railway.com/networking/private-networking)

## 2. Environments and regions

Create separate staging and production Supabase projects and Railway environments, with separate Vercel environment values. Do not give Vercel previews production credentials or permission to use production API origins. Development and automated tests use synthetic records and isolated local resources or the staging project.

Choose the nearest suitable common operating geography supported by the actual Supabase and Railway projects, then place Vercel server functions nearby. Record the selected region identifiers in the deployment manifest before provisioning. No country residency promise follows from this design: Auth, Storage delivery, logs, backups and support access must be evaluated against the selected services and agreements before using actual patient data.

Only explicitly allowlisted Vercel origins may call the staging API. Use a stable staging domain or add a specific preview origin through controlled configuration. Never allow every `vercel.app` origin. Production allows only the production console origin.

## 3. Staff authentication and API authorisation

Use Supabase Auth with invitation only staff accounts. Disable anonymous sign in and public registration. Use password authentication with verified email and TOTP MFA; require `aal2` for production patient data access and external execution approval. Configure an approved SMTP sender and exact redirect URLs before enabling invitations.

Use asymmetric project signing keys, with ES256 as the v1 configured algorithm. The API uses a maintained JWT library such as `jose` and verifies all of the following:

* Signature using the environment's configured JWKS endpoint.
* Exact issuer `${SUPABASE_URL}/auth/v1`, audience `authenticated`, configured algorithm, expiry, subject UUID and session identifier.
* The subject has an active membership in the requested organisation and the current session is not locally revoked for that organisation.
* The requested action is allowed by the current membership role, with a fresh database check for every command and document access request.

Configure the issuer and JWKS URL from trusted environment settings, never from token claims. The endpoint is `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. Cache keys within the documented rotation window and retry discovery once for an unknown key identifier. Fail closed if verification cannot be completed. Do not use unverified session data, `user_metadata` or a client supplied organisation claim for authorisation. [Supabase JWT verification](https://supabase.com/docs/guides/auth/jwts)

The database membership check makes ACCESS membership revocation effective at the next request. Access token signature validation alone does not establish immediate Supabase session revocation. For execution approval and execution start, also require that the persisted approving subject/session has not been locally disabled or revoked. Use tenant scoped access.session_revocations, updated under that tenant's authority guard. Staff sign out revokes that local session in each configured tenant membership before Supabase sign out; emergency account suspension disables the subject's memberships in each configured tenant. Keep the configured access token lifetime at 10 minutes. Document the maximum remaining exposure for an Auth session revoked outside ACCESS; do not claim immediate remote session revocation.

The Next.js server client uses `@supabase/ssr` with the documented cookie refresh pattern. Server code must verify claims or call the Auth service before trusting identity. Domain API responses use `Cache-Control: no-store`. Do not cache personalised pages or responses in a shared CDN cache. The browser supplies bearer credentials to Railway with `credentials: omit`; Railway never relies on the Vercel session cookie. Enforce a restrictive Content Security Policy and protect any cookie based authentication endpoints from CSRF. [Supabase SSR client guidance](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs)

## 4. Database connections and tenant boundary

Routine application work uses genuine per organisation PostgreSQL LOGIN identities with no superuser, ownership, `BYPASSRLS`, role creation or cross tenant role membership. The database binds `session_user` to exactly one organisation using the protected principal registry defined in the database specification. A caller supplied setting such as `app.current_org_id` is not the tenant security boundary.

The API validates the JWT, selects a candidate tenant pool from its fixed private configuration, verifies its database principal mapping, then checks the verified subject's current membership inside that tenant scope before returning data or accepting a command. Selection alone grants no access. Workers poll each configured organisation through its tenant connection; there is no unrestricted worker database connection or separate identity database. The connector holds no PostgreSQL credentials. Verify `session_user`, `current_user`, row security behaviour and inability to alter the registry using actual LOGIN sessions in staging.

Default pool budget per core process: one persistent connection per active tenant, at most 10 open tenant connections, idle eviction after 60 seconds, and bounded waiting when the budget is full. API and worker budgets are separate. Set the total configured budget below the project's verified available database connection limit, reserving capacity for Supabase services, migration and administration. Replicas multiply the budget; recalculate before increasing replicas.

Use direct PostgreSQL TLS connections for Railway where supported. Use the Supabase shared session pooler as the verified IPv4 fallback. Obtain actual connection strings from the project dashboard. Verify custom role usernames and `session_user` behaviour on the selected endpoint. Do not substitute transaction pooling into this design. Native PostgreSQL migration and restore operations prefer the direct endpoint. [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)

Use short transactions and row locks for command commit, claiming work and execution start. Commit before any HTTP call. A worker lease is an operational coordination mechanism, not proof that an earlier execution has stopped. Runtime processes receive no migration owner credentials.

Keep the application schema out of the Data API exposed schema list. Explicitly revoke unnecessary grants from `PUBLIC`, `anon`, `authenticated` and `service_role`; do not assume project defaults. Enable and force RLS on tenant domain tables. Restrict default privileges and functions in migrations. Supabase Auth and Storage remain available without exposing ACCESS domain tables. [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api)

## 5. Private document upload and extraction

V1 accepts PDF, PNG and JPEG, at most **20 MiB**, equivalent to 20,971,520 bytes per file. Reject archives, executable content, encrypted PDFs and unsupported file types. Limit PDFs to 100 pages and rendered images to 40 megapixels per page. These are product limits enforced server side, not assurances derived from file extensions.

1. The browser requests an upload intent from the API with organisation, claimed MIME type, declared byte length and SHA256 of the file. The API verifies membership, quota and limits, then allocates an unpredictable path under the organisation and document identifiers.
2. The API mints a signed upload token for that exact path in a private quarantine bucket with replacement disabled. Never accept an arbitrary client path or bucket. The token is a bearer capability and must be excluded from logs, analytics and error traces.
3. The browser uploads directly to Supabase Storage. Use signed resumable TUS upload for files above 6 MiB and for unreliable connections; use the pinned client and documented signed token mechanism. No document body passes through Vercel. Vercel Functions currently impose a 4.5 MB request and response payload limit. [Vercel function limits](https://vercel.com/docs/functions/limitations), [Supabase resumable uploads](https://supabase.com/docs/guides/storage/uploads/resumable-uploads)
4. The browser calls finalise with the upload intent identifier. Finalise checks the exact stored object, uploader, organisation, declared size, allowed content type and expiry. It queues server verification; it does not immediately mark the document safe.
5. The worker streams the stored bytes into a restricted processing directory, calculates its own SHA256, checks signature/MIME and size, and compares them with the intent. It scans for malware with ClamAV and rejects PDF active content, embedded files, launch actions and malformed structures. It enforces CPU, memory, page, pixel and time limits while parsing. A scan error or stale/unavailable malware definitions leaves the object quarantined.
6. Only after successful validation and scanning does the worker copy the verified bytes to an immutable path in a separate private accepted bucket, verify the copied digest and mark the document available. The accepted object is never overwritten. The upload intent cannot be finalised twice into different content. Record parser, scanner and definition versions with the result.
7. Local PDF text extraction and Tesseract OCR generate candidate fields with source page references. A staff member verifies critical identity fields and resolves uncertainty before patient lookup, linking or creation. No remote model receives patient data in v1. Image previews are rendered from validated content; documents are never interpreted as executable instructions.

Use a 30 minute application acceptance window for upload intents. Supabase documents signed upload URLs as valid for two hours and resumable upload URLs as valid for up to 24 hours. The application acceptance deadline does not revoke an already issued capability. A late upload remains quarantined and is never processed. Reap abandoned objects only after the maximum provider upload/session lifetime plus a safety margin, default 48 hours. Keep quarantined objects inaccessible to ordinary staff. Record the pinned SDK's actual signed token and resumable behaviour in integration tests. [Supabase signed upload URLs](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl)

Set bucket MIME and file size restrictions as a second layer. No direct `anon` or `authenticated` listing, read, replacement or deletion access is granted on either bucket. The core provides authorised signed download URLs for accepted objects with a 60 second lifetime. Never include patient names or identifiers in object paths. Download access is audited. A signed download URL remains usable until its own expiry, even if membership changes afterwards.

The API and document worker need a Supabase backend secret for Storage administration. This key is broadly privileged at project level; it is **not** a per tenant Storage key. Keep it inside a dedicated Storage client module, use it only for fixed bucket operations, and never use it for routine domain database queries. It must not appear in Vercel, the connector or browser code. This deliberate v1 trust boundary requires review and cross tenant object tests. A separate Storage broker service can reduce process exposure later.

## 6. Railway runtime settings

* Core API: one initial replica; public TLS ingress; listen on the Railway `PORT`; readiness endpoint `/health/ready`; liveness endpoint `/health/live`; request body limit 1 MiB for JSON; external execution occurs asynchronously.
* Core worker: one initial replica; Serverless disabled; poll every 2 seconds with jitter; claim batches of at most 10; maximum two concurrent external executions and one OCR job initially. Keep execution heartbeat and reconciliation polling separate from OCR work.
* Connector: one initial replica; private network only; separate DTM credentials per environment and organisation; no Storage backend secret and no domain database credential. A short lived document URL may be provided only for an authorised attachment action.
* Shutdown: on termination, stop claiming new work, persist available results, allow a bounded 30 second drain, and leave unresolved attempts for reconciliation. Never mark an in flight external action failed solely because shutdown began.
* Health: readiness checks compatible database schema and required configuration; it does not perform a live PMS write. Emit worker heartbeat and work age metrics. Configure an independent uptime monitor because deploy healthchecks are not the full runtime monitoring strategy.

Railway Serverless can sleep an inactive service and introduce cold start failures; the worker must remain running to poll durable work. [Railway Serverless behaviour](https://docs.railway.com/deployments/serverless)

Authenticate worker to connector calls using a dedicated signing key. Bind a signed envelope to issuer, connector audience, organisation, execution identifier, action digest, request body digest, attempt identifier and a 60 second expiry. The connector verifies the signature and the configured organisation/destination. Replayed requests must recover the existing execution outcome rather than repeat the external effect. Authenticating the envelope does not replace the connector idempotency contract.

## 7. Environment variable ownership

The builder supplies `.env.example` files containing names and placeholders only. Validate configuration at startup, fail with the missing variable names and never print values.

### Browser and Vercel

* `NEXT_PUBLIC_SUPABASE_URL`: public environment project URL.
* `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: public publishable key; this is not a backend secret.
* `NEXT_PUBLIC_CORE_API_URL`: public Railway API base URL.
* `APP_ORIGIN`: exact console origin for authentication callbacks.

Vercel receives no domain database password, Storage backend secret, connector credential, migration connection or execution signing key. Preview and Production values are independent; public build values require rebuilding the matching frontend artefact.

### Core API and worker

* `APP_ENV`: `development`, `staging` or `production`.
* `RELEASE_SHA`: immutable build revision.
* `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_AUDIENCE`, `SUPABASE_JWT_ALGORITHM`: trusted authentication configuration.
* `TENANT_DATABASE_CREDENTIALS`: private JSON map of configured organisation identifiers to their actual tenant LOGIN connection strings. Load only on the core services; redact the entire value. Start with a small explicit tenant set and bounded pools.
* `DB_POOL_GLOBAL_MAX`, `DB_POOL_TENANT_MAX`: default `10` and `1` per process.
* `STORAGE_BACKEND_SECRET`: secret API key used only by the Storage module.
* `STORAGE_QUARANTINE_BUCKET`, `STORAGE_ACCEPTED_BUCKET`: fixed private bucket identifiers.
* `ALLOWED_ORIGINS`: exact API CORS allowlist; API only.
* `CONNECTOR_BASE_URL`, `CONNECTOR_AUDIENCE`, `DISPATCH_SIGNING_PRIVATE_KEY`, `DISPATCH_SIGNING_KEY_ID`: worker only; authenticates notifications sent to the connector.
* `CONNECTOR_VERIFY_PUBLIC_KEYS`, `CONNECTOR_TOKEN_ISSUER`, `CORE_INTERNAL_AUDIENCE`: API only; trusted connector keys with fixed tenant and executor assignments for start and observation commands.
* `IDENTITY_HMAC_KEYS_BY_ORGANISATION`: private tenant to versioned key map for identifier lookups; do not log raw identifiers, share keys across tenants or derive lookups with an unkeyed hash.
* `EXTRACTION_MODE`: fixed to `local` for v1.
* `EXECUTION_ENABLED`: defaults to `false` until target environment contract tests pass.
* `REAL_PATIENT_DATA_ENABLED`: defaults to `false`; startup requires completed deployment acceptance evidence before this is set to `true` in production.

### Connector

* `CONNECTOR_INSTANCE_ID`, `CONNECTOR_AUDIENCE`, `DISPATCH_VERIFY_PUBLIC_KEYS`: verify incoming worker notifications and fixed allowed assignments.
* `CORE_INTERNAL_API_URL`, `CORE_INTERNAL_AUDIENCE`, `CONNECTOR_TOKEN_ISSUER`, `CONNECTOR_SIGNING_PRIVATE_KEY`, `CONNECTOR_SIGNING_KEY_ID`: authenticate connector start and observation commands to the core; keys never reach Vercel.
* `DTM_BASE_URL`, `DTM_CREDENTIALS_BY_ORGANISATION`: destination endpoints and least privilege credentials, loaded only in the DTM runtime.
* `DTM_CAPABILITY_MANIFEST`: versioned verified capabilities including deduplication scope, retention and reconciliation behaviour. Do not set these from assumptions.
* `CONNECTOR_MODE`: `mock` or `dtm`; production mock mode must be visibly identified and cannot produce a genuine completed external action.

### Migration and platform administration

* `MIGRATION_DATABASE_URL`: privileged connection available only to the serialised migration job.
* Supabase management token, Vercel deployment credentials and Railway deployment credentials belong only to the deployment operator or CI secret store when that deployment method requires them.
* Backup destination credentials belong only to the backup job. They are not exposed to application processes.

Rotate secrets independently between environments. Redact authentication headers, URLs with tokens, documents, clinical text and connector bodies from logs. Environment variables are an initial delivery mechanism, not a claim of field level encryption or a vault service.

## 8. Release and rollback procedure

1. Run type checks, unit tests, PostgreSQL integration tests, tenant isolation tests, connector fault tests and browser acceptance tests on the candidate revision. Record versions and evidence.
2. Build immutable API/worker and connector images from the same release manifest. Build the Vercel console with the target environment's public values.
3. Use one serialised migration job with exclusive deployment coordination. Apply additive, backwards compatible migrations before deploying services. Never run schema migrations independently from every API or worker startup.
4. Deploy connector, then API and worker, then the console. During mixed version operation, both old and new binaries must understand the shared database and execution envelope versions.
5. Run a synthetic smoke test through upload, scan, extraction review, identity resolution, authorised action, connector observation and final reconciliation. Confirm that production execution remains disabled until its release gate passes.
6. If service verification fails, roll back application images and the console to the previous compatible artefacts. Do not automatically reverse destructive database migrations. Restore or manual data correction is a separate incident operation.

Use expand and contract schema changes. Remove old columns or contracts only in a later release after all running versions and pending executions have moved forward. A Vercel promotion reuses an existing artefact; do not promote a staging build into production if it embeds staging public configuration. [Vercel deployment management](https://vercel.com/docs/deployments/managing-deployments)

## 9. Recovery, retention and operational acceptance

Initial production targets are a database RPO of 15 minutes, accepted document RPO of 15 minutes and service RTO of four hours. These are design targets until measured in a restore drill. Supabase daily backups alone do not meet the database RPO; select a suitable recovery option and verify it before production use. Maintain independent encrypted backups of accepted Storage objects and an integrity manifest. Database backups contain Storage metadata but do not contain the object bytes. Custom role passwords also require a restore and rotation procedure. [Supabase backup limitations](https://supabase.com/docs/guides/platform/backups)

Run a staging restore drill before using actual patient data and after material recovery changes. Restore database, private objects, role access and application configuration; verify document digests and execution states. A database restored to an older point can forget an external success. After any restore, leave dispatch disabled and reconcile every execution whose history may have been lost before allowing a new create or repeated action. Never replay a restored outbox blindly.

Retention must be explicit per data class and organisation. The builder implements configurable retention and legal hold handling, but does not invent a clinical record destruction schedule. Synthetic test artefacts may be purged after seven days. Abandoned quarantine uploads are reaped after 48 hours. Production retention values for accepted referrals, audit events, backups and rejected documents require the organisation's actual obligations and operating policy before enabling real data.

Record and monitor API error rate, worker heartbeat, oldest ready work age, unresolved execution age, pool wait time, failed scans, connector error rate, authorisation denials and backup lag. Page the operator for an unresolved external write, a failed scan pipeline, worker heartbeat loss beyond two minutes, or backup lag beyond the configured recovery target. Health and metrics endpoints contain no patient information.

## 10. What the builder can complete without credentials

Create the repository, migrations, tenant provisioning scripts, local configurations, container definitions, environment templates, mock connector, manual path, UI and test suites. Use synthetic fixtures. Generate deployment configuration and an exact missing secrets list. Real DTM credentials and confirmed API capabilities are needed only for the live connector acceptance stage. Account access and actual region availability are needed only for platform provisioning and deployment.

Do not present an unconfigured service as deployed. Report separately: locally implemented, locally tested, staging deployed, staging accepted, production configured and production enabled.

Platform documentation was checked on 20 September 2026. The builder must pin current supported package and CLI versions and review relevant platform changes again at implementation. Supabase's current changelog includes a Node.js 20 support removal, so use a currently supported Node.js LTS and match the Vercel/Railway build runtimes. Avoid changing managed Supabase schemas. [Supabase changelog](https://supabase.com/changelog)
