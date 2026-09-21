# ACCESS implementation plan

The builder implements this pack. Each milestone ends with working software and recorded evidence. Continue through all milestones that can run locally; missing hosted credentials must not stop independent implementation.

## Milestone 0. Establish the workspace

1. Read all pack documents and any repository AGENTS.md instructions.
2. Inspect the actual repository, branch, working tree, existing DTM source and available tooling without altering unrelated work.
3. Create a codex/ prefixed implementation branch when supported by the repository state. Do not invent an existing Git remote.
4. Scaffold the monorepo, lock compatible dependencies, establish typecheck/lint/unit/real PostgreSQL test commands and create synthetic fixtures.
5. Record the exact runtime versions and the PostgreSQL major available in the selected Supabase project. Validate on that major as well as any local reference environment.

Done: deterministic install and CI entry points; no credentials in files; documented initial state.

## Milestone 1. Database and authentication foundation

1. Turn database/schema.sql into reviewed Supabase migrations using the installed CLI and its current help. The reference SQL is not already a migration history.
2. Implement transaction helpers, tenant connection registry and bounded pools. Every tenant pool verifies session_user against the protected mapping on connection.
3. Implement Auth JWT verification, current membership/role checks and allowed origin handling.
4. Implement the controlled tenant/bootstrap provisioning procedure with separate runtime identities. Keep privileged credentials out of application services.
5. Implement append events and commands deduplication inside transactions. Build typed database access.
6. Run tenant isolation, composite foreign key, invalid state, immutable record and unauthorised role tests on real PostgreSQL using actual runtime login identities.

Done: an authenticated user can only access their tenant; forbidden database identity substitution and role changes fail.

## Milestone 2. Upload, extraction and review

1. Build login, referral list, upload and referral detail screens.
2. Implement signed direct private upload, completion command, quarantine and worker verification.
3. Implement scanner and bounded local parser/OCR with source spans. Preserve original documents.
4. Build field confirmation, identity candidates and completeness review. Display source beside each critical value.
5. Add the work queue, assignment, explicit resolution commands and effort sessions.
6. Implement a deterministic mock extraction fixture for automated tests while retaining the real local OCR path for scanned input.

Done: synthetic PDF and image referrals reach a complete, human confirmed canonical record; unsafe files never reach normal extraction.

## Milestone 3. Workflow and durable execution

1. Implement the defined referral and execution state machines, identity claims and sequence prerequisites.
2. Implement immutable mapping/action hashing and approval review.
3. Implement local policy, grant issuing and atomic authorise_and_start under the authority guard.
4. Implement outbox, attempts, one use dispatch permission, result inbox, timers and reconciliation.
5. Implement cancellation, revocation and membership changes under the same lock order.
6. Implement uncertain outcome investigation separately from safe prepared manual completion.

Done: the mock executes the full workflow, including timeout, duplicate callback, delayed commit, crash recovery and revocation races, with the expected durable state.

## Milestone 4. DTM connector qualification

1. Inspect DTM source or documented APIs and authentication. Record the source revision and deployed endpoint separately.
2. Establish the operation mapping for patient.create, referral.create and document.attach only where supported. Unsupported capabilities remain explicitly unavailable.
3. If DTM has no referral endpoint, identify its appropriate referral/intake resource and specify the minimal API addition. Implement it only in an authorised DTM repository; never fabricate an endpoint or silently use direct SQL.
4. Implement the adapter behind the same SPI as the mock. Preserve DTM separation and never put DTM credentials in core or web.
5. Qualify destination idempotency, external references, concurrent creates, key retention and reconciliation using synthetic data in an explicitly selected test environment.
6. Produce a real external completion trace and document any remaining unsupported operation with its manual path.

Done: at least the agreed referral completion operation is demonstrated against actual DTM test infrastructure. Mock success alone cannot pass this milestone. If destination access is absent, finish the adapter and runnable contract suite, identify the exact missing access and mark only the live qualification gate blocked.

## Milestone 5. Evidence, reporting and recovery

1. Implement the minimal dashboards and distinguish observed, estimated and unknown effort.
2. Establish a baseline cohort and report definitions without fabricated savings.
3. Verify event chains, independently retained checkpoints and conflict investigation.
4. Implement protected logs, monitoring, retention jobs and reconciliation alerts.
5. Perform local crash tests and a documented staging database plus Storage restore drill.

Done: reports reproduce from recorded data, restore evidence exists and unknown outcomes remain visible until resolved.

## Milestone 6. Deployment and handover

1. Generate Dockerfiles/start commands, Railway service configuration, Vercel project configuration, environment templates and CI checks.
2. Use separate Supabase projects and Railway environments for staging and production. Preview deployments use staging/synthetic services only.
3. Apply migrations through one controlled job; never concurrently from every service startup.
4. Run the complete ACCEPTANCE matrix and browser workflow on staging after hosted credentials are supplied.
5. Report exact commit, tests, hosted URLs, migration versions and remaining release gates separately.

Done: local build complete, staging acceptance complete when access is available, and deployment state reported accurately. Production publication and live patient processing occur only when explicitly authorised for the named environment.

## Definition of build completion

The local application includes a working staff UI, real PostgreSQL integration, durable workers, mock connector failure suite, manual paths, local extraction, DTM adapter, metrics and documented operations. It is not a collection of empty routes, mocked screens or TODO comments.

The DTM and production gates remain separate from local completion. Do not stop after scaffolding or one milestone. Do not invent credentials, capability guarantees or live success to conceal a missing external dependency.
