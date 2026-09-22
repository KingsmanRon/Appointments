# ACCESS v1.1 acceptance specification

Status: required evidence for the proposed build. No row below is claimed to have passed merely because this document exists. Mark each result `NOT_RUN`, `PASS`, `FAIL` or `BLOCKED`, with a reason, immutable code revision and evidence location.

## 1. Evidence and test environment

Use synthetic patients, referrals and documents for development and automated tests. Do not copy real patient records into fixtures, public CI logs, screenshots or model prompts. Use an actual PostgreSQL instance of the intended supported major version for migrations, RLS, row locks, transaction rollback, parallel starts, claims and inbox tests. SQLite, mocked repositories and sequential unit tests cannot establish those properties.

Record the PostgreSQL version, runtime and dependency versions, exact application revision, schema migration hashes, test command, environment, start and end time, result summary and evidence digests. Freeze the mock's configured failure schedule before each scenario. Use deterministic barriers to create concurrency; do not rely only on timing sleeps. For every foreign write test, record both ACCESS rows and the mock destination's independent operation log and effect count.

Every acceptance run must distinguish local unit checks, actual PostgreSQL integration checks, local browser workflow checks, hosted synthetic checks and authorised destination checks. Passing one level does not imply the next. The implementation must output a machine readable result manifest and a concise human report containing skipped and blocked checks.

## 2. Invariants

| ID | Invariant |
| :--- | :--- |
| I01 | A tenant database login cannot read or change another tenant's rows or assume its database role. |
| I02 | Every accepted state change, event and outbound intent is atomic within PostgreSQL. |
| I03 | An execution binds one immutable destination request, payload, mapping and capability snapshot. |
| I04 | Current authority, approval, grant consumption and local start have one guarded transaction boundary. |
| I05 | One successful start response grants one call to one live executor invocation; replay never reissues that permission. |
| I06 | An unresolved external outcome cannot become a blind retry, dependent write or safe manual repeat. |
| I07 | The same logical side effect uses the same destination execution key across safe new attempts. |
| I08 | Referral sequencing and shared identity claims prevent competing local effects where the identity is established. |
| I09 | Authenticated external observations survive workflow version changes, duplication and disagreement. |
| I10 | Critical source facts and patient selection require human verification before external writes. |
| I11 | Human attestation, automated confirmation, unknown outcomes and measured effort remain distinguishable. |
| I12 | Hosted operation, actual destination capability and production authority require separate evidence. |
| I13 | A destination write is not reported as a booking; every terminal access result has a sourced case outcome. |
| I14 | Operational access rules, authority policy and destination mapping remain separately versioned and reviewable. |

## 3. API, extraction and identity acceptance

| Test ID | Invariant | Scenario | Required result and evidence |
| :--- | :--- | :--- | :--- |
| A01 | I02 | Submit identical command key and body concurrently, then retry after a lost response | One state transition and event set; all callers receive the same committed result; version increases once. |
| A02 | I02 | Reuse an idempotency key with a changed body | `409 IDEMPOTENCY_CONFLICT`; no additional mutation or effect. |
| A03 | I02 | Replay an accepted command after another valid command changes the referral version | Stored accepted result returns; the replay does not fail only because its original version is old. |
| A04 | I02 | Submit two different commands with the same expected version | One succeeds; the other receives `409 VERSION_CONFLICT`; no partial work items or events leak. |
| A05 | I01 | Forge actor, role or tenant fields while holding a valid token | Core uses verified identity and present database membership; forged fields provide no authority. |
| A06 | I10 | Upload corrupt, executable disguised as PDF, over limit, infected or incomplete input | Quarantine remains; no extraction or executable action; clear safe error and bounded processing. |
| A07 | I02 | Crash before object upload, after upload, and before or after finalisation transaction | No referral can use an absent or unverified object; orphan recovery is safe and repeatable. |
| A08 | I10 | Extract fields with missing text, low quality scan, conflicting identifiers or no calibrated confidence | Preserve unknown values and source spans; require review; do not invent defaults. |
| A09 | I10 | Edit an already verified critical field or replace its source artifact | Affected verification and unstarted approvals are invalidated; old execution bodies are preserved. |
| A10 | I10 | Provide clinical wording that appears urgent | Extract source wording and queue review; no model or rule silently performs clinical triage. |
| A11 | I08 | Two referrals concurrently resolve to the same verified tenant and destination identity | One durable creation claim and one patient creation execution; dependent referrals reuse the verified external reference. |
| A12 | I08 | Kill a claim owner after its create starts; expire its worker lease; submit a second referral | Claim remains reserved; no second create while the first outcome is unresolved. |
| A13 | I08 | Same identifier value appears under different issuers, tenants or destination accounts | Claims respect full namespace and scope; no accidental linking or leakage. |
| A14 | I08 | Rotate the tenant identity HMAC key while two referrals arrive | Old and new lookup versions resolve to one canonical claim; no unkeyed raw identifier digest or duplicate create. |
| A15 | I08 | One patient presents different unlinked identifiers; two patients have contradictory attributes | Route to review; no promise of universal automatic deduplication and no automatic merge. |
| A16 | I10 | Submit identical source bytes for two genuinely separate referrals | Reuse artifact storage if authorised, but preserve or explicitly review both clinical submissions; do not silently discard the second referral. |

## 4. Authority and exact action acceptance

Run the concurrency cases against PostgreSQL with separate sessions and an independent mock transport effect log. The reference point for ordering is the committed guarded start transaction, not grant evaluation time or the first HTTP packet.

| Test ID | Invariant | Scenario | Required result and evidence |
| :--- | :--- | :--- | :--- |
| P01 | I03 | Change body byte, method, path, query, destination account, semantic header or content type after approval | Start or final transport verification rejects; no foreign write. |
| P02 | I03 | Change mapping, capability snapshot or destination credential principal | Old action cannot silently adopt the change; prepare and approve a new action. Same principal secret rotation follows its documented rule. |
| P03 | I03 | Equivalent JSON key order, invalid duplicate keys, nonfinite numbers, unsafe integers and Unicode edge cases | Standard JCS vectors pass; invalid input is rejected; no unstable hash or silent string normalisation. |
| P04 | I04 | Grant is absent, expired, revoked, wrong tenant, wrong action, wrong executor or already spent | No `STARTED` attempt and no transport permission; reason recorded safely. |
| P05 | I04 | Human approves one execution, but a command attempts another or modifies the displayed hash | Approval does not transfer; no write. A batch approves only its enumerated hashes. |
| P06 | I04 | Commit actor, approver or executor revocation before the start transaction acquires the authority guard | Start refuses; destination effect count is zero. |
| P07 | I04 | Let start hold the guard; race a revocation; allow start to commit before revocation | Exactly the already authorised attempt may proceed; later starts are refused. Evidence reports the order without claiming revocation cancelled the first call. |
| P08 | I04 | Change policy or suspend connector while start is waiting for the guard | Start evaluates current guarded state and refuses stale authority where applicable. |
| P09 | I04 | Abort the transaction after grant mutation but before commit | Grant, start, event and assignment roll back together; no transport permission is returned. |
| P10 | I05 | Two executor requests attempt to start the same attempt concurrently | Exactly one response contains `DISPATCH_ONCE`; the other is `STATUS_ONLY`; grant consumed once. |
| P11 | I05 | Drop the successful start response after commit, then retry the exact request and nonce | Retry receives status only; no repeated permission; recovered attempt becomes uncertain pending evidence. |
| P12 | I05 | Delay the first start response beyond its dispatch window | Connector does not call destination; reports reliable non dispatch only if it is the original live invocation and can establish that fact. |
| P13 | I05 | Kill the connector before sending, during send and after destination success | Restart never resumes a foreign call from `STARTED`; uncertainty is preserved where a send cannot be ruled out. |
| P14 | I04 | Try a safe new attempt after permission was granted for an earlier attempt | Requires a new grant, eligible prior outcome or valid native deduplication, and current authority; original execution and destination key remain unchanged. |
| P15 | I03 | Destination redirects, transport library retries or a proxy requests resubmission | Redirects and write retries are disabled; the adapter cannot emit an unapproved second write. |
| P16 | I04 | Revoke an approving session locally while an action waits to start | Same tenant authority guard orders revocation and start; committed earlier revocation blocks permission even if the JWT signature is valid. |
| P17 | I04 | Operator or auditor attempts identity confirmation or external approval | Current role map refuses; reviewer/admin succeeds only on authorised tenant and exact action. |

## 5. Failure and reconciliation matrix

The mock must support each failure below at specified barriers. A unit test that asserts which method was called is insufficient; assert final database state, attempt history and independent destination effects.

| Test ID | Invariant | Injected failure or race | Required result and evidence |
| :--- | :--- | :--- | :--- |
| E01 | I02 | Crash after state update, after event append or after outbox insert but before commit | All changes roll back; no dispatcher sees a committed intent. |
| E02 | I02 | Commit intent then kill dispatcher before notification | Another worker eventually delivers the notification; no accepted work is lost. |
| E03 | I05 | Expire a notification lease while the first executor may still be active | A second notification may occur, but no second permission for the existing attempt and no blind foreign retry. |
| E04 | I06 | Destination commits, then response is lost | State becomes uncertain; reconciliation retrieves the original external reference; effect count stays one. |
| E05 | I06 | First write remains in flight; reconciliation search returns empty; first write later commits | No second create follows the empty read; original outcome is eventually recorded or investigated. |
| E06 | I06 | Destination has eventual visibility longer than configured backoff | Read retries end in investigation, never automatic absence or failure that releases a duplicate create. |
| E07 | I07 | Destination atomically enforces a retained idempotency key; response is lost | Safe new attempt uses identical immutable bytes and execution key with a new attempt and grant; destination effect count is one. |
| E08 | I07 | Reuse destination key with changed payload; retry near and after retention expiry | Changed payload is refused; retention uncertainty disables automatic retry. |
| E09 | I07 | Destination has an atomically unique operation reference, while concurrent requests arrive | One effect; duplicate response is resolved to and verified against the original operation. |
| E10 | I06 | Destination exposes only a searchable reference field without uniqueness | Capability is not treated as safe retry support; uncertain results require investigation. |
| E11 | I06 | Local cancellation succeeds but destination request can still commit | Keep uncertain; do not release identity claim or approve manual repeat. |
| E12 | I06 | Destination returns authoritative cancellation proving no effect and no later commit | Evidence is retained; a new attempt still requires fresh policy start and grant. |
| E13 | I08 | Worker for sequence 2 claims first while sequence 1 is pending | Sequence 2 cannot start until the persisted predecessor rule permits it. |
| E14 | I08 | Sequence 1 becomes uncertain while sequence 2 is ready | Sequence 2 remains blocked; advisory lock release does not override this. |
| E15 | I08 | Shared patient creation succeeds; referral creation fails permanently | Patient effect remains recorded; no automatic delete or duplicate patient create; referral enters a recoverable work item. |
| E16 | I02 | Deliver duplicate, stale and cancelled durable timers | One valid current transition at most; obsolete workflow generations have no effect. |
| E17 | I06 | Exhaust safe transport retry count or reconciliation schedule | Open the correct exception work item; persist the true outcome; no infinite loop or invented terminal success. |
| E18 | I06 | Fill a connector backlog and breach concurrency limits | Caps hold, accepted work is durable, other tenants retain their capacity allocation, and operators see pressure. |
| E19 | I06 | Manual connector receives an uncertain automated execution | Open investigation; do not present a fresh commit button or export as permission to repeat. |
| E20 | I05 | An executor loses its process memory and reports that it must not have sent | Reject unsupported non dispatch certainty; no fresh call until permitted by independent evidence. |
| E21 | I06 | An uncertain write is followed by its reconciliation and inbox application jobs | Recovery jobs remain runnable despite the write ordering barrier; later dependent writes remain blocked. |

## 6. Callback, tenant and audit acceptance

| Test ID | Invariant | Scenario | Required result and evidence |
| :--- | :--- | :--- | :--- |
| C01 | I09 | Repeat identical callback before and after application | Inbox acknowledgement is stable; outcome applied once. |
| C02 | I09 | Repeat observation ID with different content | Conflict is recorded and quarantined; no overwrite of accepted evidence. |
| C03 | I09 | Human changes referral version before a committed observation arrives | Record actual external outcome; reconcile current state; do not reject success as a stale public command. |
| C04 | I09 | Deliver delayed uncertain or failed observation after committed | Known commitment does not regress; observation history remains visible. |
| C05 | I09 | Deliver incompatible external references or success after purported no effect | Preserve evidence, block unsafe progression, open conflict investigation; no automatic compensating write. |
| C06 | I09 | Wrong connector, tenant, executor, action hash, token audience or expired service identity submits a callback | Reject before trusted inbox acceptance; no guessed tenant from request body. |
| C07 | I09 | Crash after durable inbox insert before acknowledgement or application | Sender can replay safely; application eventually completes without losing the observation. |
| T01 | I01 | Tenant A login queries, inserts, updates, deletes or references tenant B objects | All access fails or returns no rows under real tenant sessions, including guessed IDs and composite foreign keys. |
| T02 | I01 | Tenant A tries `SET ROLE` to tenant B, sets another tenant GUC, changes `search_path` or calls a privileged helper | No elevation; authoritative tenancy remains tied to verified database identity. |
| T03 | I01 | Reuse pooled connections after exceptions, rollback, cancellation and alternating tenant requests | No leaked role, tenant context, cached row or prepared query result. |
| T04 | I01 | Query through views, functions, projections, raw SQL, worker credentials and Storage routes | Defined permissions hold; no unreviewed definer or privileged Data API bypass. |
| T05 | I01 | Invoke tenant core queries using anonymous, authenticated browser or service role paths | Browser cannot reach domain tables directly; protected internal credentials remain server only; intended RLS identity is verified. |
| T06 | I01 | Run intended hosted PostgreSQL connection and pool mode with tenant login roles | `session_user`, role restrictions and RLS match the local contract; incompatible pooling blocks activation. |
| T07 | I01 | Retrieve a source artifact as another tenant or after membership revocation | Access denied; signed object capability behaviour and expiry match the documented contract; no public bucket. |
| H01 | I02 | Concurrent transactions append tenant events | Unique ordered sequence and valid previous hash; rollback leaves no broken chain. |
| H02 | I02 | Tamper with an event or remove an event in a controlled test database | Verifier detects mismatch against retained trusted head; result does not claim protection against rewriting all trust anchors. |
| H03 | I11 | Human verification, manual completion, overlapping tabs, idle session and missing time sample | Human touch remains counted; unknown and estimated effort are labelled; no unknown duration silently becomes zero. |
| H04 | I11 | Compare metrics on a known synthetic cohort containing failures and uncertain cases | Numerators, denominators and exclusions reproduce independently; terminal success, human attestation and unknown outcomes remain separate. |
| H05 | I11 | Inspect logs, events, exception traces and metric labels during synthetic identifier tests | No raw identifiers, clinical text, bearer tokens, action body or low entropy unkeyed identifier hashes leak. |

## 7. Patient-access value acceptance

| Test ID | Invariant | Scenario | Required result and evidence |
| :--- | :--- | :--- | :--- |
| V01 | I13 | Create a referral through the enabled intake channel | One `REFERRAL` case and one referral extension are linked; disabled case types/channels are rejected rather than partially processed. |
| V02 | I13 | Record inbound and internal follow-up interactions | Immutable case timeline preserves channel, intent, actor class, identity-verification level and restricted content reference. |
| V03 | I13 | Confirm every required destination write | Referral reaches `COMMITTED`; case remains active and booking conversion remains false until a separate accepted outcome arrives. |
| V04 | I13 | Record a verified appointment outcome | Append one sourced `APPOINTMENT_BOOKED` observation, transition consistently to `BOOKED`/resolved and include the case once in the booking numerator. |
| V05 | I13 | Record unreachable, declined, invalid, referred-elsewhere and unknown outcomes | Enumerated closures retain evidence; unknown remains unresolved; none is counted as booked. |
| V06 | I11 | Reproduce a cohort with booked, closed, open, cancelled and unknown cases | Denominator, every disposition, time to commitment, time to booking, staff contacts, corrections and effort categories reconcile independently. |
| V07 | I14 | Publish a changed operational rule while a case or approved action is waiting | Existing case retains its evaluated version; meaning-changing change invalidates an unstarted plan and requires review, without granting or revoking actor authority. |
| V08 | I14 | Reserve an unsupported appointment or channel capability | Capability remains disabled and returns typed refusal/manual status; namespace reservation cannot be mistaken for implementation. |
| V09 | I13 | Complete work in the PMS without an ACCESS work item | Human effort/outcome can still be recorded with source; report does not equate “no work item” with “no human effort”. |
| V10 | I11 | Calculate ROI with missing baseline cost or outcome attribution | Report marks ROI unavailable or scenario-based; it does not fabricate savings or revenue. |

## 8. Browser workflow and DTM qualification

| Test ID | Invariant | Scenario | Required result and evidence |
| :--- | :--- | :--- | :--- |
| U01 | I10 | Staff uploads a synthetic referral and reviews extracted fields | Source page and span are visible, missing values remain visible, critical confirmation is required and keyboard interaction works. |
| U02 | I03 | Staff approves a prepared external action | UI shows patient, destination, operation, material values, consequence and exact version; approval binds its action hash. |
| U03 | I11 | Staff uses manual preparation and later attests completion | UI labels human completion and evidence source; it does not label it automated policy enforcement. |
| U04 | I06 | Staff opens an unresolved timeout | UI shows uncertainty and investigation steps; it offers no unsafe repeat action. |
| U05 | I12 | Complete the entire synthetic workflow with mock capabilities | Case, referral, patient operation where supported, document operation where supported, booking/closure outcome, work items, grants, attempts, callbacks and final provenance are linked in one evidence bundle. |
| D01 | I12 | Inspect available DTM integration information | Record official or customer authorised documentation, version, authenticated test endpoint, account identity, request and response schemas, supported operations and written test scope; do not infer these from a UI name. |
| D02 | I03 | Map canonical synthetic examples to each enabled DTM operation | Required fields and final bytes match the verified contract; missing or unsupported fields produce a typed failure before start. |
| D03 | I07 | Test DTM idempotency, uniqueness, concurrency, retention and mismatch handling | Record actual evidence per capability; disable any unproven safety capability rather than borrow mock guarantees. |
| D04 | I06 | Test DTM timeout, read back and cancellation semantics in the authorised test environment | Mark exactly which results prove effect, absence or neither; document unresolved limits. |
| D05 | I12 | Execute authorised synthetic DTM workflow after D01 to D04 pass | Record execution IDs, hashes, destination references, authenticated read backs, outcome source and cleanup plan; no production patient data or production effects. |

If an authenticated DTM contract or authorised test environment is unavailable, D01 to D05 are `BLOCKED`. Complete the mock and safe manual path, label the DTM adapter unqualified, and report that the complete real integration remains outstanding. Do not invent a generic HTTP endpoint and call it a working DTM integration.

## 9. Release gates

| Gate | Required evidence | Meaning |
| :--- | :--- | :--- |
| G0 Product hold point | Named design partner or approved synthetic proxy, service line, intake channel, buyer, destination route, baseline fields and pilot outcome contract are recorded | Application implementation may proceed without implying a live pilot is approved |
| G1 Specification aligned | Contracts, schema, architecture and build prompt use the same states, table ownership and trust boundary | Technical implementation may proceed |
| G2 Local foundation | A01 to A16, P01 to P17, E01 to E21, C01 to C07, T01 to T05, H01 to H05, V01 to V10 and U01 to U05 pass on the recorded revision | Local mock and manual workflow accepted |
| G3 Hosted synthetic | G2 plus T06 to T07, managed secret configuration, upload limits, worker restart recovery, regional placement, backup restore evidence and hosted browser checks | Hosted synthetic environment accepted |
| G4 Real connector qualification | D01 to D05 pass for the enabled operation set and destination test account | Named DTM capabilities accepted in that test environment |
| G5 Production approval | Explicit user approval to activate a named production tenant, data and region approval, actual credentials, destination scope, operational owners, monitoring, tested restore, runbooks and rollback or suspension procedure | Only the approved production scope may start |

Every report must state which gates passed and which remain outstanding. Mock success cannot substitute for G4. A hosted health endpoint cannot substitute for G3. An available Supabase database, Vercel preview or Railway service cannot substitute for G5. Manual human completion is a supported assurance category and must never be presented as an automated execution guarantee.

## 10. Minimum deliverables from the builder

1. Source tree with bounded modules, shared runtime schemas, locked dependency versions and documented local setup.
2. Database migrations generated through the agreed workflow, constraints, tenant roles, RLS policies, audited grants and an isolated test database harness.
3. Mock connector with programmable failure barriers and an independent destination operation log.
4. Manual connector with separate safe preparation and uncertain execution investigation flows.
5. DTM adapter and capability evidence, or explicit blocked status with a scaffold that cannot accidentally make real writes.
6. Console workflow for upload, provenance review, identity decision, completeness, exact action approval, access-case outcome follow-up, status and exception handling.
7. Executable acceptance suites, evidence manifest, operational runbooks and a truthful readiness report.

No deployment, remote database change, production credential creation or external patient action is implied by writing this specification. The builder must follow the user's actual authorised scope when carrying out those steps.
