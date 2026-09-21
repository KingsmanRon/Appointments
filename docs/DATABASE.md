# ACCESS v1 database

Status: final reference design for the build. `database/schema.sql` is executable PostgreSQL DDL for an empty development database. It is not a deployed Supabase migration and does not implement the application command handlers. The build must implement the transaction contracts below and pass the acceptance suite before enabling a real connector.

## 1. Decisions

1. Supabase PostgreSQL is the authoritative store. Supabase Auth establishes browser identity. Private Supabase Storage holds source documents and evidence objects. Railway hosts the trusted core API, its worker entry point and an isolated connector service. Vercel holds no database credential.
2. Application tables live in the private `access` schema. `authz` holds protected database identity configuration. Neither schema is exposed through the Supabase Data API. The browser uses Supabase Auth and explicitly authorised Storage operations only. No application reads or writes go directly from the browser to PostgreSQL.
3. Every domain table carries `org_id`. Composite keys and foreign keys preserve tenant scope. Every `access` table enables and forces RLS. No runtime identity owns tables or has `BYPASSRLS`, `CREATEROLE`, superuser or provisioning membership.
4. The pilot has one tenant and two real database LOGIN identities: one API identity and one worker identity. Each identity maps permanently to exactly one tenant in `authz.database_principals`. Additional tenants require new identities and separately selected connection pools. The connector has no database credential.
5. RLS derives the tenant from PostgreSQL `session_user` through one narrow protected lookup. A request body, JWT custom claim, `SET ROLE` or arbitrary configuration value cannot change that tenant. `access.actor_id` is trusted application context after JWT validation, never a substitute for authentication or tenant binding.
6. Runtime groups receive scoped table privileges because the core is a trusted modular monolith. RLS enforces the database tenant boundary; command handlers enforce human permissions, module ownership and business transitions. This reference does not claim that arbitrary SQL executed with a stolen tenant API credential respects the human approval rules.
7. All external writes require explicit approval of an immutable executable action. Each dispatch opportunity receives a new grant and attempt. Approval, current authority, grant consumption and durable start are checked in one short transaction. Foreign network calls happen after commit.
8. Use UTC `timestamptz`, server generated UUIDs, positive `bigint` aggregate versions and integer durations with explicit units. JSONB holds versioned canonical payloads or bounded evidence; it does not replace indexed workflow columns.

Supabase documents its [database roles](https://supabase.com/docs/guides/database/postgres/roles), [RLS behaviour](https://supabase.com/docs/guides/database/postgres/row-level-security) and [connection options](https://supabase.com/docs/guides/database/connecting-to-postgres). This design deliberately adds a tenant database identity boundary to the trusted API layer.

## 2. Bootstrap and connections

Run schema provisioning only through a separately controlled migration identity. The role needs permission to create the group roles and schemas, assign the protected function owner and grant privileges. Verify those capabilities against the target Supabase project before applying migrations. The deployment/runtime secret is never the migration connection string.

The reference creates `access_runtime`, `access_api_runtime`, `access_worker_runtime` and `access_authz_owner` as NOLOGIN roles. API and worker groups inherit `access_runtime`. The protected owner holds only the principal map and its fixed lookup function; runtime roles cannot become that owner. The function has a fixed `pg_catalog` search path, qualified relation names, no caller supplied tenant parameter and no public execute permission. Its use of `session_user` is intentional: a `SECURITY DEFINER` function changes `current_user`.

Provision the tenant, its initial administrator membership, policy, event chain head and two LOGIN identities separately. Generate strong passwords through the deployment secret workflow. Never commit a password or place it in a shell argument or SQL transcript. An illustrative provisioning sequence is:

```sql
-- Run with the controlled provisioning identity, not from a runtime service.
CREATE ROLE access_pilot_api LOGIN INHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE access_pilot_worker LOGIN INHERIT
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT access_api_runtime TO access_pilot_api;
GRANT access_worker_runtime TO access_pilot_worker;
-- Set generated passwords using the protected provisioning channel.
-- Insert a tenant and membership first, then use its real UUID below.
INSERT INTO authz.database_principals(login_role, org_id, principal_kind)
VALUES ('access_pilot_api', '<tenant UUID>', 'API'),
       ('access_pilot_worker', '<tenant UUID>', 'WORKER');
```

The example is deliberately not part of the executable reference schema: it needs real Auth users, a reviewed initial policy and generated credentials. Supabase Auth user IDs are logical identities in `memberships`; there is no cascading foreign key to `auth.users`, so deletion cannot silently destroy audit history. The build must validate an Auth identity when provisioning membership.

Use a direct PostgreSQL connection where supported, otherwise the documented session pooler with the custom LOGIN identity. Railway maintains a small bounded pool per role. Start with one connection per tenant per service and a global maximum of ten in each service, reserving capacity for migrations and operations. Replicas multiply that budget. Verify the actual project limit before increasing it. Do not multiplex tenants through a privileged login with `SET ROLE`. Transaction pooling is not enabled in v1.

At startup verify `session_user`, `authz.current_org_id()`, role flags, relation ownership and `row_security`. Reject a connection if any value differs from its configured tenant or principal. Use TLS with certificate verification. Never log connection strings.

Every public command opens a transaction, sets `access.actor_id` with `set_config(..., true)`, checks current membership and executes only parameterised SQL. The setting disappears at transaction end. An actor setting alone gives no permission and cannot alter the RLS tenant. Worker operations use their configured tenant and authenticated internal caller context; they do not invent a human identity.

`access_worker_runtime` cannot edit memberships, policy versions, integrations, mappings, capabilities or executor registration. It receives column level UPDATE permission on `tenants.authority_epoch` solely because PostgreSQL requires some UPDATE permission for `SELECT FOR UPDATE`. Command code must not treat that privilege as permission to publish authority changes.

## 3. Table dictionary

Every table below lives in `access`, uses tenant RLS, and is owned by the provisioning identity rather than a runtime group. UUID primary keys are paired with `org_id` except singleton tenant tables. Runtime roles have no DELETE or TRUNCATE grant.

| Area | Table | Meaning and invariants |
| :--- | :--- | :--- |
| Authority | `tenants` | Tenant status, current policy pointer, authority epoch and first lock for authority decisions. |
| Authority | `memberships` | Current human role and activity. Membership revocation remains durable. Roles are ADMIN, OPERATOR, REVIEWER and AUDITOR; operation permission mapping belongs to the versioned policy. |
| Authority | `session_revocations` | Append only tenant, user and Supabase session revocation records. Approval start checks this table under the authority guard. |
| Integration | `integrations` | Destination account and environment, enable flag and current immutable mapping/capability pointers. Contains no secret. |
| Integration | `capability_snapshots` | Immutable operation capability manifest and verification evidence reference. A manifest with no verified evidence cannot enable an operation. |
| Integration | `mapping_versions` | Immutable mapping definition, version and digest. A changed mapping creates a new row. |
| Integration | `executors` | Authenticated connector subject, integration binding, active status and credential version reference. |
| Intake | `raw_artifacts` | Durable upload reservation, quarantine object path, accepted object path, expected and observed checksum, size, MIME, scan evidence and retention date. Accepted content identity is immutable. |
| Intake | `documents` | A document derived from one accepted artifact and its extraction processing state. |
| Extraction | `extractions` | Immutable versioned OCR/extraction result with engine, prompt/schema versions and input/output digests. Local extraction still records `prompt_version`, using a defined `none` value if no prompt applies. |
| Extraction | `extraction_fields` | Immutable proposed field, unique field ID, artifact and OCR commitments, page/region/text offsets, excerpt, confidence and review requirement. |
| Identity | `patients` | Local patient projection and version. Canonical demographics are sensitive. |
| Identity | `patient_identifiers` | Namespaced identifier, normalisation and HMAC key version, keyed digest, optional encrypted value and verification evidence. A partial unique index prevents two local verified records claiming the same keyed identity. |
| Identity | `external_patient_refs` | Proven patient binding to a destination account and external reference. |
| Workflow | `referrals` | Aggregate state, version, workflow generation, current verification/identity decisions and completion provenance. `document_id` is the primary source; the join table lists all sources. |
| Workflow | `referral_documents` | All source documents associated with a referral. |
| Verification | `verification_sets` | Immutable human verification of a canonical payload digest and exact source version. |
| Verification | `confirmed_fields` | Accepted field values and evidence within a verification set, optionally linked to an extracted field. Manually entered values require explicit source evidence. |
| Identity | `identity_decisions` | Immutable decision to link, propose creation or require review, with verifier, destination, evidence and exact verification set. |
| Identity | `identity_claims` | Durable canonical identity reservation, owning referral, optional patient creation execution and resolution evidence. No worker lease or automatic expiry. |
| Identity | `identity_claim_aliases` | Versioned HMAC aliases pointing to the same canonical claim across key rotation. Alias lookup and reservation run under the tenant guard. |
| Identity | `referral_identity_claims` | Multiple referrals joining one durable claim and, when present, one pending patient creation execution. |
| Commands | `commands` | Immutable completed command receipt. Unique tenant, authenticated caller, route family and dedupe key; request digest and exact response are persisted with the mutation. |
| Policy | `policy_versions` | Immutable policy definition and publication evidence. Publishing changes the tenant pointer and increments its authority epoch. |
| Execution | `executions` | One immutable external side effect, exact request body bytes/length/digest, action hash, destination, snapshot versions, verification/identity decision, idempotency key and aggregate order. Only lifecycle/outcome fields can change. |
| Execution | `action_approvals` | Exact action approval, approving member, Auth session, expiry and optional irreversible revocation. |
| Execution | `action_grants` | Opaque token digest, action/executor/policy/approval/user bindings, authority epoch, expiry and irreversible consumption to one attempt. No plaintext token is stored. |
| Execution | `execution_attempts` | One authorised dispatch opportunity, unique start request and invocation owner, dispatch deadline, call deadline and immutable retry basis. At most one STARTED attempt per execution. |
| Results | `inbox_observations` | Immutable authenticated source observation and digest, independently deduplicated by destination subject and message ID. |
| Results | `observation_applications` | Exactly one application receipt per observation, including duplicate, untrusted or conflict review outcomes. |
| Work | `work_items` | Human queue projection with assignment, due date and optimistic version. Same referral as any linked execution. |
| Work | `work_item_resolutions` | Append only resolution and source evidence; corrections point to the previous resolution. |
| Manual | `manual_preparations` | Immutable human approved prepared action, exact hash, destination, verification and safety basis linked to one work item. Prior uncertainty requires conclusive no effect evidence before preparation. |
| Manual | `manual_attestations` | Immutable human completion observations bound to the prepared action, external reference, actor and source evidence. Corrections append another observation and require reconciliation. |
| Jobs | `outbox` | Transactional job intent, stable dedupe key, sequence, lane, due time and renewable notification lease. A lease is not execution permission. |
| Jobs | `timers` | Due workflow callback bound to its workflow generation, with stable dedupe key. |
| Evidence | `event_chain_heads` | One tenant sequence and last digest, locked before event append. |
| Evidence | `events` | Append only tenant sequence, envelope version, causal references, actor/subject, reasons, measurements, timestamps and chain digests. Referral is nullable for authority events. |
| Evidence | `evidence_checkpoints` | Signed tenant event head exported to an independently controlled location, including key reference and signature. |
| Measurement | `effort_sessions` | Observed, estimated or unknown human work, explicit activity and seconds. Null unknown duration is distinct from zero. |
| Measurement | `baseline_cohorts` | Time window, inclusion rules and measurement method. |
| Measurement | `baseline_observations` | Immutable baseline cases and evidence, including measured/estimated/unknown handling and completion durations. |

`authz.database_principals` is global bootstrap configuration, not a domain table. Runtime roles cannot read or change it directly. The narrow lookup function returns only the enabled mapping for the database's actual session identity.

## 4. Sensitive data and storage

Database encryption at rest and TLS are the infrastructure baseline. V1 leaves patient_identifiers.encrypted_value NULL and uses tenant specific HMAC keys for equality lookup. The verified original value remains available only through its authorised source/canonical record. This avoids introducing a second reversible identifier cache. If reversible caching is added later, the encrypted_value column must hold a versioned authenticated encryption envelope with keys managed separately; plaintext is never placed in that column. Keep HMAC keys in Railway secrets, never in these tables. Use explicit key versions and support previous lookup versions during rotation. Verify the patient identifier rather than treating a valid format as identity proof.

Canonical payloads, extraction values, exact foreign request bodies and source excerpts contain sensitive data and are accessible only through authorised core endpoints. Do not copy them into events, ordinary logs, error strings or metrics. `evidence` JSON is a bounded schema of references, reason codes and restricted commitments. The build must validate those schemas; JSONB object checks alone do not enforce this rule.

Storage is private. Reserve a unique quarantine key under the tenant prefix, then inspect the actual bytes, calculate the checksum, enforce byte/page/MIME limits and run the local malware scanner. Copy accepted bytes to a fresh immutable accepted key only after inspection. Recheck the digest of the accepted object, persist its path and scan facts, then allow referral creation. A path prefix is a namespace rule, not authorisation: Storage access always requires a fresh core permission check.

The upload endpoint creates a signed direct Storage upload intent as specified by CONTRACTS and DEPLOYMENT. Its token is restricted to the reserved quarantine object, never an existing accepted object. A signed URL holder can write only quarantine bytes and cannot mark them accepted. Do not trust client provided hashes or MIME declarations as inspection results. VERIFY_UPLOAD outbox jobs reference an artifact without requiring a referral, so scanning and copying can complete before referral creation. A failed database transaction leaves an orphan that the sweeper can remove only after proving it is unreferenced and beyond the full provider capability lifetime, with the 48 hour default in DEPLOYMENT.

No direct SQL mutation of `storage.objects` is permitted. The schema intentionally contains no Storage bucket or policy migration. The builder configures the private bucket and verifies Storage access through its supported API. Accepted object mutation, upload upsert and public buckets remain disabled.

Retention is not a legal duration guessed by the schema. Deployment supplies approved retention periods. A separate privileged retention job removes Storage content and, where required, sensitive database values through a reviewed procedure while retaining minimal audit tombstones. Ordinary runtime roles have no DELETE and immutable evidence triggers intentionally prevent casual erasure. The builder must implement and test the retention procedure before real patient documents enter the system.

## 5. Commands and authoritative locks

Use `READ COMMITTED` with explicit row locks for the pilot. Every command that changes or relies on current authority first locks its tenant row. This includes membership/session revocation, policy publication, approval revocation, connector suspension, identity reservation and execution start. An authority update increments `authority_epoch` and appends evidence in the same transaction. A stale grant epoch fails closed and requires fresh evaluation.

The fixed lock order is:

1. Tenant row.
2. Existing identity claims and aliases in stable namespace/key/digest order.
3. Referral rows sorted by ID.
4. Execution rows sorted by ID.
5. Grants and approvals sorted by ID.
6. Attempt and outbox rows sorted by ID.
7. Tenant event chain head immediately before append.

Never hold a later lock while requesting an earlier one. The pilot tenant guard intentionally serialises authority sensitive transactions, favouring auditability over maximum write throughput. Transactions must be short and contain no foreign I/O, OCR or model call.

For a public command, authenticate and check current permission before returning an existing command receipt. Look up the command by tenant, caller, route and dedupe key. An identical digest returns the stored response before checking `expected_version`; a changed digest returns an idempotency conflict. A new command locks its aggregate, checks the expected version, executes the transition, persists its complete command receipt, appends events and writes outbox rows before commit. A uniqueness conflict from a concurrent identical command rolls back the entire candidate transaction; open a fresh authorised transaction to retrieve the winner. No external call occurs before the winner is established.

The command table stores completed receipts, not independently committed pending commands. Allocate command and event IDs early, calculate the final response inside the same transaction, insert the command before inserting events that reference it, then commit everything together. Authentication failures never become successful dedupe receipts.

Hash the complete versioned tenant event envelope with its sequence and previous digest, using the documented canonical encoding. Update the tenant chain head atomically with event insertion. Sequence uniqueness is database enforced; correct digest computation and the causal semantics are builder responsibilities. Independent signed checkpoints strengthen later verification but do not make a privileged database administrator unable to rewrite history.

## 6. Identity and verification transactions

1. A verification command locks the tenant and referral, validates the source artifact versions and creates an immutable verification set and confirmed fields. Set the referral pointer and increment its version. Any changed source/value clears or supersedes the affected current verification and downstream unstarted proposals.
2. An identity command uses verified identifiers, computes all active HMAC key aliases, locks the tenant and finds the canonical claim through every active alias. It must not create a second claim merely because a key rotated. Insert missing aliases to the same canonical claim under this lock.
3. A new claim can exist before an execution. It identifies its owning referral and destination. Join later referrals through `referral_identity_claims`. After safe mapping preparation, bind its patient creation execution once and keep the reservation through uncertainty. Shared execution success updates the claim and every dependent referral through separately versioned transitions.
4. A RESOLVED claim remains reserved and points to its proven patient mapping. A RELEASED claim requires evidence that no uncertain or late committing attempt remains, or an evidenced identity correction. Keep aliases as durable identity history. Reusing a released canonical claim requires a guarded explicit reassignment with events; do not silently insert a new claim while old aliases still point elsewhere.
5. Foreign searches occur outside the transaction and return versioned observations. Under the guard, revalidate current claims, source versions and the evidence's applicability before creating a plan. An ordinary empty search does not establish definitive absence. Uncertain identity or destination uniqueness guarantees require human investigation or safe manual preparation.

The schema enforces tenant scope, destination scope and key uniqueness. The core must enforce alias completeness, identity evidence quality, approved namespace normalisation, source membership and valid state transitions. RLS cannot prove that a supplied identity value belongs to a person.

## 7. Prepare, approve and start

Prepare one action per supported external operation. Freeze the exact body bytes, their length/hash and the complete executable action envelope. The schema prevents later action, request or snapshot mutation. The core computes and verifies hashes; the database checks digest format and body length but does not pretend that a hexadecimal string is a correct digest.

An action cites the exact verification set and identity decision for its referral. A grant cites an approval for the same execution/action, the destination executor, present policy version, authority epoch and initiating member. Generate at least 256 random bits for the opaque grant token, store only its SHA256 digest and distribute the token only to the assigned live executor through the authenticated internal channel. Do not place it in logs, outbox JSON or event evidence. Revoke and issue another unconsumed grant if delivery is lost; do not recover a stored plaintext token.

`authorise_and_start` is an internal core transaction to implement, not a function shipped by `schema.sql`:

1. Verify internal caller identity and derive its tenant, integration and executor assignment. Ignore those privileges if supplied in the request body.
2. Lock rows in the fixed order. Check tenant/integration/executor activity and the database clock. Verify the grant token digest, unconsumed/unrevoked state, expiry, current policy pointer and epoch, exact executor, immutable action and intended attempt.
3. Check the initiating member and approving member are currently active with required permissions. Check approval expiry, revocation and its `approval_session_id` against tenant scoped `session_revocations`. Check current verification/identity pointers and all required field verifications. No external Auth or policy request runs inside this transaction.
4. Verify execution eligibility, predecessor completion, identity claim ownership and retry evidence. A READY first attempt is distinct from an authorised retry of an UNCERTAIN execution. A prior UNCERTAIN attempt does not alone prohibit a retry backed by retained native idempotency; a prior STARTED attempt blocks another start until recovery classifies it.
5. Insert the STARTED attempt with its unique invocation owner, `dispatch_by` and call deadline. Consume the grant to that attempt, mark the execution STARTED and append evidence atomically. The deferred consumption foreign key allows attempt creation and grant linking within the same transaction.
6. After commit, return `DISPATCH_ONCE` only to the successful first invocation. A repeated request returns STATUS_ONLY, never the original permission. The connector checks the dispatch window and sends exactly the frozen bytes once with automatic retries and redirects disabled.

A lost response after start commit leaves uncertainty. Database state is not a reusable dispatch ticket. A recovered process cannot infer permission to send from STARTED. Current revocation before this transaction prevents start; later revocation prevents future starts and cannot promise cancellation of a call already authorised. The outcome is atomic local authority and start recording, not atomicity with the destination.

## 8. Outbox, recovery and outcome application

Outbox lanes are LOCAL, WRITE and RECOVERY. Upload verification and extraction belong to LOCAL; dispatch notifications belong to WRITE; reconciliation and observation application belong to RECOVERY. A database check enforces these effect/lane combinations and their required identifiers. Write sequence eligibility checks unresolved execution predecessors, including work awaiting approval or uncertain results. Local and recovery jobs must not sit behind the write they are needed to resolve.

Claim a bounded batch using `FOR UPDATE SKIP LOCKED`, a random lease token and a database expiry. Commit that short transaction before calling a connector. An acknowledgement changes the outbox row only if its lease token still matches. A lost lease stops ownership of notification processing; it never proves that a foreign call stopped. DELIVERED means a notification was handed off, not that its execution committed.

A recovery sweep separately identifies expired dispatch windows and unresolved STARTED attempts. It classifies them as uncertain unless the original live invocation provides trustworthy evidence it could not have sent. Queue read only reconciliation in the RECOVERY lane even while the WRITE lane remains blocked. No timeout or exhausted read budget automatically frees an identity claim or permits another write.

Retain the execution ID as the destination idempotency key for every retry. Create a new attempt and current grant only after proving the destination's retained atomic idempotency contract or proving that every previous attempt cannot commit. Preserve attempt history. The single STARTED partial unique index protects active opportunities; historical UNCERTAIN attempts remain visible and may coexist with a safely authorised native idempotent retry.

Authenticate and persist result observations independently of the referral version. A repeated source ID with the same digest returns its acknowledgement; changed content is a conflict. The applier locks the current tenant/referral/execution, records the external fact, updates the execution monotonically, appends events and records `observation_applications`. A late success cannot be dropped due to a stale human command version. COMMITTED cannot regress because an older uncertain response arrives. Contradictory references create EVIDENCE_CONFLICT work without deleting either observation or automatically compensating.

Manual completion remains separate evidence. SAFE_MANUAL_COMMIT is permitted only for an action that never started or whose previous attempts are conclusively without effect. UNCERTAIN_EXECUTION is investigation, not permission for a human to repeat creation. A human attestation records its exact prepared action hash, person, observed time, external reference and evidence; the referral completion source is `human_attested` or `mixed`, never silently `automated_confirmed`.

The preview can exist in the UI before approval, but a durable manual_preparations row is created only when an authorised reviewer approves its exact version. Revisions create a new work item and preparation. Cancelling its work item under the tenant authority guard withdraws future access to that prepared action; current session, membership, expiry and work item state are checked before showing it. A later attestation is still retained as an external observation even if the work item was cancelled or approval expired. It creates investigation rather than retroactive authority.

## 9. What DDL enforces and what the build supplies

The reference supplies tenant RLS, protected session mapping, scoped foreign keys, identity uniqueness, immutable action bindings, irreversible grant consumption/revocation fields, append only evidence/version records, a single STARTED attempt and basic lifecycle constraints. It is intentionally not a substitute for the core command layer.

The builder must supply strict JSON schemas, role permission evaluation, canonical hashing, verified transport and storage encryption configuration, upload scanning and finalisation, tenant pool routing, verification invalidation, identity claim orchestration, all state transition checks, command handlers, guarded authorisation/start, first invocation response semantics, observation authentication/application, event hash computation, lease handling, timer generations, retention and migration/provisioning scripts. Do not expose generic table CRUD endpoints.

Create actual migration files with the Supabase CLI after inspecting its current help. Apply and test them in a disposable local Supabase environment, then run available database advisors. The reference DDL can be split into role/bootstrap, domain schema, constraints and privilege migrations without changing its invariants. Production Supabase compatibility, Auth integration and Storage policies require their own tests; a local PostgreSQL syntax pass cannot establish those outcomes.

## 10. Validation status

The final reference DDL loaded successfully on isolated PostgreSQL 18.1. All 42 domain tables have ENABLE and FORCE RLS. The supplied storage/security smoke suite passed 37 checks using real tenant LOGIN sessions. Detailed results and scope are in VALIDATION.md and database/validation_result.json. No remote Supabase project has been created or modified. See ACCEPTANCE for the application gates, including concurrent workflow/start tests that cannot run until the command handlers exist.
