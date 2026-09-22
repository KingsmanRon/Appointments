# ACCESS v1.1 contracts

Status: normative implementation specification. These contracts describe the target build; they do not claim a running service, a verified DTM endpoint or production acceptance.

## 1. Scope and conventions

Use Node.js and TypeScript for the core, workers and connector runtime. Define each contract once in a shared package using runtime schemas, infer TypeScript types from those schemas, and generate OpenAPI from the same definitions. Reject unknown fields on commands and executable actions. Version incompatible changes explicitly.

V1.1 accepts authenticated API submissions and staff uploads, creates an access case, extracts text locally, records source spans, requires human verification of critical fields, resolves identity, checks completeness and prepares or performs one referral workflow. It then records whether the referral reached booking or a deliberate closure. It has a mock connector, a manual connector and one DTM adapter. Only `REFERRAL` and the selected pilot intake channel are enabled. Enable each DTM operation only after its authenticated destination contract is verified. Patient merge, automatic external chase messages, external models, autonomous scheduling and a remote Inntris binding are outside v1.1.

UUIDs are server generated identifiers. Times are RFC 3339 UTC instants. Durations are integer milliseconds unless a field explicitly says otherwise. Calendar dates use `YYYY-MM-DD` without timezone conversion. Never infer a date, identifier, urgency or clinical fact that the source does not establish. An omitted optional field means unknown; `null` means explicit absence only where the schema permits it.

No clinical record or raw identifier belongs in a URL, ordinary log, metric label, event payload or exception message. Sensitive canonical payloads and executable bodies live in encrypted, access controlled records. Audit events carry opaque references and restricted commitments. A hash of a name, identity number or small clinical value is not anonymisation.

## 2. Canonical data

### 2.1 AccessCaseV1, interaction and outcome

```ts
type AccessCaseV1 = {
  schema: "access.case.v1";
  case_id: string;
  case_type: "referral";
  source_channel: "staff_upload" | "partner_api";
  state: "open" | "in_progress" | "waiting" | "resolved" | "closed" | "cancelled";
  version: number;
  current_rule_set_id?: string;
  patient_id?: string;
  opened_at: string;
  resolved_at?: string;
  resolution_code?: string;
};

type AccessInteractionV1 = {
  schema: "access.interaction.v1";
  interaction_id: string;
  case_id: string;
  channel: "staff_upload" | "partner_api" | "internal";
  direction: "inbound" | "outbound" | "internal";
  actor_kind: "patient" | "staff" | "partner" | "system" | "unknown";
  intent: string;
  identity_verification_level: "none" | "claimed" | "matched" | "verified";
  content_ref: string;
  occurred_at: string;
};

type CaseOutcomeV1 = {
  schema: "access.case_outcome.v1";
  outcome_id: string;
  case_id: string;
  type:
    | "ready_for_booking"
    | "appointment_booked"
    | "patient_unreachable"
    | "patient_declined"
    | "provider_declined"
    | "duplicate_referral"
    | "invalid_referral"
    | "referred_elsewhere"
    | "cancelled"
    | "unknown_status";
  source: "connector" | "human" | "import" | "system";
  measurement_kind: "observed" | "derived" | "estimated" | "unknown";
  external_reference?: string;
  evidence_ref: string;
  observed_at: string;
};
```

The database reserves additional case types and channels for later versions; this API rejects them in v1.1. Interactions and outcomes are immutable observations. An `unknown_status` outcome leaves the case unresolved. Only an accepted `appointment_booked` outcome enters the booking numerator. A deliberate closure uses one enumerated resolution code and retains its source.

### 2.2 PatientV1

```ts
type PatientV1 = {
  schema: "access.patient.v1";
  local_patient_id?: string;
  identifiers: Array<{
    system: "za_national_id" | "passport" | "destination_patient_id";
    issuer: string;
    value: string;
    verification: "unverified" | "format_valid" | "human_verified";
    source_field_id: string;
  }>;
  given_names: string[];
  family_name: string;
  date_of_birth?: string;
  contacts: Array<{
    kind: "phone" | "email";
    value: string;
    source_field_id: string;
  }>;
};
```

Keep original spelling and the original extracted value in provenance. Apply documented comparison normalisation separately. The issuer identifies the identifier namespace, including passport issuing country; nationality alone is insufficient. A format or check digit result is not evidence that an identifier belongs to this patient. A destination patient identifier must also be scoped to the destination account.

### 2.3 ReferralV1 and attachment

```ts
type ReferralV1 = {
  schema: "access.referral.v1";
  case_id: string;
  referral_id: string;
  patient: PatientV1;
  source_artifact_ids: string[];
  received_at: string;
  referring_practitioner?: { name: string; practice_reference?: string };
  requested_service: { code?: string; display: string };
  destination_service_id: string;
  clinical_summary?: string;
  urgency: "routine" | "urgent" | "unknown";
  verification_set_id: string;
};

type DocumentAttachmentV1 = {
  schema: "access.document_attachment.v1";
  artifact_id: string;
  artifact_sha256: string;
  media_type: "application/pdf" | "image/png" | "image/jpeg";
  destination_patient_ref: string;
  destination_referral_ref?: string;
};
```

These are ACCESS schemas, not FHIR conformance claims. The DTM mapper must prove required destination fields and reject unsupported or lossy mappings. Required fields that are absent create a work item. A mapping may not fill a clinical field with a guessed default.

Each extracted field records `field_id`, `field_path`, raw value reference, proposed value reference, `artifact_id`, page number, bounding box where available, text offsets into the stored OCR result, extractor name and version, and confidence or an explicit unknown confidence. Record the source artifact and OCR text digests. A verifier records actor, field IDs, accepted values, verification time and the exact source version reviewed. A changed value or source invalidates affected verification.

Critical fields include identity attributes, destination patient selection, destination service, requested service, urgency and any clinical text included in an external write. All critical fields require human verification in v1 regardless of extraction confidence. Noncritical formatting checks may be automatic. Extraction completion alone never makes a referral ready to execute.

## 3. Public API

All domain API traffic terminates at the Railway core. The Vercel console calls the core directly using the authenticated user's bearer token without a privileged database credential. Browser identity comes from a verified Supabase Auth access token; current tenant membership and permissions come from the core database. V1 programmatic intake uses the same staff authentication and tenant authorisation contract. Dedicated partner service credentials are deferred. Ignore actor, role and tenant privilege claims supplied in request bodies.

Verify token signature, issuer, audience, expiry and accepted algorithm. Use a maintained verifier and the configured issuer's keys, not a key location supplied by the caller. Supabase documents its JWT verification and signing key behaviour in its [JWT guide](https://supabase.com/docs/guides/auth/jwts). Current local membership checks are required even when an identity token remains valid.

Every mutating public request requires `Idempotency-Key`, a UUID generated by the client for that logical request. Scope the key to tenant, authenticated principal and route family. Persist its normalised request digest and response in the same transaction as the mutation. The same key and digest return the stored response. The same key with a different digest returns `409 IDEMPOTENCY_CONFLICT`. Authentication and current read permission apply to replay responses too. Retain deduplication tombstones for as long as the affected execution or referral can be replayed; do not silently recycle a key after a short TTL.

| Method and route | Request | Result |
| :--- | :--- | :--- |
| `GET /v1/me/tenants` | Authenticated read | `200` with memberships visible through configured tenant pools, with no cross tenant database login |
| `POST /v1/tenants/{tenant_id}/uploads` | JSON declared media type, byte length, file SHA256 and optional source reference | `201` with `upload_id`, scoped private Storage upload capability and acceptance deadline |
| `POST /v1/tenants/{tenant_id}/uploads/{upload_id}/finalise` | JSON upload identifier and completion assertion, no file body | `202` after durable verification work is queued; does not mark bytes safe |
| `GET /v1/tenants/{tenant_id}/uploads/{upload_id}` | Authenticated read | `200` with quarantine, verification or rejection status and accepted artifact ID when available |
| `POST /v1/tenants/{tenant_id}/cases/referrals` | Finalised clean artifact IDs, enabled channel and source reference | `201` with case ID, referral ID, versions and states |
| `GET /v1/tenants/{tenant_id}/cases/{case_id}` | Authenticated read | `200` with case, referral extension, interactions, outcomes and current rule version |
| `POST /v1/tenants/{tenant_id}/cases/{case_id}/interactions` | Strict enabled interaction schema | `201` with immutable interaction receipt |
| `POST /v1/tenants/{tenant_id}/cases/{case_id}/outcomes` | Human or import observation with evidence | `202` after durable acceptance; reconciliation decides the case transition |
| `GET /v1/tenants/{tenant_id}/referrals/{id}` | Authenticated read | `200` with authorised detail and version |
| `GET /v1/tenants/{tenant_id}/work-items` | Bounded pagination and approved filters | `200` with authorised work items |
| `POST /v1/tenants/{tenant_id}/referrals/{id}/commands` | Command envelope below | `200` for a committed local transition or `202` when an effect is pending |
| `GET /v1/tenants/{tenant_id}/executions/{id}` | Authenticated read | `200` with outcome, assurance source and pending investigation status |
| `POST /v1/tenants/{tenant_id}/authority/commands` | Membership, policy, connector suspension or approval revocation command | `200` after the guarded authority transaction commits |

An upload is quarantined until local content inspection and malware scanning pass. Object creation and database commit are not one transaction: use immutable object keys, a durable upload session, checksum verification and an orphan sweeper. A failed finalisation cannot create a usable referral. The checksum detects an identical artifact; it does not prove that two submissions represent the same clinical referral. Show possible repeated submissions for staff review without silently discarding a valid new referral.

```ts
type ReferralCommandV1 = {
  schema: "access.command.v1";
  command_id: string;
  expected_version: number;
  correlation_id: string;
  type:
    | "extraction.verify"
    | "identity.resolve"
    | "completeness.resolve"
    | "execution.prepare"
    | "execution.approve"
    | "execution.cancel"
    | "manual.complete"
    | "referral.close";
  payload: Record<string, unknown>; // each type has its own strict schema
};
```

Case outcome submission uses a separate strict `AccessCaseCommandV1` with `expected_case_version`, `outcome.record` and one `CaseOutcomeV1` payload. It cannot reuse a referral `expected_version` or mutate an execution result. Connector-derived outcomes first enter their authenticated observation route and are reconciled into a case outcome.

`identity.resolve` distinguishes `link_existing` from `propose_create`; neither operation merges patient records. `execution.approve` supplies the displayed executable action hash and execution ID. `execution.cancel` can cancel an unstarted execution; after start it only requests investigation and prevents dependent new starts. `manual.complete` requires a prepared work item, exact prepared hash, observed external reference and evidence of human completion.

Success returns `{ command_id, case_id, referral_id, case_version, referral_version, case_state, referral_state, execution_ids, work_item_ids, replayed }`. Error responses return `{ code, message, correlation_id, retryable, current_version? }` without sensitive detail. A stale command returns `409 VERSION_CONFLICT`. Invalid input returns `422`; unauthenticated input `401`; unauthorised actions `403`; unavailable internal authority `503`. Return `404` for an inaccessible tenant resource to avoid exposing its existence. A transport timeout means the client must retry the same command key or retrieve its status, not invent a new operation.

Check the existing idempotent command response before comparing `expected_version`; an exact replay of a successful command must not become stale merely because its first submission advanced the version. For a genuinely new command, compare and increment the version in its state transaction.

## 4. Referral and work item states

| State | Entry condition | Permitted progress |
| :--- | :--- | :--- |
| `RECEIVED` | Clean artifact linked to an accepted referral | Queue local extraction |
| `EXTRACTING` | Extraction job committed | `REVIEW_REQUIRED` or extraction exception work item |
| `REVIEW_REQUIRED` | OCR fields and source spans stored | Human verification, identity resolution and completeness work |
| `READY` | Critical values verified, identity decision valid, required fields present | Freeze next executable action or prepare manual action |
| `AWAITING_APPROVAL` | Frozen external action awaits an authorised human | Exact hash approval or revision that supersedes unstarted action |
| `COMMIT_PENDING` | Approved execution queued or started | Definitive result, reconciliation or manual investigation |
| `RECONCILING` | An attempt may have produced an effect | Proven result or investigation; no dependent write |
| `MANUAL_PENDING` | Safe prepared action awaits human completion | Human attestation or withdrawal before completion |
| `COMMITTED` | Required destination side effects are definitively recorded | Establish booking readiness and continue outcome follow-up |
| `READY_FOR_BOOKING` | Referral data is committed and accepted for booking work | Observe booking or record a supported exception |
| `WAITING_FOR_BOOKING` | Booking outreach or destination process is in progress | Observe booking, continue follow-up or record closure |
| `BOOKED` | Accepted outcome confirms the appointment | Reconcile the case and preserve corrections as append-only observations |
| `CLOSED` | Completion acknowledged; outcome provenance retained | Read only except append correction or investigation evidence |
| `CANCELLED` | No started or uncertain effect remains; pending work withdrawn | Read only except audit evidence |

`COMMITTED` describes destination completion only. It is not terminal and does not carry the patient-access success claim. `BOOKED`, `CLOSED` and `CANCELLED` carry `completion_source = automated_confirmed | human_attested | mixed` plus the applicable immutable case outcome. A human attestation is not evidence of automated enforcement. Partial completion remains visible; do not silently delete or compensate a created patient after a referral write fails.

Work items use `OPEN`, `ASSIGNED`, `RESOLVED`, `CANCELLED`. Queue kinds are `source_verification`, `identity_review`, `missing_information`, `safe_manual_commit`, `uncertain_execution`, `execution_failure`, `evidence_conflict`, `approval`, `outcome_follow_up` and `status_review`. `safe_manual_commit` contains an action that has never started, or whose previous attempts are conclusively without effect. An uncertain execution can never be converted into permission to repeat the operation merely by changing its queue.

### 4.1 Operational access rules

An `AccessRuleSetV1` is an immutable, tenant-owned version containing strict schemas for required fields, destination routing, booking-readiness checks, follow-up timers and permitted closure reasons. Draft, published and retired versions are distinct records or immutable states. A case records the exact published rule set used for readiness and execution preparation. The evaluator returns the rule ID, outcome, reason codes and missing facts; it never invents a default clinical value.

Operational rules do not grant read or write authority. `policy_versions` govern who may act; `access_rule_sets` govern what the provider's access workflow requires; `mapping_versions` govern how an approved canonical action becomes destination bytes. A change in any layer that changes action meaning invalidates an unstarted plan and requires a new exact-action approval.

## 5. Identity coordination

Use a durable claim per tenant, destination account and reliable normalised identifier namespace. The lookup key is a versioned HMAC using a tenant specific key, over a domain separator plus identifier system, issuer and normalised value. Never index an unkeyed hash of a national identity number. Keep raw identifiers encrypted and restrict access. During key rotation, search old and new key versions and coordinate on the same identity claim before creating an additional claim.

Search the local index and the authenticated destination; acquire the relevant claims in stable order; search again before planning creation. Two referrals must share a pending patient creation execution when they resolve to the same verified identity. Keep its claim reserved through `STARTED`, `UNCERTAIN` and unresolved investigation, including worker lease expiry. Release or bind it only on a proven outcome or an explicitly evidenced identity correction.

Do not claim universal duplicate prevention. Different unknown identifiers, missing identifiers and changes made by other PMS users can evade local coordination. Contradictory identifiers or uncertain matches require review. Automatic creation requires verified identity evidence and a destination contract whose uniqueness, conditional create or authoritative absence semantics are sufficient for that operation. An ordinary empty search result is not such a contract.

## 6. Immutable executable action

Create one execution for each external side effect, including `patient.create`, `referral.create` and `document.attach` where supported. A composite destination operation is allowed only if its authenticated contract proves that the whole operation is atomic and has one outcome; otherwise model separate executions. Prepare a dependent action only after the external references it requires are known. A change to destination, mapping or payload creates a new action and approval; it never rewrites a started execution.

```ts
type ExecutableActionV1 = {
  schema: "access.executable_action.v1";
  tenant_id: string;
  case_id: string;
  referral_id: string;
  execution_id: string;
  aggregate_sequence: number;
  operation: "patient.create" | "referral.create" | "document.attach";
  destination: {
    connector_id: string;
    destination_account_id: string;
    environment: "mock" | "test" | "production";
    origin: string;
    credential_principal_id: string;
  };
  request: {
    method: "POST" | "PUT" | "PATCH";
    path_and_query: string;
    semantic_headers: Record<string, string>;
    content_type: string;
    body_sha256: string;
    body_length_bytes: number;
    body_ref: string;
  };
  canonical_payload_sha256: string;
  mapping_snapshot_sha256: string;
  capability_snapshot_sha256: string;
  identity_decision_id: string;
  verification_set_id: string;
};
```

Freeze the actual UTF 8 request body bytes before approval. Use JCS bytes for a JSON request body. For an upload or multipart request, freeze the complete serialised bytes, including its boundary, and hash those bytes. Paths, query ordering, destination origin, account, semantic headers and content type are immutable. Include the destination's idempotency or operation reference header in semantic headers. A mapper cannot reconstruct different bytes at dispatch time. The transport verifies the stored length and hash immediately before sending.

Set `action_hash = SHA256(UTF8("access.executable_action.v1\n") || JCS(action))`. JCS follows [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785). Reject duplicate JSON member names, nonfinite numbers, unsafe integers, lone surrogate code points and unspecified schema values. Represent identifiers and precision sensitive values as strings. Do not normalise Unicode during hashing; perform any explicit domain normalisation before the action is frozen.

Exclude credentials, bearer tokens, cookies, trace IDs and volatile transport metadata from the hash. Bind the stable credential principal, destination account and approved credential version family instead. Authentication may be added only by the transport from the bound credential reference. Block any extra header that can change routing, tenant selection, semantics or idempotency. Disable redirects and automatic HTTP retries. A rotated secret is allowed only when it authenticates the same approved principal and account; an account change requires a new action.

This is the ACCESS action format. It does not modify or claim compatibility with any deployed Inntris action hash or token format.

## 7. Connector contract

The connector has no database credential. The initial deployment handles one tenant; when credentials for several tenants share a process, that process is trusted for those configured tenants. Core authenticates every connector principal and checks its current tenant, connector, environment and operation assignment. Network location alone is not authentication. Do not expose internal routes to browsers or accept their identity from unsigned headers.

| Route | Meaning |
| :--- | :--- |
| `GET /v1/capabilities` | Versioned declaration, checked against verified evidence before activation |
| `POST /v1/prepare` | Pure mapping and validation; returns frozen body candidate and capability snapshot, performs no foreign write |
| `POST /v1/execute` | Notification that an execution is available; connector must request core start permission before the single foreign call |
| `POST /v1/reconcile` | Read only retrieval of operation outcome, never implicit reexecution |
| `GET /v1/health` | Local health and credential readiness, without leaking secrets or creating records |

Preparation may run as a local core mapping module when it needs no connector dependency. A manual connector returns a prepared work item; it does not report a foreign write as committed.

The execute notification contains references, not a large encoded document body. An assigned connector obtains immutable bytes through `GET /internal/v1/executions/{execution_id}/request-body` before requesting start. This authenticated read checks the connector assignment and streams only that execution's stored body with content length and digest. Resolve `body_ref` through this fixed core endpoint; never dereference a caller supplied URL. Large bodies therefore bypass the 1 MiB JSON command limit without passing through Vercel. Do not spend the five second dispatch window downloading the action.

Capabilities are recorded per operation, destination environment and account. The reserved namespace is `patient.read`, `patient.create`, `referral.read`, `referral.create`, `referral.status.read`, `document.attach`, `appointment.availability.read`, `appointment.create`, `appointment.status.read`, `appointment.cancel` and `appointment.reschedule`. V1.1 may enable only qualified patient/referral/document writes and the minimum read-only status operation required by the pilot. A reserved name is not an implemented capability.

Required fields include adapter version, supported operations, request and response schema versions, required canonical fields, destination authentication scheme, native idempotency mode, key scope, retention duration, concurrent request semantics, payload mismatch behaviour, read back consistency, operation status endpoint semantics, proven cancellation semantics, timeout budget, and evidence reference. Unsupported operations return a typed `UNSUPPORTED_OPERATION` and become a visible manual work item before any attempt starts. Runtime uncertainty never silently degrades into a fresh manual create.

V1 defaults are a 5 s connection deadline, 30 s total foreign call deadline, and 60 s outbox notification lease. A verified operation contract may override these in its immutable capability snapshot. A deadline is a local observation limit, not destination cancellation. Reconciliation uses up to six read only attempts at delays of 5 s, 15 s, 60 s, 300 s, 900 s and 3600 s, with bounded jitter; after that keep the outcome uncertain and assign a work item. No count of unsuccessful reads turns uncertainty into absence.

## 8. Local policy and execution start

All reads require authorisation, including access to sensitive source material. Every external write in v1 requires an explicit human approval bound to the exact executable action and a fresh local grant. The policy decision includes actor, tenant, executor, operation, destination, environment, executable action hash, current policy version, required approver permissions and expiry. A grant is an opaque random token with only its digest stored, plus these bindings. It is never a bearer permission to call a PMS directly.

Approval records identify the human, verified Auth session ID, approved action hash, approval time and expiry. The initiating human may approve in v1 if their current permission allows it; duties are not implicitly separated. The policy can require a distinct approver. Both the original actor's and approving human's current membership and scope must pass at start. Check the approving session against the tenant scoped local session revocation records. A revoked approval session invalidates its outstanding approvals; ordinary access token expiry alone does not invalidate an otherwise current persisted approval. Service initiated operations require a current human approval too.

Use the tenant row as the authority guard. All membership changes, local session revocations, policy changes, approval revocations, executor disabling, connector suspension and execution starts acquire that guard first. Fixed lock order is tenant, identity claims sorted by stable key, referral, execution, grant, then attempt and dispatch rows. Rows within each class are sorted by ID. No network call is allowed inside the transaction.

The connector requests `POST /internal/v1/executions/{execution_id}/start` using its authenticated executor identity, assigned attempt ID, immutable action hash, grant token and unique live invocation nonce. The core starts one transaction and:

1. Locks the authority guard and required rows in the fixed order.
2. Verifies tenant, actor, approver and executor are active; checks present permissions, policy version, approval, grant bindings, destination readiness and expiry against the database clock.
3. Verifies the execution is eligible, identity claims remain valid, no earlier unresolved sequence blocks it, the exact body and snapshots match, and the proposed attempt has no previous start.
4. Consumes the unspent grant, creates the `STARTED` attempt, records the execution start, immutable executor assignment and audit event, and commits.
5. Returns permission to perform one call only to this invocation. The connector sends the previously frozen bytes outside the transaction, with transport retries disabled.

The successful first response is `{ start_decision: "DISPATCH_ONCE", attempt_id, execution_id, action_hash, executor_invocation_nonce, started_at, dispatch_by, remaining_dispatch_ms }`. Use a 5 s dispatch window from the committed start by default. The connector uses the smaller of the returned remaining budget and its local monotonic elapsed budget. If the window has elapsed, do not send; report that the call was not made. A late response, lost response or recovered connector process does not acquire permission from stored state.

Every subsequent start request for that attempt returns `{ start_decision: "STATUS_ONLY", attempt_id, execution_id, state }`, even with the same nonce. It never reissues dispatch permission or a grant. Do not apply the public API response replay rule to this internal endpoint. If a start response is lost, the attempt may be started and must be treated as uncertain until evidence establishes the outcome. A database commit followed by response loss is an expected case, not a reason to consume the grant again.

The local transaction is the authority decision point. A revocation committed before start prevents permission. A revocation committed after start prevents future starts but cannot guarantee cancellation of the call already authorised. This guarantees atomic local authorisation and start recording; it does not create an atomic transaction with the PMS. The connector transport is trusted to honour the single call rule, and production acceptance must test it. Do not describe this as exactly once external execution.

## 9. Attempts, outcomes, retries and sequencing

An execution is one immutable logical side effect. An attempt is one authorised opportunity to invoke its transport. A lease is permission to process a notification, never permission to repeat the foreign call. The destination idempotency key is always the execution ID, not the attempt ID. A safe retry creates a new attempt and fresh bound grant after the current authority checks; an earlier grant is never reused.

| Observed situation | Result | Retry rule |
| :--- | :--- | :--- |
| Definitive success with verified target and payload | `COMMITTED` | No further attempt; replay stored outcome |
| Definitive rejection that guarantees no effect | `REJECTED` | Correct input with a new execution, or policy authorised retry if immutable input remains valid |
| Started call, timeout, crash, disconnected stream or lost success | `UNCERTAIN` | Reconcile first; no ordinary automatic retry |
| Destination atomically enforces retained execution key and payload equality | `UNCERTAIN` until resolved | Same immutable execution may receive at most two safe additional attempts, each with fresh grant |
| Destination atomically enforces a reliable unique operation key | `UNCERTAIN` until resolved | Same rule, with duplicate result linked and verified |
| Authoritative evidence says every prior attempt did not commit and cannot later commit | Proven no effect | Fresh authorised attempt may proceed |
| Empty eventually consistent search, elapsed timeout or exhausted read attempts | `UNCERTAIN` | Investigation only |
| Cancellation acknowledged only by local worker | `UNCERTAIN` if started | Investigation only |

Before using native deduplication, verify the key remains within its proven retention window for the entire planned retry and that the destination's same key check is atomic with the effect. A reference field that is merely searchable does not qualify. Definitive absence requires evidence covering all previous attempts and excluding a later commit; an arbitrary waiting period cannot establish it. Keep each response, attempt and conflict observation as evidence.

External writes carry a monotonically increasing sequence for the enabled referral within its access case. Start only the lowest unresolved eligible write sequence. An advisory lock can reduce contention, but the persisted predecessor condition determines eligibility. A predecessor that is uncertain, awaiting approval or under investigation blocks dependent writes. Read only reconciliation, result application, scanning, extraction and booking-status jobs do not wait behind this write barrier; otherwise an uncertain write would block the job needed to resolve itself. Outbox notification sequence and execution write sequence are separate concepts. A failed or cancelled predecessor can release progression only through an explicit workflow transition that proves the later operation remains valid. Shared patient creation claims coordinate dependent cases in addition to case sequencing.

## 10. Authenticated observations and callback inbox

Connector result delivery uses `POST /internal/v1/execution-observations`, not the public command endpoint. Authenticate a dedicated connector principal bound to the tenant, connector, destination and permitted execution. If using a signed service token, require the internal audience, issuer, short expiry and an allowlisted signing key. Require transport TLS. Do not accept unsigned destination webhooks as proof of an execution outcome.

```ts
type ExecutionObservationV1 = {
  schema: "access.execution_observation.v1";
  observation_id: string;
  execution_id: string;
  attempt_id: string;
  action_hash: string;
  kind: "committed" | "rejected_no_effect" | "uncertain" | "not_dispatched";
  external_ref?: string;
  request_sha256: string;
  response_sha256?: string;
  evidence_ref?: string;
  connector_version: string;
  observed_at: string;
  reason_code: string;
};
```

The core derives tenant and connector identity from authenticated assignment and checks body identifiers against it. Persist the observation and its digest in a durable inbox before acknowledgement. A repeated observation ID and digest returns the prior acknowledgement. The same ID with changed content returns `409 OBSERVATION_CONFLICT` and records an alert. Inbox acceptance returns `202` with a receipt ID; application may occur asynchronously. An authenticated observation is evidence from a trusted executor, not proof that the destination is honest.

No referral `expected_version` is accepted or required. The outcome applier locks the current aggregate and records external observations against their execution without discarding success because a person changed the referral meanwhile. `COMMITTED` cannot regress because a delayed uncertain or failed observation arrives. Two incompatible external references or a committed observation after an earlier claimed no effect produce an evidence conflict work item while preserving all observations and the strongest known side effect evidence. They never trigger automatic compensation or a fresh create.

`not_dispatched` is acceptable as proof only from the original live executor that retained exclusive permission, before it released control and with no possible send. A recovered process cannot assert it merely because its memory or local log is empty. The capability and test evidence must establish the original transport's behaviour.

## 11. Local jobs, timers, events and measurements

Local OCR and scanning run as bounded jobs scheduled through the transactional outbox. Their result commands have durable deduplication and source version checks. The workflow module is the only writer of referral state. API and worker entrypoints may both invoke that same command handler and repository layer through their tenant database roles; a worker must never invent a second state transition implementation. Connectors use the authenticated internal HTTP endpoints. No worker sends a notification, uploads a document or performs another external effect directly from a database transaction.

Timers contain an ID, tenant, case, purpose, workflow generation, due time and bounded callback payload. At delivery, the workflow checks that purpose and generation remain current. A duplicate or obsolete timer has no effect. Database time determines expiry and due status; monotonic process time measures durations. Workers use bounded batches, per tenant and connector caps, finite backlog limits and explicit work item escalation. Backpressure does not drop accepted work.

State mutation, event append and outbox intent commit together. Event envelopes contain ID, tenant sequence, previous hash, event hash, correlation, causation, actor reference, subject reference, occurred time, recorded time, reason code and a versioned measurement object. Serialise tenant event appends through a locked chain head. Events contain no editable projection fields. Late or corrected measurements are new linked events.

Measurements distinguish unknown from zero. Record human touch count, verified active interaction milliseconds where measured, processing duration, waiting duration, outcome source and cohort definition. Client reported duration is labelled estimated and checked for overlap, clock anomalies and idle time. A manual completion counts as human work even if nobody opened another work item. V1 critical verification means claims of zero human touch automation are inappropriate.

Define referral-to-booking conversion as accepted `appointment_booked` outcomes divided by all eligible referral cases in the published cohort. Report open, deliberately closed, cancelled and unknown cases separately rather than removing them from the denominator without explanation. Also define time to destination commitment, time to booking, exception rate, corrections, contacts, status enquiries and human touch rate using published windows and exclusions. Do not infer ROI without a measured baseline and attributable costs. The hash chain detects some changes relative to a trusted retained head; it is not an independently trustworthy proof against an administrator who can rewrite both history and its head.

## 12. Manual completion evidence

Before showing a prepared action, check current user membership and permissions. Record the exact prepared action version, destination, evidence attachments and safe completion instructions. The human completes the action in the destination, then attests with an external reference, completion time and evidence. Where possible, perform an authenticated read back to corroborate it and record that additional assurance separately.

A manual attestation cannot retroactively prove that the original policy gate controlled a human's external UI activity. Report `human_attested`, approver identity and evidence source explicitly. An uncertain automated attempt must be investigated before presenting any manual repeat action. Evidence that a human saw no result in a screen is not automatically definitive absence.

Persist approved manual plans in manual_preparations and resulting observations in manual_attestations. The preparation contains the exact action hash, destination, source verification, approving session, expiry and evidenced safety basis. Revisions use a new preparation/work item; cancellation changes work item state under the authority guard. Showing a plan requires current permission and valid uncancelled approval. Recording a later external fact remains possible even when approval has expired, but must not imply the late action was authorised.

## 13. Deferred Inntris binding

Keep an internal `PolicyDecisionPoint` interface with local evaluation and exact action binding. Do not replace the guarded local start transaction with a remote grant check followed by a separate local start. A future Inntris binding requires a separately accepted contract defining current authority checks, revocation ordering, durable grant consumption, start recording and recovery across the boundary. No v1 document or test may claim that the remote binding is implemented or conforms to an existing Inntris release.

## 14. Permissions and defaults

Roles are explicit current database memberships. ADMIN manages membership, policy and integrations and can review/approve. REVIEWER can verify critical fields, resolve identity and approve external actions. OPERATOR can upload, amend drafts, assign work and submit proposed resolutions, but cannot approve external writes or confirm identity. AUDITOR has restricted read access to timelines and reports; document/body access requires an explicit separate permission and is not implied by the role. Do not give staff direct SQL access.

Initial approvals expire after 30 minutes; grants expire after 60 seconds and may never outlive approval. Issuing a fresh grant requires current unchanged approval, current policy and fresh permission checks. Expired or revoked approvals require another human approval. Policy updates invalidate previously issued grants; a new approval is required if policy demands it or the action changes. Unknown or unavailable authority fails closed.

V1 limits new safe transport dispatches to three total attempts for an execution. The six reconciliation reads in section 7 do not count as transport dispatches. Limits may be lowered by a verified connector manifest, never raised automatically in response to failures. Increasing limits requires a versioned policy change and current approval.

Use an approval session from a valid Supabase JWT with the required assurance level. A local session revocation command is scoped to each tenant authority guard. Sign out requests revoke the user's session in each configured tenant membership before completing the UI flow. ACCESS cannot promise immediate revocation of a Supabase session changed outside ACCESS; the configured ten minute access token lifetime bounds ordinary cached JWT exposure, while ACCESS membership suspension stops new domain work immediately at the next guarded check.
